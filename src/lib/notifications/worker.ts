import "server-only";

import { config } from "@/lib/config";
import {
  claimNotificationEnqueueJobs,
  finishNotificationEnqueueJob,
} from "@/lib/notifications/enqueue-jobs";
import { configuredEmailProvider, configuredTextProvider } from "@/lib/notifications/provider";
import {
  enqueueOrderFulfilmentNotifications,
  renderOutboxEmail,
  renderOutboxNotification,
} from "@/lib/notifications/service";
import { claimNotifications, finishNotification } from "@/lib/notifications/store";
import { notificationChannels } from "@/lib/notifications/types";
import type { NotificationChannel, NotificationOutboxItem } from "@/types/site";

const terminalRenderCodes = new Set([
  "NOTIFICATION_ORDER_REQUIRED", "NOTIFICATION_ORDER_INCOMPLETE", "NOTIFICATION_NO_VALID_TICKETS",
  "NOTIFICATION_ORDER_NOT_FULFILLED",
]);

function safeRenderCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return terminalRenderCodes.has(message) ? message : "NOTIFICATION_RENDER_FAILED";
}

function safeEnqueueCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z0-9_]{3,120}$/.test(message) ? message : "NOTIFICATION_ENQUEUE_FAILED";
}

async function deliver(item: NotificationOutboxItem, dryRun: boolean) {
  const message = item.channel === "email"
    ? { channel: "email" as const, ...await renderOutboxEmail(item) }
    : await renderOutboxNotification(item);
  if (dryRun || config.appMode !== "live") return { status: "dry_run" as const, providerMessageId: `dry_${item.id}` };
  if (message.channel === "in_app") return { status: "delivered" as const, providerMessageId: `in_app_${item.id}` };
  if (message.channel === "email") return configuredEmailProvider().send({
    from: config.emailFrom, replyTo: config.emailReplyTo, to: item.recipientAddress,
    message, idempotencyKey: item.idempotencyKey,
  });
  return configuredTextProvider(message.channel).send({
    channel: message.channel, to: item.recipientAddress, message, idempotencyKey: item.idempotencyKey,
  });
}

async function claimFairNotificationBatch(
  workerId: string,
  batchSize: number,
  channels: NotificationChannel[],
) {
  if (channels.length === 1) return claimNotifications(workerId, batchSize, 60, channels[0]);

  const items: NotificationOutboxItem[] = [];
  const initialShare = Math.max(1, Math.floor(batchSize / channels.length));
  const rotation = Math.floor(Date.now() / 60_000) % channels.length;
  const orderedChannels = [...channels.slice(rotation), ...channels.slice(0, rotation)];

  for (const channel of orderedChannels) {
    const remaining = batchSize - items.length;
    if (remaining <= 0) break;
    items.push(...await claimNotifications(workerId, Math.min(initialShare, remaining), 60, channel));
  }

  if (items.length < batchSize) {
    for (const channel of orderedChannels) {
      const remaining = batchSize - items.length;
      if (remaining <= 0) break;
      items.push(...await claimNotifications(workerId, remaining, 60, channel));
    }
  }

  return items;
}

async function processNotificationEnqueueJobs(
  workerId: string,
  batchSize: number,
) {
  const enqueueWorkerId = `${workerId}_enqueue`;
  const jobs = await claimNotificationEnqueueJobs(enqueueWorkerId, batchSize);
  const results: Array<{ id: string; status: "completed" | "retry" | "manual_review"; code?: string }> = [];
  for (const job of jobs) {
    try {
      await enqueueOrderFulfilmentNotifications(job.orderId);
      await finishNotificationEnqueueJob(job, enqueueWorkerId, "completed");
      results.push({ id: job.id, status: "completed" });
    } catch (error) {
      const code = safeEnqueueCode(error);
      const terminal = job.attemptCount >= 5;
      await finishNotificationEnqueueJob(
        job,
        enqueueWorkerId,
        terminal ? "manual_review" : "retry",
        code,
      );
      results.push({ id: job.id, status: terminal ? "manual_review" : "retry", code });
    }
  }
  return {
    claimed: jobs.length,
    processed: results.length,
    failed: results.filter((item) => item.status !== "completed").length,
    results,
  };
}

async function processOutboxItem(
  item: NotificationOutboxItem,
  workerId: string,
  dryRun: boolean,
) {
  try {
    const result = await deliver(item, dryRun);
    await finishNotification(item, workerId, result);
    return { id: item.id, status: result.status, code: "safeErrorCode" in result ? result.safeErrorCode : undefined };
  } catch (error) {
    const code = safeRenderCode(error);
    const terminal = terminalRenderCodes.has(code);
    await finishNotification(item, workerId, { status: terminal ? "permanent_failure" : "temporary_failure", safeErrorCode: code });
    return { id: item.id, status: terminal ? "permanent_failure" : "temporary_failure", code };
  }
}

export async function processNotificationBatch(options: {
  batchSize?: number;
  dryRun?: boolean;
  workerId?: string;
  channel?: NotificationChannel | "all";
  maxBatches?: number;
} = {}) {
  const workerId = options.workerId || `worker_${crypto.randomUUID()}`;
  const batchSize = Math.max(1, Math.min(options.batchSize || 10, 25));
  const maxBatches = Math.max(1, Math.min(options.maxBatches || 1, 4));
  const channels: NotificationChannel[] = options.channel === "all" ? [...notificationChannels] : [options.channel || "email"];
  const enqueueJobs = await processNotificationEnqueueJobs(workerId, batchSize);
  const results: Array<{ id: string; status: string; code?: string }> = [];
  let claimed = 0;
  const deadline = Date.now() + 45_000;

  for (let batch = 0; batch < maxBatches && Date.now() < deadline; batch += 1) {
    const items = await claimFairNotificationBatch(`${workerId}_${batch}`, batchSize, channels);
    claimed += items.length;
    for (let from = 0; from < items.length && Date.now() < deadline; from += 5) {
      const group = items.slice(from, from + 5);
      results.push(...await Promise.all(group.map((item) => processOutboxItem(
        item,
        `${workerId}_${batch}`,
        Boolean(options.dryRun),
      ))));
    }
    if (items.length < batchSize) break;
  }

  return { enqueueJobs, claimed, processed: results.length, results };
}
