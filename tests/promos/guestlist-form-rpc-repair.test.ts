import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260731000041_guestlist_form_rpc_repair.sql"),
  "utf8",
);

describe("guest-list form RPC repair", () => {
  it("qualifies application and order state-version writes", () => {
    expect(migration).toContain("state_version = application_row.state_version + 1");
    expect(migration).toContain("state_version = order_row.state_version + 1");
    expect(migration).toContain("returning application_row.* into v_application");
  });

  it("supports both authorised and no-payment application forms", () => {
    expect(migration).toContain("payment_status not in ('authorized','not_required')");
    expect(migration).toContain("POST_APPROVAL_FORM_NOT_EDITABLE");
    expect(migration).toContain("POST_APPROVAL_FORM_NOT_SUBMITTABLE");
  });

  it("keeps reservation and order lifecycle protection during submission", () => {
    expect(migration).toContain("greatest(reservation_row.expires_at,p_review_due_at)");
    expect(migration).toContain("POST_APPROVAL_RESERVATION_NOT_ACTIVE");
    expect(migration).toContain("order_row.status in ('reserved','checkout_pending')");
    expect(migration).toContain("POST_APPROVAL_ORDER_NOT_PREPARABLE");
  });

  it("keeps the RPCs service-role only and reloads PostgREST", () => {
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
    expect(migration).toContain("notify pgrst, 'reload schema'");
  });
});
