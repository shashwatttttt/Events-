import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260805000044_post_checkout_fulfilment_status_repair.sql"),
  "utf8",
);
const service = readFileSync(
  join(process.cwd(), "src/lib/post-approval/service.ts"),
  "utf8",
);

describe("post-checkout fulfilment status repair", () => {
  it("requires durable payment, a fulfilled order and the complete issued-ticket set", () => {
    expect(migration).toContain("v_order.status <> 'fulfilled'");
    expect(migration).toContain("payment.status in (");
    expect(migration).toContain("v_application.stripe_payment_intent_id is null");
    expect(migration).toContain("v_expected_ticket_count");
    expect(migration).toContain("v_issued_ticket_count < v_expected_ticket_count");
    expect(migration).toContain("POST_APPROVAL_TICKET_SET_INCOMPLETE");
  });

  it("never invents approval and accepts only durable approval proof", () => {
    expect(migration).toContain("decision.decision in ('approve','approve_without_form')");
    expect(migration).toContain("'post_checkout.approve'");
    expect(migration).toContain("'post_checkout.approve_without_form'");
    expect(migration).toContain("v_application.status = 'approved'");
    expect(migration).toContain("POST_APPROVAL_APPLICATION_NOT_APPROVED");
  });

  it("closes duplicate action and webhook retries after proven fulfilment", () => {
    expect(migration).toContain("public.post_checkout_payment_actions");
    expect(migration).toContain("action.action_type in ('capture','reconcile')");
    expect(migration).toContain("public.stripe_webhook_events");
    expect(migration).toContain("event.event_type = 'payment_intent.succeeded'");
    expect(migration).toContain("public.stripe_webhook_replay_actions");
    expect(migration).toContain("replay.status <> 'completed'");
  });

  it("does not contain provider mutations or ticket creation", () => {
    expect(migration).not.toContain("stripe.paymentIntents.capture");
    expect(migration).not.toContain("stripe.paymentIntents.cancel");
    expect(migration).not.toContain("insert into public.tickets");
    expect(migration).not.toContain("insert into public.payments");
    expect(migration).not.toContain("update public.payments");
  });

  it("keeps the application service routed through the proof-based reconciler", () => {
    expect(service).toContain('rpc("skie_mark_post_checkout_fulfilled"');
    expect(service).toContain('throw new Error("POST_APPROVAL_FULFILMENT_STATUS_FAILED")');
    expect(migration).toContain("statusSyncRepair");
  });

  it("publishes fail-closed schema version 44", () => {
    expect(migration).toContain("skie_post_checkout_schema_health_v42");
    expect(migration).toContain("return query select\n    44,");
    expect(migration).toContain("postCheckoutStatusReconciliationGuard");
    expect(migration).toContain("to service_role");
  });
});
