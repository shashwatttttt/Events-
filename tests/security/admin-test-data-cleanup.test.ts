import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("admin test data cleanup", () => {
  it("is super-admin only and preserves immutable commercial history", () => {
    const migration = source("supabase/migrations/20260728000036_admin_test_data_cleanup.sql");

    expect(migration).toContain("skie_admin_assert_super_admin");
    expect(migration).toContain("SUPER_ADMIN_REQUIRED");
    expect(migration).toContain("p.provider = 'stripe'");
    expect(migration).toContain("CUSTOMER_HAS_PROTECTED_PAYMENT");
    expect(migration).toContain("TEST_TICKET_HAS_PROTECTED_PAYMENT");
    expect(migration).toContain("CUSTOMER_HAS_PROTECTED_AUTHORIZATION");
    expect(migration).not.toContain("delete from public.payments");
    expect(migration).not.toContain("delete from public.orders");
    expect(migration).not.toContain("delete from auth.users");
  });

  it("blocks attendance, redemption, staff and unresolved recovery records", () => {
    const migration = source("supabase/migrations/20260728000036_admin_test_data_cleanup.sql");

    expect(migration).toContain("CUSTOMER_HAS_CHECK_IN_HISTORY");
    expect(migration).toContain("CUSTOMER_HAS_REDEMPTION_HISTORY");
    expect(migration).toContain("CUSTOMER_HAS_STAFF_ACCESS");
    expect(migration).toContain("CUSTOMER_HAS_UNRESOLVED_RECOVERY");
    expect(migration).toContain("TEST_TICKET_HAS_CHECK_IN_HISTORY");
    expect(migration).toContain("TEST_TICKET_HAS_REDEMPTION_HISTORY");
    expect(migration).toContain("TEST_TICKET_HAS_UNRESOLVED_RECOVERY");
  });

  it("requires exact confirmation, tombstones and an immutable audit entry", () => {
    const migration = source("supabase/migrations/20260728000036_admin_test_data_cleanup.sql");
    const customerRoute = source("src/app/api/admin/customers/route.ts");
    const ticketRoute = source("src/app/api/admin/tickets/route.ts");

    expect(migration).toContain("CUSTOMER_CONFIRMATION_MISMATCH");
    expect(migration).toContain("TICKET_CONFIRMATION_MISMATCH");
    expect(migration).toContain("admin_test_data_tombstones");
    expect(migration).toContain("test_customer.removed");
    expect(migration).toContain("test_ticket.removed");
    expect(customerRoute).toContain('requireUser(["super_admin"])');
    expect(ticketRoute).toContain('requireUser(["super_admin"])');
    expect(customerRoute).toContain("confirmation");
    expect(ticketRoute).toContain("confirmation");
  });

  it("removes disposable ticket and entitlement access after all guards pass", () => {
    const migration = source("supabase/migrations/20260728000036_admin_test_data_cleanup.sql");

    expect(migration).toContain("delete from public.tickets where id = v_ticket.id");
    expect(migration).toContain("delete from public.tickets where customer_id = v_profile.id");
    expect(migration).toContain("delete from public.entitlements where customer_id = v_profile.id");
    expect(migration).toContain("first_name = 'Removed'");
    expect(migration).toContain("admin_deleted_at = v_deleted_at");
  });

  it("removes test records from admin and analytics projections", () => {
    const visibility = source("src/lib/admin/test-data-visibility.ts");
    const snapshotRoute = source("src/app/api/admin/snapshot/route.ts");
    const analytics = source("src/lib/analytics/store.ts");
    const session = source("src/lib/security/session.ts");

    expect(visibility).toContain("admin_deleted_at");
    expect(visibility).toContain("visibleTickets");
    expect(snapshotRoute).toContain("filterRemovedTestData");
    expect(analytics).toContain("admin_deleted_at");
    expect(session).toContain("if (profile?.admin_deleted_at) return null");
  });
});
