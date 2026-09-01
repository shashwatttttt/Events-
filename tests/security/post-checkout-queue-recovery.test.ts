import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("post-checkout payment queue recovery", () => {
  it("repairs stale requested actions and expired worker leases in the database", () => {
    const migration = source(
      "supabase/migrations/20260725000020_recover_post_checkout_payment_queue.sql",
    );

    expect(migration).toContain("status = 'requested'");
    expect(migration).toContain("created_at <= now() - interval '2 minutes'");
    expect(migration).toContain("status = 'processing'");
    expect(migration).toContain("lease_expires_at <= now()");
    expect(migration).toContain("for update skip locked");
    expect(migration).toContain("attempt_count = action.attempt_count + 1");
    expect(migration).toContain("queueRecoveryGuard");
    expect(migration).toContain("select\n    20,");
  });

  it("uses an atomic application fallback when the RPC returns no claimable rows", () => {
    const workerStore = source("src/lib/post-approval/worker-store.ts");

    expect(workerStore).toContain("fallbackClaimPostCheckoutPaymentActions");
    expect(workerStore).toContain('eq("status", "requested")');
    expect(workerStore).toContain('eq("status", "processing")');
    expect(workerStore).toContain('lte("lease_expires_at"');
    expect(workerStore).toContain('is("lease_expires_at", null)');
    expect(workerStore).toContain('lte("updated_at", missingLeaseBefore)');
    expect(workerStore).toContain('eq("attempt_count", attemptCount)');
    expect(workerStore).toContain("attempt_count: attemptCount + 1");
    expect(workerStore).toContain("claimPostCheckoutPaymentActionById");
  });

  it("processes a newly approved capture immediately and retains the durable worker fallback", () => {
    const adminRoute = source("src/app/api/admin/post-checkout/route.ts");
    const worker = source("src/lib/post-approval/worker.ts");

    expect(adminRoute).toContain("processPostCheckoutPaymentActionById(result.actionId)");
    expect(adminRoute).toContain('action: z.literal("process_payment")');
    expect(worker).toContain("processPostCheckoutPaymentActionById");
    expect(worker).toContain("retrieveStripePaymentIntent(action.paymentIntentId)");
    expect(worker).toContain('current.status === "requires_capture"');
  });

  it("marks queue and monitoring failures unhealthy while requiring schema 45", () => {
    const health = source("src/lib/post-approval/health.ts");
    const workerRoute = source("src/app/api/internal/post-checkout/process/route.ts");
    const readiness = source("src/lib/post-approval/readiness.ts");
    const readinessMigration = source("supabase/migrations/20260727000035_stripe_webhook_replay_health.sql");
    const recoveryMigration = source("supabase/migrations/20260805000041_fulfilment_recovery_hardening.sql");
    const reconciliationMigration = source("supabase/migrations/20260805000042_reconcile_commerce_backlog.sql");
    const webhookHistoryMigration = source("supabase/migrations/20260805000045_reconcile_fulfilled_webhook_history.sql");
    const workflow = source(".github/workflows/post-checkout-worker.yml");

    expect(health).toContain("stalledPaymentActions");
    expect(health).toContain("stalledNotificationEnqueueJobs");
    expect(health).toContain("stalledEventShutdownActions");
    expect(health).toContain("stalledWebhookReplayActions");
    expect(workerRoute).toContain("readPostCheckoutOperationsHealth");
    expect(workerRoute).toContain("reconcileFulfilledPostCheckoutWebhookHistory");
    expect(readiness).toContain("REQUIRED_POST_CHECKOUT_SCHEMA_VERSION = 45");
    expect(readinessMigration).toContain("payment_null_lease_guard");
    expect(readinessMigration).toContain("notification_null_lease_guard");
    expect(readinessMigration).toContain("notification_enqueue_claim_rpc");
    expect(readinessMigration).toContain("event_shutdown_claim_rpc");
    expect(readinessMigration).toContain("webhook_replay_claim_rpc");
    expect(recoveryMigration).toContain("FULFILMENT_RETRY_REQUIRED");
    expect(reconciliationMigration).toContain("return query select\n    42,");
    expect(reconciliationMigration).toContain("FULFILMENT_PROVIDER_REVIEW_REQUIRED");
    expect(webhookHistoryMigration).toContain("return query select\n    45,");
    expect(webhookHistoryMigration).toContain("fulfilledPostCheckoutWebhookHistoryGuard");
    expect(workflow).toContain("STALLED_PAYMENTS");
    expect(workflow).toContain("stalledPaymentActions");
  });
});
