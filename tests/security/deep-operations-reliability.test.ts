import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("deep production operations reliability", () => {
  it("blocks new post-checkout authorisations when automation is unhealthy", () => {
    const route = source("src/app/api/checkout/create/route.ts");
    const resume = route.indexOf("resumeExistingPostCheckout");
    const schema = route.lastIndexOf("await assertPostCheckoutSchemaReady()");
    const operations = route.lastIndexOf("await assertPostCheckoutOperationsReady()");
    const create = route.indexOf("createPostCheckoutOrder(user, payload)");

    expect(resume).toBeGreaterThan(-1);
    expect(schema).toBeGreaterThan(resume);
    expect(operations).toBeGreaterThan(schema);
    expect(create).toBeGreaterThan(operations);
  });

  it("requires the heartbeat, expanded health queues and schema version 45", () => {
    const readiness = source("src/lib/post-approval/readiness.ts");
    const reliabilityMigration = source("supabase/migrations/20260725000021_deep_operations_reliability.sql");
    const readinessMigration = source("supabase/migrations/20260727000035_stripe_webhook_replay_health.sql");
    const recoveryMigration = source("supabase/migrations/20260805000041_fulfilment_recovery_hardening.sql");
    const reconciliationMigration = source("supabase/migrations/20260805000042_reconcile_commerce_backlog.sql");
    const webhookHistoryMigration = source("supabase/migrations/20260805000045_reconcile_fulfilled_webhook_history.sql");

    expect(readiness).toContain("REQUIRED_POST_CHECKOUT_SCHEMA_VERSION = 45");
    expect(reliabilityMigration).toContain("operations_worker_heartbeats");
    expect(reliabilityMigration).toContain("skie_record_operations_worker_heartbeat");
    expect(reliabilityMigration).toContain("skie_operations_health");
    expect(reliabilityMigration).toContain("worker_heartbeat_healthy");
    expect(reliabilityMigration).toContain("lease_expires_at is null");
    expect(readinessMigration).toContain("select\n    35,");
    expect(readinessMigration).toContain("heartbeat_rpc");
    expect(readinessMigration).toContain("operations_health_rpc");
    expect(readinessMigration).toContain("notification_enqueue_table");
    expect(readinessMigration).toContain("event_shutdown_table");
    expect(readinessMigration).toContain("webhook_replay_health_rpc");
    expect(recoveryMigration).toContain("fulfilledReservationRegressionGuard");
    expect(reconciliationMigration).toContain("return query select\n    42,");
    expect(reconciliationMigration).toContain("postCheckoutFulfilmentReconciliationGuard");
    expect(webhookHistoryMigration).toContain("return query select\n    45,");
    expect(webhookHistoryMigration).toContain("fulfilledPostCheckoutWebhookHistoryGuard");
    expect(webhookHistoryMigration).toContain("to service_role");
  });

  it("makes commerce health and GitHub monitoring fail closed on every recovery class", () => {
    const health = source("src/lib/post-approval/health.ts");
    const route = source("src/app/api/health/commerce/route.ts");
    const workflow = source(".github/workflows/post-checkout-worker.yml");

    for (const marker of [
      "stalledNotifications",
      "stalledNotificationEnqueueJobs",
      "stalledEventShutdownActions",
      "stalledWebhookReplayActions",
      "paymentRecoveriesRequiringReview",
      "orphanStripeSessions",
      "webhooksRequiringReview",
      "staleTemporaryWebhooks",
      "overduePostCheckoutLifecycle",
      "workerHeartbeatHealthy",
      "notificationProviderConfigurationHealthy",
    ]) expect(health).toContain(marker);
    for (const marker of [
      "STALLED_NOTIFICATIONS",
      "STALLED_ENQUEUE_JOBS",
      "STALLED_EVENT_SHUTDOWN",
      "PAYMENT_RECOVERIES",
      "ORPHAN_SESSIONS",
      "WEBHOOK_REVIEW",
      "STALE_WEBHOOKS",
      "OVERDUE_LIFECYCLE",
      "HEARTBEAT_OK",
      "PROVIDER_OK",
    ]) expect(workflow).toContain(marker);
    expect(route).toContain("postCheckoutOperationsHealthy(operations)");
    expect(route).toContain("&& automationHealthy");
  });

  it("records worker started, success and failure heartbeats", () => {
    const route = source("src/app/api/internal/post-checkout/process/route.ts");
    expect(route).toContain('recordProductionOperationsHeartbeat("started")');
    expect(route).toContain('recordProductionOperationsHeartbeat("succeeded")');
    expect(route).toContain('recordProductionOperationsHeartbeat("failed"');
  });

  it("rejects malformed aggregate counters instead of converting them to a healthy zero", () => {
    const health = source("src/lib/post-approval/health.ts");
    expect(health).toContain("Number.isSafeInteger(value)");
    expect(health).toContain("OPERATIONS_HEALTH_INVALID");
  });
});
