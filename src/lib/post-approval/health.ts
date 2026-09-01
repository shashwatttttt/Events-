import "server-only";

import { config } from "@/lib/config";
import { readStripeWebhookReplayHealth } from "@/lib/payments/webhook-replay";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type PostCheckoutOperationsHealth = {
  paymentActionsRequiringReview: number;
  stalledPaymentActions: number;
  staleRequestedPaymentActions: number;
  overdueRetryPaymentActions: number;
  expiredProcessingPaymentActions: number;
  failedNotifications: number;
  stalledNotifications: number;
  staleQueuedNotifications: number;
  overdueRetryNotifications: number;
  expiredProcessingNotifications: number;
  notificationEnqueueJobsRequiringReview: number;
  stalledNotificationEnqueueJobs: number;
  staleRequestedNotificationEnqueueJobs: number;
  overdueRetryNotificationEnqueueJobs: number;
  expiredProcessingNotificationEnqueueJobs: number;
  eventShutdownActionsRequiringReview: number;
  stalledEventShutdownActions: number;
  staleRequestedEventShutdownActions: number;
  overdueRetryEventShutdownActions: number;
  expiredProcessingEventShutdownActions: number;
  webhookReplayActionsRequiringReview: number;
  stalledWebhookReplayActions: number;
  staleRequestedWebhookReplayActions: number;
  overdueRetryWebhookReplayActions: number;
  expiredProcessingWebhookReplayActions: number;
  paymentRecoveriesRequiringReview: number;
  orphanStripeSessions: number;
  webhooksRequiringReview: number;
  staleTemporaryWebhooks: number;
  overduePostCheckoutLifecycle: number;
  workerHeartbeatHealthy: boolean;
  workerLastSucceededAt?: string;
  notificationProviderConfigurationHealthy: boolean;
};

type OperationsHealthRow = Record<string, unknown>;

function count(row: OperationsHealthRow, key: string) {
  const value = Number(row[key] || 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("OPERATIONS_HEALTH_INVALID");
  return value;
}

/** Strict health used by monitoring and the operations status endpoint. */
export function postCheckoutOperationsHealthy(health: PostCheckoutOperationsHealth) {
  return health.paymentActionsRequiringReview === 0
    && health.stalledPaymentActions === 0
    && health.failedNotifications === 0
    && health.stalledNotifications === 0
    && health.notificationEnqueueJobsRequiringReview === 0
    && health.stalledNotificationEnqueueJobs === 0
    && health.eventShutdownActionsRequiringReview === 0
    && health.stalledEventShutdownActions === 0
    && health.webhookReplayActionsRequiringReview === 0
    && health.stalledWebhookReplayActions === 0
    && health.paymentRecoveriesRequiringReview === 0
    && health.orphanStripeSessions === 0
    && health.webhooksRequiringReview === 0
    && health.staleTemporaryWebhooks === 0
    && health.overduePostCheckoutLifecycle === 0
    && health.workerHeartbeatHealthy
    && health.notificationProviderConfigurationHealthy;
}

/**
 * Only durable conditions that make a new customer authorisation unsafe may
 * stop checkout globally. Retriable background work and historical webhook
 * incidents stay visible in monitoring but are isolated from unrelated sales.
 */
export function postCheckoutAuthorisationBlockers(health: PostCheckoutOperationsHealth) {
  const blockers: string[] = [];
  if (health.paymentActionsRequiringReview > 0) blockers.push("PAYMENT_ACTION_REVIEW_REQUIRED");
  if (health.paymentRecoveriesRequiringReview > 0) blockers.push("PAYMENT_RECOVERY_REVIEW_REQUIRED");
  if (health.orphanStripeSessions > 0) blockers.push("ORPHAN_STRIPE_SESSION");
  if (!health.notificationProviderConfigurationHealthy) blockers.push("NOTIFICATION_PROVIDER_NOT_CONFIGURED");
  return blockers;
}

export function postCheckoutAuthorisationHealthy(health: PostCheckoutOperationsHealth) {
  return postCheckoutAuthorisationBlockers(health).length === 0;
}

/** Diagnostic-only conditions. These must never become a global sales switch. */
export function postCheckoutMonitoringOnlyBlockers(health: PostCheckoutOperationsHealth) {
  const blockers: string[] = [];
  if (health.stalledPaymentActions > 0) blockers.push("PAYMENT_ACTION_STALLED");
  if (health.webhookReplayActionsRequiringReview > 0) blockers.push("WEBHOOK_REPLAY_REVIEW_REQUIRED");
  if (health.stalledWebhookReplayActions > 0) blockers.push("WEBHOOK_REPLAY_STALLED");
  if (health.webhooksRequiringReview > 0) blockers.push("WEBHOOK_REVIEW_REQUIRED");
  if (health.staleTemporaryWebhooks > 0) blockers.push("WEBHOOK_RETRY_STALLED");
  if (!health.workerHeartbeatHealthy) blockers.push("WORKER_HEARTBEAT_STALE");
  if (health.failedNotifications > 0) blockers.push("NOTIFICATION_FAILURE");
  if (health.stalledNotifications > 0) blockers.push("NOTIFICATION_STALLED");
  if (health.overduePostCheckoutLifecycle > 0) blockers.push("POST_CHECKOUT_LIFECYCLE_OVERDUE");
  return blockers;
}

export async function recordProductionOperationsHeartbeat(
  status: "started" | "succeeded" | "failed",
  safeErrorCode?: string,
) {
  const { error } = await createSupabaseAdminClient().rpc("skie_record_operations_worker_heartbeat", {
    p_worker_key: "production_operations",
    p_status: status,
    p_safe_error_code: safeErrorCode?.slice(0, 120) || null,
  });
  if (error) throw new Error("OPERATIONS_HEARTBEAT_UNAVAILABLE");
}

async function queryOperationsHealth() {
  const { data, error } = await createSupabaseAdminClient().rpc("skie_operations_health", {
    p_capture_safety_minutes: Math.max(30, Math.min(config.postCheckoutCaptureSafetyMinutes, 24 * 60)),
    p_heartbeat_grace_minutes: 15,
  });
  if (error) throw new Error("OPERATIONS_HEALTH_UNAVAILABLE");

  const row = (Array.isArray(data) ? data[0] : data) as OperationsHealthRow | null;
  if (!row) throw new Error("OPERATIONS_HEALTH_UNAVAILABLE");
  return row;
}

async function wait(milliseconds: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function readPostCheckoutOperationsHealth(): Promise<PostCheckoutOperationsHealth> {
  let row: OperationsHealthRow | null = null;
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      row = await queryOperationsHealth();
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(100 * (attempt + 1));
    }
  }

  if (!row) throw lastError instanceof Error ? lastError : new Error("OPERATIONS_HEALTH_UNAVAILABLE");

  const replay = await readStripeWebhookReplayHealth();
  const staleRequestedPaymentActions = count(row, "stale_requested_payment_actions");
  const overdueRetryPaymentActions = count(row, "overdue_retry_payment_actions");
  const expiredProcessingPaymentActions = count(row, "expired_processing_payment_actions");
  const staleQueuedNotifications = count(row, "stale_queued_notifications");
  const overdueRetryNotifications = count(row, "overdue_retry_notifications");
  const expiredProcessingNotifications = count(row, "expired_processing_notifications");
  const staleRequestedNotificationEnqueueJobs = count(row, "stale_requested_notification_enqueue_jobs");
  const overdueRetryNotificationEnqueueJobs = count(row, "overdue_retry_notification_enqueue_jobs");
  const expiredProcessingNotificationEnqueueJobs = count(row, "expired_processing_notification_enqueue_jobs");
  const staleRequestedEventShutdownActions = count(row, "stale_requested_event_shutdown_actions");
  const overdueRetryEventShutdownActions = count(row, "overdue_retry_event_shutdown_actions");
  const expiredProcessingEventShutdownActions = count(row, "expired_processing_event_shutdown_actions");
  const workerLastSucceededAt = row.worker_last_succeeded_at ? String(row.worker_last_succeeded_at) : undefined;
  const inboxReview = count(row, "webhooks_requiring_review");
  const staleInbox = count(row, "stale_temporary_webhooks");

  return {
    paymentActionsRequiringReview: count(row, "payment_actions_requiring_review"),
    stalledPaymentActions: staleRequestedPaymentActions + overdueRetryPaymentActions + expiredProcessingPaymentActions,
    staleRequestedPaymentActions,
    overdueRetryPaymentActions,
    expiredProcessingPaymentActions,
    failedNotifications: count(row, "failed_notifications"),
    stalledNotifications: staleQueuedNotifications + overdueRetryNotifications + expiredProcessingNotifications,
    staleQueuedNotifications,
    overdueRetryNotifications,
    expiredProcessingNotifications,
    notificationEnqueueJobsRequiringReview: count(row, "notification_enqueue_jobs_requiring_review"),
    stalledNotificationEnqueueJobs: staleRequestedNotificationEnqueueJobs + overdueRetryNotificationEnqueueJobs + expiredProcessingNotificationEnqueueJobs,
    staleRequestedNotificationEnqueueJobs,
    overdueRetryNotificationEnqueueJobs,
    expiredProcessingNotificationEnqueueJobs,
    eventShutdownActionsRequiringReview: count(row, "event_shutdown_actions_requiring_review"),
    stalledEventShutdownActions: staleRequestedEventShutdownActions + overdueRetryEventShutdownActions + expiredProcessingEventShutdownActions,
    staleRequestedEventShutdownActions,
    overdueRetryEventShutdownActions,
    expiredProcessingEventShutdownActions,
    webhookReplayActionsRequiringReview: replay.actionsRequiringReview,
    stalledWebhookReplayActions: replay.stalledActions,
    staleRequestedWebhookReplayActions: replay.staleRequestedActions,
    overdueRetryWebhookReplayActions: replay.overdueRetryActions,
    expiredProcessingWebhookReplayActions: replay.expiredProcessingActions,
    paymentRecoveriesRequiringReview: count(row, "payment_recoveries_requiring_review"),
    orphanStripeSessions: count(row, "orphan_stripe_sessions"),
    webhooksRequiringReview: inboxReview + replay.actionsRequiringReview,
    staleTemporaryWebhooks: staleInbox + replay.stalledActions,
    overduePostCheckoutLifecycle: count(row, "overdue_post_checkout_lifecycle"),
    workerHeartbeatHealthy: row.worker_heartbeat_healthy === true,
    workerLastSucceededAt,
    notificationProviderConfigurationHealthy: config.appMode !== "live"
      || (config.emailProvider === "resend" && Boolean(process.env.RESEND_API_KEY?.trim())),
  };
}
