import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("post-checkout schema readiness v45", () => {
  const baselineMigration = source("supabase/migrations/20260727000035_stripe_webhook_replay_health.sql");
  const compatibilityMigration = source("supabase/migrations/20260731000040_guestlist_schema_health_compatibility.sql");
  const recoveryMigration = source("supabase/migrations/20260805000041_fulfilment_recovery_hardening.sql");
  const reconciliationMigration = source("supabase/migrations/20260805000042_reconcile_commerce_backlog.sql");
  const statusRepairMigration = source("supabase/migrations/20260805000044_post_checkout_fulfilment_status_repair.sql");
  const webhookHistoryMigration = source("supabase/migrations/20260805000045_reconcile_fulfilled_webhook_history.sql");
  const readiness = source("src/lib/post-approval/readiness.ts");

  it("requires the fully deployed database contract", () => {
    expect(readiness).toContain("REQUIRED_POST_CHECKOUT_SCHEMA_VERSION = 45");
    expect(readiness).toContain("fully deployed production schema");
    expect(statusRepairMigration).toContain("return query select\n    44,");
    expect(webhookHistoryMigration).toContain("return query select\n    45,");
    expect(webhookHistoryMigration).toContain("skie_post_checkout_schema_health_v44");
  });

  it("requires every prelaunch migration capability", () => {
    for (const marker of [
      "promo_usage_rpc",
      "notification_enqueue_table",
      "notification_enqueue_trigger",
      "event_shutdown_table",
      "admin_page_rpc",
      "discount_allocation_column",
      "discount_allocation_trigger",
      "webhook_replay_table",
      "webhook_replay_health_rpc",
      "expanded_operations_health_guard",
      "webhook_replay_temporary_only_guard",
      "admin_page_classification_guard",
    ]) expect(baselineMigration).toContain(marker);
    expect(compatibilityMigration).toContain("standardPromoTrackingGuard");
  });

  it("retains all previously deployed payment and reservation safeguards", () => {
    for (const marker of [
      "terminal_cancellation_guard",
      "cancellation_wrapper_guard",
      "monotonic_expiry_guard",
      "payment_null_lease_guard",
      "notification_null_lease_guard",
      "promo_activation_guard",
      "promo_tracking_rpc_guard",
    ]) expect(baselineMigration).toContain(marker);
  });

  it("requires idempotent fulfilment, backlog, status and webhook-history guards", () => {
    for (const marker of [
      "reservations_00_prevent_fulfilled_regression",
      "orders_00_prevent_fulfilled_regression",
      "checkout_attempts_00_prevent_fulfilled_regression",
      "payments_00_ignore_duplicate_offline",
      "tickets_00_ignore_complete_retry",
      "entitlements_00_ignore_duplicate_retry",
      "ticket_allocations_00_prevent_double_increment",
      "fulfilledReservationRegressionGuard",
      "duplicateOfflinePaymentGuard",
      "completeTicketRetryGuard",
    ]) expect(recoveryMigration).toContain(marker);
    for (const marker of [
      "POST_APPROVAL_NO_ISSUED_TICKETS",
      "FULFILMENT_RETRY_REQUIRED",
      "WEBHOOK_CHECKOUT_STATE_REVIEW",
      "postCheckoutFulfilmentReconciliationGuard",
    ]) expect(reconciliationMigration).toContain(marker);
    for (const marker of [
      "POST_APPROVAL_TICKET_SET_INCOMPLETE",
      "v_expected_ticket_count",
      "postCheckoutStatusReconciliationGuard",
      "statusSyncRepair",
    ]) expect(statusRepairMigration).toContain(marker);
    for (const marker of [
      "skie_reconcile_fulfilled_post_checkout_webhook_history",
      "fulfilledPostCheckoutWebhookHistoryGuard",
      "v_issued_ticket_count >= proof.v_expected_ticket_count",
      "payment_intent.amount_capturable_updated",
    ]) expect(webhookHistoryMigration).toContain(marker);
  });

  it("keeps current readiness service-role-only and reloads PostgREST", () => {
    expect(webhookHistoryMigration).toContain("revoke all on function public.skie_post_checkout_schema_health()");
    expect(webhookHistoryMigration).toContain("grant execute on function public.skie_post_checkout_schema_health()");
    expect(webhookHistoryMigration).toContain("to service_role");
    expect(webhookHistoryMigration).toContain("notify pgrst, 'reload schema'");
  });
});
