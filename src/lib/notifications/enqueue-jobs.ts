import "server-only";

import { config } from "@/lib/config";
import { PublicApiError } from "@/lib/http";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type ClaimedNotificationEnqueueJob = {
  id: string;
  orderId: string;
  attemptCount: number;
};

function rpcUnavailable(error: unknown, functionName: string) {
  const candidate = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {};
  const code = String(candidate.code || "");
  const message = String(candidate.message || "");
  return code === "PGRST202" || message.includes(functionName);
}

export async function claimNotificationEnqueueJobs(
  workerId: string,
  batchSize: number,
): Promise<ClaimedNotificationEnqueueJob[]> {
  if (config.dataProvider !== "supabase") return [];
  const { data, error } = await createSupabaseAdminClient().rpc("skie_claim_notification_enqueue_jobs", {
    p_worker_id: workerId,
    p_batch_size: Math.max(1, Math.min(batchSize, 25)),
    p_lease_seconds: 60,
  });
  if (error) {
    // Backward-compatible rollout: the existing outbox path remains active until
    // migration 30 exposes the durable enqueue queue.
    if (rpcUnavailable(error, "skie_claim_notification_enqueue_jobs")) return [];
    throw new PublicApiError("NOTIFICATION_ENQUEUE_CLAIM_FAILED", "Fulfilment notifications are temporarily unavailable.", 503);
  }
  return (data || []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    orderId: String(row.order_id),
    attemptCount: Number(row.attempt_count || 0),
  }));
}

export async function finishNotificationEnqueueJob(
  job: ClaimedNotificationEnqueueJob,
  workerId: string,
  result: "completed" | "retry" | "manual_review",
  safeErrorCode?: string,
) {
  if (config.dataProvider !== "supabase") return;
  const retryDelaySeconds = Math.min(3600, 30 * (2 ** Math.max(0, job.attemptCount - 1)));
  const { error } = await createSupabaseAdminClient().rpc("skie_finish_notification_enqueue_job", {
    p_job_id: job.id,
    p_worker_id: workerId,
    p_result: result,
    p_safe_error_code: safeErrorCode?.slice(0, 120) || null,
    p_retry_delay_seconds: retryDelaySeconds,
  });
  if (error) throw new PublicApiError("NOTIFICATION_ENQUEUE_RESULT_FAILED", "The fulfilment notification result could not be recorded.", 503);
}

export async function completeOrderNotificationEnqueueJob(orderId: string) {
  if (config.dataProvider !== "supabase") return false;
  const { data, error } = await createSupabaseAdminClient().rpc("skie_complete_order_notification_enqueue_job", {
    p_order_id: orderId,
  });
  if (error) {
    if (rpcUnavailable(error, "skie_complete_order_notification_enqueue_job")) return false;
    throw new PublicApiError("NOTIFICATION_ENQUEUE_RESULT_FAILED", "The fulfilment notification result could not be recorded.", 503);
  }
  return data === true;
}
