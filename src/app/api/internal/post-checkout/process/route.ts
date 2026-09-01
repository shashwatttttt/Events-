import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { processMetaConversionBatch } from "@/lib/meta/conversions";
import { processNotificationBatch } from "@/lib/notifications/worker";
import { processEventPaymentShutdownBatch } from "@/lib/payments/event-shutdown";
import { reconcileFulfilledPostCheckoutWebhookHistory } from "@/lib/payments/fulfilled-webhook-reconciliation";
import { processStripeWebhookReplayBatch } from "@/lib/payments/webhook-replay";
import {
  readPostCheckoutOperationsHealth,
  recordProductionOperationsHeartbeat,
} from "@/lib/post-approval/health";
import { assertPostCheckoutSchemaReady } from "@/lib/post-approval/readiness";
import { processPostCheckoutApprovalBatch } from "@/lib/post-approval/worker";

export const maxDuration = 60;

const schema = z.object({
  batchSize: z.number().int().min(1).max(25).optional(),
}).strict();

function validWorkerAuthorization(request: Request) {
  const secret = process.env.POST_CHECKOUT_WORKER_SECRET?.trim();
  const authorization = request.headers.get("authorization") || "";
  if (!secret || secret.length < 32 || !authorization.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length);
  const expectedBuffer = Buffer.from(secret);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function safeWorkerErrorCode(error: unknown) {
  const candidate = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : error instanceof Error ? error.message : "";
  return /^[A-Z0-9_]{3,120}$/.test(candidate)
    ? candidate
    : "PRODUCTION_OPERATIONS_WORKER_FAILED";
}

export async function POST(request: Request) {
  try {
    if (!validWorkerAuthorization(request)) {
      return noStoreJson({ error: "Unauthorized." }, 401);
    }
    const body = await parseJsonRequest(request, schema, 2_048);
    const batchSize = body.batchSize || 10;
    await assertPostCheckoutSchemaReady();
    await recordProductionOperationsHeartbeat("started");
    try {
      // Close only historical Stripe progression events whose fulfilled order,
      // payment ledger, approval and complete issued-ticket set are already
      // durable. Doing this before replay prevents a proven success from being
      // repeatedly reprocessed after the customer has received their ticket.
      const webhookHistory = await reconcileFulfilledPostCheckoutWebhookHistory();
      const webhookReplay = await processStripeWebhookReplayBatch({
        batchSize,
        workerId: `scheduled_webhook_replay_${crypto.randomUUID()}`,
      });
      const eventShutdown = await processEventPaymentShutdownBatch({
        batchSize,
        workerId: `scheduled_event_shutdown_${crypto.randomUUID()}`,
      });
      const postCheckout = await processPostCheckoutApprovalBatch(batchSize);
      const notifications = await processNotificationBatch({
        batchSize,
        maxBatches: 4,
        channel: "all",
        workerId: `scheduled_notifications_${crypto.randomUUID()}`,
      });
      const metaAds = await processMetaConversionBatch(batchSize);
      await recordProductionOperationsHeartbeat("succeeded");
      const succeededAt = new Date().toISOString();
      const health = await readPostCheckoutOperationsHealth();
      return noStoreJson({
        ...postCheckout,
        webhookHistory,
        webhookReplay,
        eventShutdown,
        notifications,
        metaAds,
        health: {
          ...health,
          workerHeartbeatHealthy: true,
          workerLastSucceededAt: succeededAt,
        },
      });
    } catch (error) {
      await recordProductionOperationsHeartbeat("failed", safeWorkerErrorCode(error)).catch(() => undefined);
      throw error;
    }
  } catch (error) { return apiError(error); }
}
