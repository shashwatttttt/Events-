import { describe, expect, it } from "vitest";
import { promoAdminSchema } from "@/lib/promos/service";
import { orderPayloadSchema, promoExpectationSchema } from "@/lib/validate";

const admin = { code: "LAUNCH10", internalName: "Launch", description: "", active: true, discountType: "percentage" as const, percentOff: 10,
  amountOffCents: null, validFrom: null, expiresAt: null, maxRedemptions: 10, maxDiscountedTicketUnits: 20, maxUsesPerCustomer: 1,
  minimumOrderCents: 1000, firstPurchaseOnly: false, eventIds: [], ticketTypeIds: [], productIds: [], status: "active" as const };

describe("promo route schemas", () => {
  it("accepts a valid admin promo", () => expect(promoAdminSchema.parse(admin).code).toBe("LAUNCH10"));
  it("accepts tracking-only codes with no monetary discount", () => {
    expect(promoAdminSchema.parse({
      ...admin,
      discountType: "tracking",
      percentOff: null,
      amountOffCents: null,
    })).toMatchObject({ discountType: "tracking" });
  });

  it("accepts a guest-list application code without product scope", () => {
    expect(promoAdminSchema.parse({
      ...admin,
      discountType: "guestlist",
      percentOff: null,
      amountOffCents: null,
      minimumOrderCents: 0,
      ticketTypeIds: ["guest-ticket"],
      productIds: [],
    })).toMatchObject({ discountType: "guestlist", productIds: [] });
  });

  it("rejects guest-list codes that attempt to discount add-ons", () => {
    expect(() => promoAdminSchema.parse({
      ...admin,
      discountType: "guestlist",
      percentOff: null,
      amountOffCents: null,
      productIds: ["drink-pass"],
    })).toThrowError(/discount tickets only/i);
  });

  it("binds guest-list intent to a mathematically valid promo quote", () => {
    expect(promoExpectationSchema.parse({
      code: "GUESTLIST",
      subtotalCents: 4998,
      discountCents: 3998,
      totalCents: 1000,
      trackingOnly: false,
      guestlistApplication: true,
    })).toMatchObject({ guestlistApplication: true, totalCents: 1000 });
    expect(() => promoExpectationSchema.parse({
      code: "GUESTLIST",
      subtotalCents: 1999,
      discountCents: 1999,
      totalCents: 0,
      trackingOnly: true,
      guestlistApplication: true,
    })).toThrow();
  });

  it("rejects inconsistent and malformed admin payloads", () => {
    expect(() => promoAdminSchema.parse({ ...admin, status: "inactive" })).toThrow();
    expect(() => promoAdminSchema.parse({ ...admin, code: "../../coupon" })).toThrow();
    expect(() => promoAdminSchema.parse({ ...admin, percentOff: 100.01 })).toThrow();
    expect(() => promoAdminSchema.parse({ ...admin, discountType: "tracking", percentOff: null, amountOffCents: 1 })).toThrow();
  });
  it("rejects browser-supplied prices, totals and discounts", () => {
    const base = { eventId: "event", ticketTypeId: "ticket", ticketQuantity: 1, products: [], promoCode: "LAUNCH10" };
    expect(() => orderPayloadSchema.parse({ ...base, totalCents: 1 })).toThrow();
    expect(() => orderPayloadSchema.parse({ ...base, discountCents: 99999 })).toThrow();
    expect(() => orderPayloadSchema.parse({ ...base, priceCents: 1 })).toThrow();
  });
});
