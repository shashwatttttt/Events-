import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("public commerce health endpoint", () => {
  it("checks live Supabase against fully deployed schema 45", () => {
    const route = source("src/app/api/health/commerce/route.ts");
    const health = source("src/lib/post-approval/health.ts");
    const readiness = source("src/lib/post-approval/readiness.ts");
    const recoveryMigration = source("supabase/migrations/20260805000041_fulfilment_recovery_hardening.sql");
    const reconciliationMigration = source("supabase/migrations/20260805000042_reconcile_commerce_backlog.sql");
    const statusRepairMigration = source("supabase/migrations/20260805000044_post_checkout_fulfilment_status_repair.sql");
    const webhookHistoryMigration = source("supabase/migrations/20260805000045_reconcile_fulfilled_webhook_history.sql");

    expect(route).toContain('config.appMode !== "live"');
    expect(route).toContain('config.dataProvider !== "supabase"');
    expect(route).toContain('rpc("skie_post_checkout_schema_health")');
    expect(route).toContain("readPostCheckoutOperationsHealth");
    expect(route).toContain("postCheckoutOperationsHealthy");
    expect(health).toContain('rpc("skie_operations_health"');
    expect(health).toContain("stalledPaymentActions");
    expect(health).toContain("stalledNotifications");
    expect(health).toContain("stalledNotificationEnqueueJobs");
    expect(health).toContain("stalledEventShutdownActions");
    expect(health).toContain("stalledWebhookReplayActions");
    expect(health).toContain("paymentRecoveriesRequiringReview");
    expect(health).toContain("orphanStripeSessions");
    expect(health).toContain("webhooksRequiringReview");
    expect(health).toContain("workerHeartbeatHealthy");
    expect(readiness).toContain("REQUIRED_POST_CHECKOUT_SCHEMA_VERSION = 45");
    expect(readiness).toContain("fully deployed production schema");
    expect(recoveryMigration).toContain("fulfilledReservationRegressionGuard");
    expect(recoveryMigration).toContain("duplicateOfflinePaymentGuard");
    expect(reconciliationMigration).toContain("postCheckoutFulfilmentReconciliationGuard");
    expect(statusRepairMigration).toContain("return query select\n    44,");
    expect(statusRepairMigration).toContain("postCheckoutStatusReconciliationGuard");
    expect(webhookHistoryMigration).toContain("return query select\n    45,");
    expect(webhookHistoryMigration).toContain("fulfilledPostCheckoutWebhookHistoryGuard");
  });

  it("blocks only durable customer-payment hazards while monitoring all recovery work", () => {
    const health = source("src/lib/post-approval/health.ts");
    expect(health).toContain("export function postCheckoutAuthorisationBlockers");
    expect(health).toContain('blockers.push("PAYMENT_ACTION_REVIEW_REQUIRED")');
    expect(health).toContain('blockers.push("PAYMENT_RECOVERY_REVIEW_REQUIRED")');
    expect(health).toContain('blockers.push("ORPHAN_STRIPE_SESSION")');
    expect(health).toContain('blockers.push("NOTIFICATION_PROVIDER_NOT_CONFIGURED")');
    expect(health).toContain("export function postCheckoutMonitoringOnlyBlockers");
    expect(health).toContain('blockers.push("PAYMENT_ACTION_STALLED")');
    expect(health).toContain('blockers.push("WEBHOOK_REVIEW_REQUIRED")');
    expect(health).toContain('blockers.push("WEBHOOK_RETRY_STALLED")');
  });

  it("returns only aggregate readiness and no secrets or record identifiers", () => {
    const route = source("src/app/api/health/commerce/route.ts");
    const health = source("src/lib/post-approval/health.ts");

    expect(route).toContain("checkout: {");
    expect(route).toContain("automation: automationHealthy");
    expect(route).toContain("schemaVersion");
    expect(route).not.toContain("process.env");
    expect(route).not.toContain("customer_id");
    expect(route).not.toContain("payment_intent");
    expect(route).not.toContain("stripe_checkout_session");
    expect(health).toContain("OperationsHealthRow");
    expect(health).toContain("Number.isSafeInteger(value)");
    expect(health).not.toContain("recipient_address");
    expect(health).not.toContain("stripe_payment_intent_id");
  });
});
