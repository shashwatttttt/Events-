import "server-only";

import { config } from "@/lib/config";
import { readSiteData } from "@/lib/data/documents";
import { canStartCheckout } from "@/lib/event-state";
import {
  cancelStripePaymentIntent,
  expireStripeCheckoutSession,
  retrieveStripeCheckoutSession,
  retrieveStripePaymentIntent,
} from "@/lib/payments";
import { expireNormalizedSessionState } from "@/lib/payments/transaction-store";
import { markPostCheckoutCancelled } from "@/lib/post-approval/store";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type ClaimedEventPaymentShutdownAction = {
  id: string;
  eventId: string;
  objectType: "checkout_session" | "payment_intent";
  providerObjectId: string;
  actionType: "expire_session" | "cancel_intent";
  applicationId?: string;
  attemptCount: number;
};

type EventShutdownOutcome = "completed" | "released";

function rpcUnavailable(error: unknown, functionName: string) {
  const candidate = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {};
  const code = String(candidate.code || "");
  const message = String(candidate.message || "");
  return code === "PGRST202" || message.includes(functionName);
}

function safeShutdownCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z0-9_]{3,120}$/.test(message) ? message : "EVENT_SHUTDOWN_PROVIDER_FAILED";
}

async function eventPaymentShutdownStillRequired(eventId: string) {
  const site = await readSiteData();
  const event = site.events.find((candidate) => candidate.id === eventId);
  return !event || !canStartCheckout(event);
}

export async function requestEventPaymentShutdown(eventIds: string[]) {
  const uniqueEventIds = [...new Set(eventIds.filter(Boolean))];
  if (config.dataProvider !== "supabase" || !uniqueEventIds.length) {
    return { available: config.dataProvider === "supabase", checkoutSessionsQueued: 0, paymentIntentsQueued: 0 };
  }
  const { data, error } = await createSupabaseAdminClient().rpc("skie_request_event_payment_shutdown", {
    p_event_ids: uniqueEventIds,
  });
  if (error) {
    if (rpcUnavailable(error, "skie_request_event_payment_shutdown")) {
      return { available: false, checkoutSessionsQueued: 0, paymentIntentsQueued: 0 };
    }
    throw new Error("EVENT_SHUTDOWN_QUEUE_UNAVAILABLE");
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  return {
    available: true,
    checkoutSessionsQueued: Number(row?.checkout_sessions_queued || 0),
    paymentIntentsQueued: Number(row?.payment_intents_queued || 0),
  };
}

async function claimEventPaymentShutdownActions(
  workerId: string,
  batchSize: number,
): Promise<ClaimedEventPaymentShutdownAction[]> {
  if (config.dataProvider !== "supabase") return [];
  const { data, error } = await createSupabaseAdminClient().rpc("skie_claim_event_payment_shutdown_actions", {
    p_worker_id: workerId,
    p_batch_size: Math.max(1, Math.min(batchSize, 25)),
    p_lease_seconds: 60,
  });
  if (error) {
    if (rpcUnavailable(error, "skie_claim_event_payment_shutdown_actions")) return [];
    throw new Error("EVENT_SHUTDOWN_CLAIM_FAILED");
  }
  return (data || []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    eventId: String(row.event_id),
    objectType: String(row.provider_object_type) as ClaimedEventPaymentShutdownAction["objectType"],
    providerObjectId: String(row.provider_object_id),
    actionType: String(row.action_type) as ClaimedEventPaymentShutdownAction["actionType"],
    applicationId: row.application_id ? String(row.application_id) : undefined,
    attemptCount: Number(row.attempt_count || 0),
  }));
}

async function finishEventPaymentShutdownAction(
  action: ClaimedEventPaymentShutdownAction,
  workerId: string,
  result: "completed" | "retry" | "manual_review",
  safeErrorCode?: string,
) {
  const retryDelaySeconds = Math.min(3600, 30 * (2 ** Math.max(0, action.attemptCount - 1)));
  const { error } = await createSupabaseAdminClient().rpc("skie_finish_event_payment_shutdown_action", {
    p_action_id: action.id,
    p_worker_id: workerId,
    p_result: result,
    p_safe_error_code: safeErrorCode?.slice(0, 120) || null,
    p_retry_delay_seconds: retryDelaySeconds,
  });
  if (error) throw new Error("EVENT_SHUTDOWN_RESULT_FAILED");
}

async function releaseEventPaymentShutdownAction(
  action: ClaimedEventPaymentShutdownAction,
  workerId: string,
) {
  const { data, error } = await createSupabaseAdminClient()
    .from("event_payment_shutdown_actions")
    .delete()
    .eq("id", action.id)
    .eq("status", "processing")
    .eq("lease_owner", workerId)
    .select("id")
    .maybeSingle();
  if (error || !data) throw new Error("EVENT_SHUTDOWN_RELEASE_FAILED");
}

async function processCheckoutSessionShutdown(
  action: ClaimedEventPaymentShutdownAction,
): Promise<EventShutdownOutcome> {
  const session = await retrieveStripeCheckoutSession(action.providerObjectId);
  if (!session) {
    if (!(await eventPaymentShutdownStillRequired(action.eventId))) return "released";
    await expireNormalizedSessionState(action.providerObjectId, "expired");
    return "completed";
  }
  if (session.status === "expired") {
    await expireNormalizedSessionState(action.providerObjectId, "expired");
    return "completed";
  }
  if (session.status === "open") {
    if (!(await eventPaymentShutdownStillRequired(action.eventId))) return "released";
    await expireStripeCheckoutSession(action.providerObjectId);
    await expireNormalizedSessionState(action.providerObjectId, "expired");
    return "completed";
  }
  if (session.status === "complete" && session.payment_status === "paid") {
    if (!(await eventPaymentShutdownStillRequired(action.eventId))) return "completed";
    throw new Error("EVENT_SHUTDOWN_SESSION_ALREADY_PAID");
  }
  // A completed manual-capture session is closed at the PaymentIntent layer.
  return "completed";
}

async function processPaymentIntentShutdown(
  action: ClaimedEventPaymentShutdownAction,
): Promise<EventShutdownOutcome> {
  const paymentIntent = await retrieveStripePaymentIntent(action.providerObjectId);
  if (!paymentIntent) {
    if (!(await eventPaymentShutdownStillRequired(action.eventId))) return "released";
    await markPostCheckoutCancelled(action.providerObjectId, "rejected");
    return "completed";
  }
  if (paymentIntent.status === "canceled") {
    await markPostCheckoutCancelled(action.providerObjectId, "rejected");
    return "completed";
  }
  if (paymentIntent.status === "succeeded") {
    if (!(await eventPaymentShutdownStillRequired(action.eventId))) return "completed";
    throw new Error("EVENT_SHUTDOWN_PAYMENT_ALREADY_CAPTURED");
  }
  if (!(await eventPaymentShutdownStillRequired(action.eventId))) return "released";
  const cancelled = await cancelStripePaymentIntent(
    action.providerObjectId,
    `event-shutdown:${action.id}`,
  );
  if (cancelled.status !== "canceled") throw new Error(`EVENT_SHUTDOWN_CANCEL_${cancelled.status.toUpperCase()}`);
  await markPostCheckoutCancelled(action.providerObjectId, "rejected");
  return "completed";
}

export async function processEventPaymentShutdownBatch(options: {
  eventIds?: string[];
  batchSize?: number;
  workerId?: string;
} = {}) {
  if (config.dataProvider !== "supabase") {
    return { available: false, queued: { checkoutSessionsQueued: 0, paymentIntentsQueued: 0 }, claimed: 0, processed: 0, failed: 0, results: [] };
  }
  const site = await readSiteData();
  const closedEventIds = options.eventIds?.length
    ? [...new Set(options.eventIds)]
    : site.events.filter((event) => !canStartCheckout(event)).map((event) => event.id);
  const queued = await requestEventPaymentShutdown(closedEventIds);
  if (!queued.available) {
    return { available: false, queued, claimed: 0, processed: 0, failed: 0, results: [] };
  }

  const workerId = options.workerId || `event_shutdown_${crypto.randomUUID()}`;
  const actions = await claimEventPaymentShutdownActions(workerId, options.batchSize || 10);
  const results: Array<{ id: string; status: "completed" | "retry" | "manual_review"; code?: string }> = [];
  for (const action of actions) {
    try {
      const outcome = action.objectType === "checkout_session"
        ? await processCheckoutSessionShutdown(action)
        : await processPaymentIntentShutdown(action);
      if (outcome === "released") {
        // Delete a no-longer-required action so the same provider object can be
        // queued again if the event is closed after being reopened.
        await releaseEventPaymentShutdownAction(action, workerId);
        results.push({ id: action.id, status: "completed", code: "EVENT_SHUTDOWN_RELEASED_EVENT_REOPENED" });
        continue;
      }
      await finishEventPaymentShutdownAction(action, workerId, "completed");
      results.push({ id: action.id, status: "completed" });
    } catch (error) {
      const code = safeShutdownCode(error);
      const providerTerminal = code === "EVENT_SHUTDOWN_SESSION_ALREADY_PAID"
        || code === "EVENT_SHUTDOWN_PAYMENT_ALREADY_CAPTURED";
      const terminal = providerTerminal || action.attemptCount >= 5;
      await finishEventPaymentShutdownAction(
        action,
        workerId,
        terminal ? "manual_review" : "retry",
        code,
      );
      results.push({ id: action.id, status: terminal ? "manual_review" : "retry", code });
    }
  }
  return {
    available: true,
    queued,
    claimed: actions.length,
    processed: results.length,
    failed: results.filter((item) => item.status !== "completed").length,
    results,
  };
}

export async function postCheckoutApplicationEventOpen(applicationId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select("event_id")
    .eq("id", applicationId)
    .maybeSingle();
  if (error || !data?.event_id) throw new Error("EVENT_STATE_UNAVAILABLE");
  const site = await readSiteData();
  const event = site.events.find((candidate) => candidate.id === String(data.event_id));
  return Boolean(event && canStartCheckout(event));
}
