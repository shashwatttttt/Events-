import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260805000042_reconcile_commerce_backlog.sql"),
  "utf8",
);
const requeueMigration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260805000043_requeue_linked_fulfilment_webhooks.sql"),
  "utf8",
);

describe("commerce backlog reconciliation", () => {
  it("recognises issued tickets after check-in without weakening payment checks", () => {
    expect(migration).toContain("payment_status not in ('captured','not_required')");
    expect(migration).toContain("v_decision.decision not in ('approve','approve_without_form')");
    expect(migration).toContain("status not in ('cancelled','refunded','expired')");
    expect(migration).toContain("POST_APPROVAL_NO_ISSUED_TICKETS");
  });

  it("repairs only immutable order-line projections", () => {
    expect(migration).toContain("reservation_ticket_line_id");
    expect(migration).toContain("reservation_product_line_id");
    expect(migration).toContain("on conflict (order_id,reservation_ticket_line_id) do nothing");
    expect(migration).toContain("on conflict (order_id,reservation_product_line_id) do nothing");
    expect(migration).not.toContain("update public.payments\nset amount_cents");
  });

  it("closes actions only when durable terminal state proves completion", () => {
    expect(migration).toContain("application.payment_status in ('captured','not_required')");
    expect(migration).toContain("ordered.status = 'fulfilled'");
    expect(migration).toContain("application.payment_status in ('cancelled','expired')");
    expect(migration).toContain("ordered.status in ('cancelled','expired','failed')");
  });

  it("requeues structurally complete captured work without calling Stripe", () => {
    expect(migration).toContain("FULFILMENT_RETRY_REQUIRED");
    expect(migration).toContain("application.payment_status = 'captured'");
    expect(migration).toContain("payment.status in ('payment_received','paid','partially_refunded','disputed','suspended')");
    expect(migration).not.toContain("stripe.paymentIntents");
    expect(migration).not.toContain("captureStripePaymentIntent");
  });

  it("requeues only the succeeded webhook linked to the repaired action", () => {
    expect(requeueMigration).toContain("event.event_type = 'payment_intent.succeeded'");
    expect(requeueMigration).toContain("action.stripe_payment_intent_id = event.payment_intent_id");
    expect(requeueMigration).toContain("action.status = 'retry'");
    expect(requeueMigration).toContain("action.safe_error_code = 'FULFILMENT_RETRY_REQUIRED'");
    expect(requeueMigration).toContain("on conflict (stripe_event_id) do update");
    expect(requeueMigration).not.toContain("stripe.paymentIntents.capture");
    expect(requeueMigration).not.toContain("stripe.paymentIntents.cancel");
  });

  it("reconciles webhooks only from authoritative application, payment or adjustment state", () => {
    expect(migration).toContain("payment_intent.amount_capturable_updated");
    expect(migration).toContain("payment_intent.succeeded");
    expect(migration).toContain("payment_intent.canceled");
    expect(migration).toContain("checkout.session.expired");
    expect(migration).toContain("payment_adjustments");
    expect(migration).toContain("event.status = 'processed'");
    expect(migration).toContain("replay.status <> 'completed'");
  });

  it("keeps unresolved records visible with bounded diagnostic codes", () => {
    expect(migration).toContain("FULFILMENT_PAYMENT_LEDGER_MISSING");
    expect(migration).toContain("FULFILMENT_TICKET_SNAPSHOT_MISSING");
    expect(migration).toContain("FULFILMENT_PROVIDER_REVIEW_REQUIRED");
    expect(migration).toContain("WEBHOOK_CHECKOUT_STATE_REVIEW");
    expect(migration).toContain("WEBHOOK_PAYMENT_INTENT_STATE_REVIEW");
  });
});
