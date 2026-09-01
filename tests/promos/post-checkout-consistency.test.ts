import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStripeLineItems } from "@/lib/payments";
import {
  checkoutOrderPayloadSchema,
  orderPayloadSchema,
  promoExpectationMatches,
} from "@/lib/validate";
import type { Order } from "@/types/site";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const baseCart = {
  eventId: "house",
  ticketTypeId: "general",
  ticketQuantity: 1,
  products: [],
};

const expectation = {
  code: "HOUSE10",
  subtotalCents: 1499,
  discountCents: 150,
  totalCents: 1349,
  trackingOnly: false,
  guestlistApplication: false,
};

function discountedOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-promo",
    eventId: "house",
    userId: "customer",
    status: "pending",
    currency: "AUD",
    subtotalCents: 1499,
    discountCents: 150,
    totalCents: 1349,
    promoCodeId: "promo-id",
    promoCodeSnapshot: "HOUSE10",
    items: [{
      kind: "ticket",
      referenceId: "general",
      name: "HOUSE ARREST",
      quantity: 1,
      unitPriceCents: 1499,
    }],
    idempotencyKey: "promo-idempotency",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    expiresAt: "2026-07-24T01:00:00.000Z",
    ...overrides,
  };
}

describe("post-checkout promo consistency", () => {
  it("allows the quote endpoint request without a prior expectation", () => {
    expect(orderPayloadSchema.parse({ ...baseCart, promoCode: "house10" })).toMatchObject({
      promoCode: "HOUSE10",
    });
  });

  it("requires an applied quote for checkout when a promo code is supplied", () => {
    expect(() => checkoutOrderPayloadSchema.parse({
      ...baseCart,
      promoCode: "HOUSE10",
    })).toThrow("Apply the promo code again before checkout.");
  });

  it("accepts only matching and arithmetically valid promo expectations", () => {
    expect(checkoutOrderPayloadSchema.parse({
      ...baseCart,
      promoCode: "house10",
      promoExpectation: expectation,
    })).toMatchObject({ promoCode: "HOUSE10", promoExpectation: expectation });

    expect(() => checkoutOrderPayloadSchema.parse({
      ...baseCart,
      promoCode: "HOUSE10",
      promoExpectation: { ...expectation, totalCents: 1499 },
    })).toThrow("The promo quote totals are invalid.");
  });

  it("accepts a bound zero-discount tracking expectation", () => {
    const tracking = {
      code: "PROMOTER",
      subtotalCents: 1499,
      discountCents: 0,
      totalCents: 1499,
      trackingOnly: true,
      guestlistApplication: false,
    };
    expect(checkoutOrderPayloadSchema.parse({
      ...baseCart,
      promoCode: "PROMOTER",
      promoExpectation: tracking,
    })).toMatchObject({ promoExpectation: tracking });
    expect(promoExpectationMatches(tracking, tracking)).toBe(true);
  });

  it("compares the displayed quote to the reserved order exactly", () => {
    expect(promoExpectationMatches(expectation, expectation)).toBe(true);
    expect(promoExpectationMatches(expectation, { ...expectation, totalCents: 1350 })).toBe(false);
    expect(promoExpectationMatches(expectation, { ...expectation, code: "OTHER" })).toBe(false);
  });

  it("authorises Stripe for the discounted total, never the subtotal", () => {
    const lineItems = buildStripeLineItems(discountedOrder());
    expect(lineItems.reduce(
      (sum, line) => sum + line.quantity * line.price_data.unit_amount,
      0,
    )).toBe(1349);
  });

  it("rejects a tampered promo order before Stripe", () => {
    expect(() => buildStripeLineItems(discountedOrder({ totalCents: 1499 })))
      .toThrow("ORDER_DISCOUNT_SNAPSHOT_INVALID");
  });

  it("prevents a stale full-price Stripe session from resuming a discounted cart", () => {
    const resumeSource = source("src/lib/post-approval/resume.ts");
    expect(resumeSource).toContain("selectionsMatch(requested, existingSelection)");
    expect(resumeSource).toContain("expireStripeCheckoutSession(sessionId)");
    expect(resumeSource).toContain("POST_APPROVAL_CART_CHANGED");
    expect(resumeSource).toContain("restartUnpaidPostCheckout(orderId, reason)");
  });

  it("binds the browser quote to every server checkout request", () => {
    const checkoutSource = source("src/components/CheckoutBuilder.tsx");
    const routeSource = source("src/app/api/checkout/create/route.ts");
    expect(checkoutSource).toContain("promoExpectation:");
    expect(checkoutSource).toContain("trackingOnly");
    expect(checkoutSource).toContain("guestlistApplication");
    expect(checkoutSource).toContain("promoNeedsApply");
    expect(checkoutSource).toContain("Apply the promo code and wait for the confirmed total before continuing.");
    expect(checkoutSource).toContain("disabled={busy || promoBusy || promoNeedsApply}");
    expect(routeSource).toContain("checkoutOrderPayloadSchema.parse(raw)");
    expect(routeSource).toContain("promoSnapshotIsCurrent");
    expect(routeSource).toContain("releaseCheckoutBeforeProvider(order)");
    expect(routeSource).toContain("restartUnpaidPostCheckout(prepared.order.id");
  });

  it("normalizes an absent guest-list expectation to false before comparing promo purpose", () => {
    const routeSource = source("src/app/api/checkout/create/route.ts");
    expect(routeSource).toContain(
      '(payload.promoExpectation?.guestlistApplication === true) !== (promoType === "guestlist")',
    );
    expect(routeSource).not.toContain(
      'payload.promoExpectation?.guestlistApplication !== (promoType === "guestlist")',
    );
  });

  it("releases reserved promo usage on every unpaid or cancelled terminal path", () => {
    const migration = source(
      "supabase/migrations/20260724000018_post_checkout_promo_consistency.sql",
    );
    expect(migration).toContain("skie_restart_unpaid_post_checkout");
    expect(migration).toContain("skie_fail_post_checkout_initialization");
    expect(migration).toContain("skie_mark_post_checkout_cancelled");
    expect((migration.match(/update public\.promo_redemptions/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(migration).toContain("status = 'released'");
    expect(migration).toContain("promoReleaseGuard");
  });

  it("persists and enforces one promo activation state", () => {
    const promoService = source("src/lib/promos/service.ts");
    const activationMigration = source(
      "supabase/migrations/20260724000019_promo_activation_integrity.sql",
    );
    expect(promoService).toContain("active: input.active");
    expect(promoService).toContain("discount_type: input.discountType");
    expect(promoService).toContain("status: input.status");
    expect(activationMigration).toContain("active = (status = 'active')");
    expect(activationMigration).toContain("promo_codes_active_status_check");
    expect(activationMigration).toContain("promoActivationGuard");
  });
});
