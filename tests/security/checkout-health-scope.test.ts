import { describe, expect, it } from "vitest";
import {
  postCheckoutAuthorisationBlockers,
  postCheckoutAuthorisationHealthy,
  postCheckoutMonitoringOnlyBlockers,
  postCheckoutOperationsHealthy,
  type PostCheckoutOperationsHealth,
} from "@/lib/post-approval/health";

function health(overrides: Partial<PostCheckoutOperationsHealth> = {}): PostCheckoutOperationsHealth {
  return {
    paymentActionsRequiringReview: 0,
    stalledPaymentActions: 0,
    staleRequestedPaymentActions: 0,
    overdueRetryPaymentActions: 0,
    expiredProcessingPaymentActions: 0,
    failedNotifications: 0,
    stalledNotifications: 0,
    staleQueuedNotifications: 0,
    overdueRetryNotifications: 0,
    expiredProcessingNotifications: 0,
    notificationEnqueueJobsRequiringReview: 0,
    stalledNotificationEnqueueJobs: 0,
    staleRequestedNotificationEnqueueJobs: 0,
    overdueRetryNotificationEnqueueJobs: 0,
    expiredProcessingNotificationEnqueueJobs: 0,
    eventShutdownActionsRequiringReview: 0,
    stalledEventShutdownActions: 0,
    staleRequestedEventShutdownActions: 0,
    overdueRetryEventShutdownActions: 0,
    expiredProcessingEventShutdownActions: 0,
    webhookReplayActionsRequiringReview: 0,
    stalledWebhookReplayActions: 0,
    staleRequestedWebhookReplayActions: 0,
    overdueRetryWebhookReplayActions: 0,
    expiredProcessingWebhookReplayActions: 0,
    paymentRecoveriesRequiringReview: 0,
    orphanStripeSessions: 0,
    webhooksRequiringReview: 0,
    staleTemporaryWebhooks: 0,
    overduePostCheckoutLifecycle: 0,
    workerHeartbeatHealthy: true,
    notificationProviderConfigurationHealthy: true,
    ...overrides,
  };
}

describe("checkout health scope", () => {
  it("keeps every recovery and worker incident red in monitoring", () => {
    expect(postCheckoutOperationsHealthy(health({ paymentActionsRequiringReview: 1 }))).toBe(false);
    expect(postCheckoutOperationsHealthy(health({ stalledPaymentActions: 1 }))).toBe(false);
    expect(postCheckoutOperationsHealthy(health({ webhookReplayActionsRequiringReview: 1 }))).toBe(false);
    expect(postCheckoutOperationsHealthy(health({ stalledEventShutdownActions: 1 }))).toBe(false);
  });

  it("never blocks unrelated checkout for retriable background or webhook work", () => {
    const backgroundIncident = health({
      stalledPaymentActions: 1,
      webhookReplayActionsRequiringReview: 1,
      stalledWebhookReplayActions: 1,
      webhooksRequiringReview: 1,
      staleTemporaryWebhooks: 1,
      workerHeartbeatHealthy: false,
      failedNotifications: 2,
      stalledNotifications: 3,
      overduePostCheckoutLifecycle: 4,
    });

    expect(postCheckoutAuthorisationHealthy(backgroundIncident)).toBe(true);
    expect(postCheckoutAuthorisationBlockers(backgroundIncident)).toEqual([]);
    expect(postCheckoutMonitoringOnlyBlockers(backgroundIncident)).toEqual([
      "PAYMENT_ACTION_STALLED",
      "WEBHOOK_REPLAY_REVIEW_REQUIRED",
      "WEBHOOK_REPLAY_STALLED",
      "WEBHOOK_REVIEW_REQUIRED",
      "WEBHOOK_RETRY_STALLED",
      "WORKER_HEARTBEAT_STALE",
      "NOTIFICATION_FAILURE",
      "NOTIFICATION_STALLED",
      "POST_CHECKOUT_LIFECYCLE_OVERDUE",
    ]);
  });

  it("pauses new card authorisations only for durable customer-payment hazards", () => {
    const unsafe = health({
      paymentActionsRequiringReview: 1,
      paymentRecoveriesRequiringReview: 1,
      orphanStripeSessions: 1,
      notificationProviderConfigurationHealthy: false,
    });

    expect(postCheckoutAuthorisationHealthy(unsafe)).toBe(false);
    expect(postCheckoutAuthorisationBlockers(unsafe)).toEqual([
      "PAYMENT_ACTION_REVIEW_REQUIRED",
      "PAYMENT_RECOVERY_REVIEW_REQUIRED",
      "ORPHAN_STRIPE_SESSION",
      "NOTIFICATION_PROVIDER_NOT_CONFIGURED",
    ]);
  });

  it("does not let monitoring-only incidents leak into the authorisation predicate", () => {
    const monitoringOnly = health({
      stalledPaymentActions: 5,
      webhookReplayActionsRequiringReview: 2,
      staleTemporaryWebhooks: 3,
      workerHeartbeatHealthy: false,
    });
    expect(postCheckoutOperationsHealthy(monitoringOnly)).toBe(false);
    expect(postCheckoutAuthorisationHealthy(monitoringOnly)).toBe(true);
  });
});
