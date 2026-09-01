import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("guest-list application workflow", () => {
  it("offers a dedicated ticket-only admin purpose", () => {
    const panel = source("src/components/admin/PromoCodesPanel.tsx");
    const service = source("src/lib/promos/service.ts");
    expect(panel).toContain("Guest-list application — eligible tickets free after approval");
    expect(panel).toContain("add-ons remain payable");
    expect(service).toContain("Guest-list codes discount tickets only");
  });

  it("sends a zero-total guest-list request to its mandatory form", () => {
    const route = source("src/app/api/checkout/create/route.ts");
    const service = source("src/lib/post-approval/guestlist-service.ts");
    expect(route).toContain("createZeroPaymentGuestlistOrder");
    expect(route).toContain('provider: "guestlist"');
    expect(route).toContain("/account/applications/");
    expect(service).toContain("activateGuestlistApplication(order.id)");
  });

  it("keeps a remaining add-on total on the paid approval path", () => {
    const route = source("src/app/api/checkout/create/route.ts");
    const policy = source("src/lib/promos/policy.ts");
    const admin = source("src/components/admin/PostCheckoutApplicationsPanel.tsx");
    expect(route).toContain("zeroPaymentGuestlist");
    expect(route).toContain("createPostCheckoutOrder(user, payload)");
    expect(route).toContain("createCheckoutForOrder");
    expect(policy).toContain('return item.kind === "ticket"');
    expect(admin).toContain('guestlist ? "Authorised add-ons" : "Authorised amount"');
    expect(admin).toContain('noPaymentGuestlist ? "Approve and issue ticket" : "Approve and capture"');
    expect(admin).toContain('item.paymentStatus === "authorized"');
  });

  it("requires approve or reject before ticket fulfilment", () => {
    const adminRoute = source("src/app/api/admin/post-checkout/route.ts");
    const service = source("src/lib/post-approval/guestlist-service.ts");
    const migration = source("supabase/migrations/20260731000039_guestlist_application_promos.sql");
    expect(adminRoute).toContain("decideGuestlistApplication");
    expect(service).toContain("requestGuestlistDecision");
    expect(service).toContain("fulfilNormalizedOrder");
    expect(migration).toContain("POST_APPROVAL_FORM_REQUIRED");
    expect(migration).toContain("GUESTLIST_APPLICATION_RELEASED");
  });

  it("uses a durable no-payment application state", () => {
    const migration = source("supabase/migrations/20260731000039_guestlist_application_promos.sql");
    const types = source("src/lib/post-approval/types.ts");
    expect(types).toContain('| "not_required"');
    expect(migration).toContain("payment_status = 'not_required'");
    expect(migration).toContain("GUESTLIST_STRIPE_REFERENCE_INVALID");
  });

  it("never sends card-authorisation copy for a no-payment guest-list order", () => {
    const email = source("src/lib/email/index.ts");
    const guestlistService = source("src/lib/post-approval/guestlist-service.ts");
    expect(email).toContain("isNoPaymentGuestlistOrder");
    expect(email).toContain('Number(order.total_cents) === 0 && String(promo.discount_type) === "guestlist"');
    expect(email).toContain('templateKey: "admin_manual_message"');
    expect(email).toContain("No payment is required for this ticket-only guest-list request");
    expect(email).toContain("no payment was taken");
    expect(guestlistService).toContain('idempotencyKey: `guestlist_form_required:${input.applicationId}`');
    expect(guestlistService).toContain('idempotencyKey: `guestlist_rejected:${input.applicationId}`');
  });

  it("notifies customers when no-payment guest-list forms or reviews expire", () => {
    const store = source("src/lib/post-approval/guestlist-store.ts");
    expect(store).toContain("queueGuestlistExpiryNotification");
    expect(store).toContain('reason === "form_expired"');
    expect(store).toContain('idempotencyKey: `guestlist_${reason}:${applicationId}`');
    expect(store).toContain(".catch(() => undefined)");
  });

  it("fails closed until the new and existing readiness contracts pass", () => {
    const readiness = source("src/lib/post-approval/readiness.ts");
    const migration39 = source("supabase/migrations/20260731000039_guestlist_application_promos.sql");
    const migration40 = source("supabase/migrations/20260731000040_guestlist_schema_health_compatibility.sql");
    expect(readiness).toContain("REQUIRED_GUESTLIST_APPLICATION_SCHEMA_VERSION = 39");
    expect(readiness).toContain("assertGuestlistApprovalSchemaReady");
    expect(migration39).toContain("skie_guestlist_application_schema_health");
    expect(migration40).toContain("skie_post_checkout_schema_health_v35");
    expect(migration40).toContain("standardPromoTrackingGuard");
  });
});
