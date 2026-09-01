import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260727000027_terminal_cancelled_action_reconciliation.sql"),
  "utf8",
);

describe("terminal cancellation reconciliation RPC", () => {
  it("locks the payment action and application before changing durable state", () => {
    expect(migration).toContain("skie_reconcile_cancelled_post_checkout_action");
    expect(migration).toContain("where pa.id = p_action_id");
    expect(migration).toContain("for update");
    expect(migration).toContain("PAYMENT_INTENT_MISMATCH");
    expect(migration).toContain("POST_APPROVAL_ALREADY_CAPTURED");
  });

  it("closes the application, order and payment actions atomically", () => {
    expect(migration).toContain("update public.post_checkout_applications");
    expect(migration).toContain("update public.orders");
    expect(migration).toContain("update public.post_checkout_payment_actions");
    expect(migration).toContain("payment_status = case when v_status = 'authorization_expired' then 'expired' else 'cancelled' end");
    expect(migration).toContain("status = 'completed'");
  });

  it("keeps secondary inventory, checkout and promo cleanup non-blocking", () => {
    expect(migration).toContain("update public.reservations");
    expect(migration).toContain("update public.checkout_attempts");
    expect(migration).toContain("update public.promo_redemptions");
    expect(migration.match(/exception when others then/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("routes the existing cancellation service contract through the hardened RPC", () => {
    expect(migration).toContain("create or replace function public.skie_mark_post_checkout_cancelled");
    expect(migration).toContain("when 'processing' then 0");
    expect(migration).toContain("from public.skie_reconcile_cancelled_post_checkout_action");
    expect(migration).toContain("to service_role");
  });
});
