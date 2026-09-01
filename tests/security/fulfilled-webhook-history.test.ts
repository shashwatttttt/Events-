import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const migration = source("supabase/migrations/20260805000045_reconcile_fulfilled_webhook_history.sql");

describe("fulfilled post-checkout webhook history", () => {
  it("requires fulfilled order, approved application, payment proof and complete tickets", () => {
    expect(migration).toContain("ordered.status = 'fulfilled'");
    expect(migration).toContain("ordered.workflow_status = 'fulfilled'");
    expect(migration).toContain("application.status in ('approved','approved_override')");
    expect(migration).toContain("payment.status in (");
    expect(migration).toContain("v_expected_ticket_count");
    expect(migration).toContain("v_issued_ticket_count >= proof.v_expected_ticket_count");
  });

  it("reconciles only Stripe success and progression events linked to that proof", () => {
    expect(migration).toContain("'checkout.session.completed'");
    expect(migration).toContain("'checkout.session.async_payment_succeeded'");
    expect(migration).toContain("'payment_intent.amount_capturable_updated'");
    expect(migration).toContain("'payment_intent.succeeded'");
    expect(migration).toContain("proof.stripe_payment_intent_id = event.payment_intent_id");
    expect(migration).toContain("proof.stripe_checkout_session_id = event.checkout_session_id");
  });

  it("never mutates Stripe or creates commerce records", () => {
    expect(migration).not.toContain("stripe.paymentIntents.capture");
    expect(migration).not.toContain("stripe.paymentIntents.cancel");
    expect(migration).not.toContain("insert into public.tickets");
    expect(migration).not.toContain("insert into public.payments");
    expect(migration).not.toContain("update public.payments");
  });

  it("runs before replay processing on every scheduled worker pass", () => {
    const route = source("src/app/api/internal/post-checkout/process/route.ts");
    const reconciliationIndex = route.indexOf("reconcileFulfilledPostCheckoutWebhookHistory()");
    const replayIndex = route.indexOf("const webhookReplay = await processStripeWebhookReplayBatch");
    expect(reconciliationIndex).toBeGreaterThan(-1);
    expect(replayIndex).toBeGreaterThan(reconciliationIndex);
    expect(route).toContain("webhookHistory");
  });

  it("validates bounded reconciliation counts", () => {
    const helper = source("src/lib/payments/fulfilled-webhook-reconciliation.ts");
    expect(helper).toContain('rpc(\n    "skie_reconcile_fulfilled_post_checkout_webhook_history"');
    expect(helper).toContain("Number.isSafeInteger(parsed)");
    expect(helper).toContain("FULFILLED_WEBHOOK_RECONCILIATION_UNAVAILABLE");
  });

  it("publishes service-role-only database schema version 45", () => {
    expect(migration).toContain("skie_post_checkout_schema_health_v44");
    expect(migration).toContain("return query select\n    45,");
    expect(migration).toContain("fulfilledPostCheckoutWebhookHistoryGuard");
    expect(migration).toContain("to service_role");
  });
});
