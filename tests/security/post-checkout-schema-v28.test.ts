import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260727000028_post_checkout_schema_readiness_v28.sql"),
  "utf8",
);
const baselineReadinessMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260727000035_stripe_webhook_replay_health.sql"),
  "utf8",
);
const recoveryReadinessMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260805000041_fulfilment_recovery_hardening.sql"),
  "utf8",
);
const reconciliationReadinessMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260805000042_reconcile_commerce_backlog.sql"),
  "utf8",
);
const statusRepairMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260805000044_post_checkout_fulfilment_status_repair.sql"),
  "utf8",
);
const currentReadinessMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260805000045_reconcile_fulfilled_webhook_history.sql"),
  "utf8",
);
const readiness = readFileSync(
  join(process.cwd(), "src/lib/post-approval/readiness.ts"),
  "utf8",
);

describe("post-checkout schema readiness history", () => {
  it("retains the hardened version-28 terminal cancellation contract", () => {
    expect(migration).toContain("skie_reconcile_cancelled_post_checkout_action(uuid,text)");
    expect(migration).toContain("skie_mark_post_checkout_cancelled(text,text)");
    expect(migration).toContain("cancellation_wrapper_guard");
    expect(migration).toContain("terminal_cancellation_guard");
    expect(migration).toContain("POST_APPROVAL_ALREADY_CAPTURED");
    expect(migration).toContain("PAYMENT_INTENT_MISMATCH");
  });

  it("retains existing production safety guards", () => {
    expect(baselineReadinessMigration).toContain("monotonic_expiry_guard");
    expect(baselineReadinessMigration).toContain("promo_activation_guard");
    expect(baselineReadinessMigration).toContain("promo_tracking_rpc_guard");
    expect(baselineReadinessMigration).toContain("payment_null_lease_guard");
    expect(baselineReadinessMigration).toContain("notification_null_lease_guard");
    expect(baselineReadinessMigration).toContain("heartbeat_rpc");
    expect(baselineReadinessMigration).toContain("operations_health_rpc");
    expect(recoveryReadinessMigration).toContain("fulfilledReservationRegressionGuard");
    expect(reconciliationReadinessMigration).toContain("postCheckoutFulfilmentReconciliationGuard");
    expect(statusRepairMigration).toContain("postCheckoutStatusReconciliationGuard");
  });

  it("requires the fully deployed schema 45 contract", () => {
    expect(currentReadinessMigration).toContain("return query select\n    45,");
    expect(currentReadinessMigration).toContain("skie_post_checkout_schema_health_v44");
    expect(currentReadinessMigration).toContain("fulfilledPostCheckoutWebhookHistoryGuard");
    expect(readiness).toContain("REQUIRED_POST_CHECKOUT_SCHEMA_VERSION = 45");
    expect(readiness).toContain("fully deployed production schema");
  });

  it("keeps the readiness RPC restricted to the service role", () => {
    expect(currentReadinessMigration).toContain("revoke all on function public.skie_post_checkout_schema_health()");
    expect(currentReadinessMigration).toContain("to service_role");
  });
});
