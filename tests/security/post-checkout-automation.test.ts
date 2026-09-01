import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("post-checkout production automation", () => {
  it("blocks new Stripe authorisations until schema and durable payment safety are ready", () => {
    const checkoutRoute = source("src/app/api/checkout/create/route.ts");
    const existingIndex = checkoutRoute.indexOf("resumeExistingPostCheckout");
    const schemaIndex = checkoutRoute.lastIndexOf("await assertPostCheckoutSchemaReady()");
    const operationsIndex = checkoutRoute.lastIndexOf("await assertPostCheckoutOperationsReady()");
    const createIndex = checkoutRoute.indexOf("createPostCheckoutOrder(user, payload)");

    expect(existingIndex).toBeGreaterThan(-1);
    expect(schemaIndex).toBeGreaterThan(existingIndex);
    expect(operationsIndex).toBeGreaterThan(schemaIndex);
    expect(createIndex).toBeGreaterThan(operationsIndex);
  });

  it("checks schema readiness and every aggregate recovery class on each worker run", () => {
    const workerRoute = source("src/app/api/internal/post-checkout/process/route.ts");
    const health = source("src/lib/post-approval/health.ts");

    expect(workerRoute).toContain("await assertPostCheckoutSchemaReady()");
    expect(workerRoute).toContain("readPostCheckoutOperationsHealth");
    expect(workerRoute).toContain("reconcileFulfilledPostCheckoutWebhookHistory");
    expect(workerRoute).toContain('recordProductionOperationsHeartbeat("started")');
    expect(workerRoute).toContain('recordProductionOperationsHeartbeat("succeeded")');
    expect(health).toContain('rpc("skie_operations_health"');
    expect(health).toContain("paymentActionsRequiringReview");
    expect(health).toContain("stalledPaymentActions");
    expect(health).toContain("failedNotifications");
    expect(health).toContain("stalledNotifications");
    expect(health).toContain("notificationEnqueueJobsRequiringReview");
    expect(health).toContain("eventShutdownActionsRequiringReview");
    expect(health).toContain("webhookReplayActionsRequiringReview");
    expect(health).toContain("paymentRecoveriesRequiringReview");
    expect(health).toContain("orphanStripeSessions");
    expect(health).toContain("webhooksRequiringReview");
    expect(health).toContain("overduePostCheckoutLifecycle");
  });

  it("runs production operations every five minutes and fails on unresolved work", () => {
    const workflow = source(".github/workflows/post-checkout-worker.yml");

    expect(workflow).toContain('cron: "*/5 * * * *"');
    expect(workflow).toContain("paymentActionsFailed");
    expect(workflow).toContain("paymentActionsRequiringReview");
    expect(workflow).toContain("stalledPaymentActions");
    expect(workflow).toContain("failedNotifications");
    expect(workflow).toContain("stalledNotifications");
    expect(workflow).toContain("notificationEnqueueJobsRequiringReview");
    expect(workflow).toContain("eventShutdownActionsRequiringReview");
    expect(workflow).toContain("paymentRecoveriesRequiringReview");
    expect(workflow).toContain("orphanStripeSessions");
    expect(workflow).toContain("webhooksRequiringReview");
    expect(workflow).toContain("workerHeartbeatHealthy");
    expect(workflow).toContain("exit 1");
  });

  it("automatically deploys production migrations to the fixed project", () => {
    const workflow = source(".github/workflows/supabase-production-migrations.yml");

    expect(workflow).toContain("dgyabshzcacostpuswxs");
    expect(workflow).toContain("supabase db push --dry-run");
    expect(workflow).toContain("supabase db push");
    expect(workflow).toContain("SUPABASE_ACCESS_TOKEN");
    expect(workflow).toContain("SUPABASE_DB_PASSWORD");
  });

  it("requires fully deployed schema 45 and retains all earlier guards", () => {
    const readiness = source("src/lib/post-approval/readiness.ts");
    const lifecycleMigration = source("supabase/migrations/20260724000018_post_checkout_promo_consistency.sql");
    const activationMigration = source("supabase/migrations/20260724000019_promo_activation_integrity.sql");
    const queueMigration = source("supabase/migrations/20260725000020_recover_post_checkout_payment_queue.sql");
    const reliabilityMigration = source("supabase/migrations/20260725000021_deep_operations_reliability.sql");
    const readinessMigration = source("supabase/migrations/20260727000035_stripe_webhook_replay_health.sql");
    const recoveryMigration = source("supabase/migrations/20260805000041_fulfilment_recovery_hardening.sql");
    const reconciliationMigration = source("supabase/migrations/20260805000042_reconcile_commerce_backlog.sql");
    const statusRepairMigration = source("supabase/migrations/20260805000044_post_checkout_fulfilment_status_repair.sql");
    const webhookHistoryMigration = source("supabase/migrations/20260805000045_reconcile_fulfilled_webhook_history.sql");

    expect(readiness).toContain("REQUIRED_POST_CHECKOUT_SCHEMA_VERSION = 45");
    expect(readiness).toContain("fully deployed production schema");
    expect(lifecycleMigration).toContain("skie_restart_unpaid_post_checkout");
    expect(lifecycleMigration).toContain("promoReleaseGuard");
    expect(lifecycleMigration).toContain("to service_role");
    expect(activationMigration).toContain("promoActivationGuard");
    expect(activationMigration).toContain("promo_codes_active_status_check");
    expect(queueMigration).toContain("queueRecoveryGuard");
    expect(queueMigration).toContain("lease_expires_at <= now()");
    expect(reliabilityMigration).toContain("operations_worker_heartbeats");
    expect(reliabilityMigration).toContain("skie_operations_health");
    expect(reliabilityMigration).toContain("lease_expires_at is null");
    expect(readinessMigration).toContain("select\n    35,");
    expect(readinessMigration).toContain("terminal_cancellation_guard");
    expect(readinessMigration).toContain("payment_null_lease_guard");
    expect(readinessMigration).toContain("notification_null_lease_guard");
    expect(readinessMigration).toContain("notification_enqueue_jobs");
    expect(readinessMigration).toContain("event_payment_shutdown_actions");
    expect(readinessMigration).toContain("stripe_webhook_replay_actions");
    expect(recoveryMigration).toContain("completeTicketRetryGuard");
    expect(reconciliationMigration).toContain("postCheckoutFulfilmentReconciliationGuard");
    expect(statusRepairMigration).toContain("return query select\n    44,");
    expect(statusRepairMigration).toContain("postCheckoutStatusReconciliationGuard");
    expect(webhookHistoryMigration).toContain("return query select\n    45,");
    expect(webhookHistoryMigration).toContain("fulfilledPostCheckoutWebhookHistoryGuard");
    expect(webhookHistoryMigration).toContain("to service_role");
  });
});
