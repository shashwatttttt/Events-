import "server-only";

import { config } from "@/lib/config";
import {
  markStripeWebhookInboxResult,
} from "@/lib/operations";
import { retrieveVerifiedStripeEvent } from "@/lib/payments/stripe-events";
import {
  classifyStripeWebhookProcessingFailure,
  processVerifiedStripeEvent,
} from "@/lib/payments/webhook-processor";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type ClaimedStripeWebhookReplay = {
  id: string;
  stripeEventId: string;
  attemptCount: number;
};

export type StripeWebhookReplayHealth = {
  actionsRequiringReview: number;
  staleRequestedActions: number;
  overdueRetryActions: number;
  expiredProcessingActions: number;
  stalledActions: number;
};

function rpcUnavailable(error: unknown, functionName: string) {
  const candidate = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {};
  return String(candidate.code || "") === "PGRST202"
    || String(candidate.message || "").includes(functionName);
}

function safeCount(value: unknown) {
  const count = Number(value || 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("WEBHOOK_REPLAY_HEALTH_INVALID");
  return count;
}

export async function requestStripeWebhookReplay(stripeEventId: string) {
  if (config.dataProvider !== "supabase") return false;
  const { error } = await createSupabaseAdminClient().rpc("skie_request_stripe_webhook_replay", {
    p_stripe_event_id: stripeEventId,
  });
  if (error) {
    if (rpcUnavailable(error, "skie_request_stripe_webhook_replay")) return false;
    throw new Error("WEBHOOK_REPLAY_QUEUE_UNAVAILABLE");
  }
  return true;
}

async function queueTemporaryStripeWebhookReplays() {
  if (config.dataProvider !== "supabase") return { available: false, queued: 0 };
  const { data, error } = await createSupabaseAdminClient().rpc("skie_queue_temporary_stripe_webhook_replays");
  if (error) {
    if (rpcUnavailable(error, "skie_queue_temporary_stripe_webhook_replays")) {
      return { available: false, queued: 0 };
    }
    throw new Error("WEBHOOK_REPLAY_QUEUE_UNAVAILABLE");
  }
  return { available: true, queued: Number(data || 0) };
}

async function claimStripeWebhookReplays(
  workerId: string,
  batchSize: number,
): Promise<ClaimedStripeWebhookReplay[]> {
  const { data, error } = await createSupabaseAdminClient().rpc("skie_claim_stripe_webhook_replays", {
    p_worker_id: workerId,
    p_batch_size: Math.max(1, Math.min(batchSize, 25)),
    p_lease_seconds: 60,
  });
  if (error) {
    if (rpcUnavailable(error, "skie_claim_stripe_webhook_replays")) return [];
    throw new Error("WEBHOOK_REPLAY_CLAIM_FAILED");
  }
  return (data || []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    stripeEventId: String(row.stripe_event_id),
    attemptCount: Number(row.attempt_count || 0),
  }));
}

async function finishStripeWebhookReplay(
  replay: ClaimedStripeWebhookReplay,
  workerId: string,
  result: "completed" | "retry" | "manual_review",
  safeErrorCode?: string,
) {
  const retryDelaySeconds = Math.min(3600, 30 * (2 ** Math.max(0, replay.attemptCount - 1)));
  const { error } = await createSupabaseAdminClient().rpc("skie_finish_stripe_webhook_replay", {
    p_replay_id: replay.id,
    p_worker_id: workerId,
    p_result: result,
    p_safe_error_code: safeErrorCode?.slice(0, 120) || null,
    p_retry_delay_seconds: retryDelaySeconds,
  });
  if (error) throw new Error("WEBHOOK_REPLAY_RESULT_FAILED");
}

export async function readStripeWebhookReplayHealth(): Promise<StripeWebhookReplayHealth> {
  if (config.dataProvider !== "supabase") {
    return { actionsRequiringReview: 0, staleRequestedActions: 0, overdueRetryActions: 0, expiredProcessingActions: 0, stalledActions: 0 };
  }
  const { data, error } = await createSupabaseAdminClient().rpc("skie_stripe_webhook_replay_health");
  if (error) throw new Error("WEBHOOK_REPLAY_HEALTH_UNAVAILABLE");
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw new Error("WEBHOOK_REPLAY_HEALTH_UNAVAILABLE");
  const staleRequestedActions = safeCount(row.stale_requested_actions);
  const overdueRetryActions = safeCount(row.overdue_retry_actions);
  const expiredProcessingActions = safeCount(row.expired_processing_actions);
  return {
    actionsRequiringReview: safeCount(row.actions_requiring_review),
    staleRequestedActions,
    overdueRetryActions,
    expiredProcessingActions,
    stalledActions: staleRequestedActions + overdueRetryActions + expiredProcessingActions,
  };
}

export async function processStripeWebhookReplayBatch(options: {
  batchSize?: number;
  workerId?: string;
} = {}) {
  if (config.dataProvider !== "supabase") {
    return { available: false, queued: 0, claimed: 0, processed: 0, failed: 0, results: [] };
  }
  const queued = await queueTemporaryStripeWebhookReplays();
  if (!queued.available) {
    return { available: false, queued: 0, claimed: 0, processed: 0, failed: 0, results: [] };
  }
  const workerId = options.workerId || `webhook_replay_${crypto.randomUUID()}`;
  const replays = await claimStripeWebhookReplays(workerId, options.batchSize || 10);
  const results: Array<{ id: string; status: "completed" | "retry" | "manual_review"; code?: string }> = [];

  for (const replay of replays) {
    try {
      const event = await retrieveVerifiedStripeEvent(replay.stripeEventId);
      if (!event) throw new Error("WEBHOOK_REPLAY_EVENT_UNAVAILABLE");
      await processVerifiedStripeEvent(event);
      await markStripeWebhookInboxResult(replay.stripeEventId, "processed");
      await finishStripeWebhookReplay(replay, workerId, "completed");
      results.push({ id: replay.id, status: "completed" });
    } catch (error) {
      const failure = classifyStripeWebhookProcessingFailure(error);
      const terminal = !failure.retry || replay.attemptCount >= 5;
      const status = terminal ? "manual_review" : "retry";
      await markStripeWebhookInboxResult(
        replay.stripeEventId,
        terminal ? "manual_review" : "temporary_failure",
        failure.code,
      ).catch(() => undefined);
      await finishStripeWebhookReplay(replay, workerId, status, failure.code);
      results.push({ id: replay.id, status, code: failure.code });
    }
  }

  return {
    available: true,
    queued: queued.queued,
    claimed: replays.length,
    processed: results.length,
    failed: results.filter((item) => item.status !== "completed").length,
    results,
  };
}
