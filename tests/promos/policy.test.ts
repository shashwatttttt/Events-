import { describe, expect, it } from "vitest";
import { calculatePromoQuote, normalizePromoCode, PromoPolicyError } from "@/lib/promos/policy";
import type { CartItem, PromoCode } from "@/types/site";

const items: CartItem[] = [
  { kind: "ticket", referenceId: "ticket-a", name: "Ticket", quantity: 3, unitPriceCents: 999 },
  { kind: "product", referenceId: "product-a", name: "Extra", quantity: 2, unitPriceCents: 250 },
];
const base: PromoCode = {
  id: "promo-1", code: "SKIE10", internalName: "Test", description: "", active: true,
  discountType: "percentage", percentOff: 10, currency: "AUD", minimumOrderCents: 0,
  firstPurchaseOnly: false, eventIds: [], ticketTypeIds: [], productIds: [], status: "active",
  createdBy: "admin", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};
const guestlistType = "guestlist" as PromoCode["discountType"];

describe("promo policy", () => {
  it("keeps add-ons payable for guest-list tickets", () => {
    const result = calculatePromoQuote({
      promo: { ...base, discountType: guestlistType, percentOff: undefined, ticketTypeIds: ["ticket-a"] },
      eventId: "event-a", items, now: new Date("2026-07-22T00:00:00Z"),
    });
    expect(result).toMatchObject({ discountCents: 2997, totalCents: 500, guestlistApplication: true });
  });
  it("supports tracking-only attribution", () => {
    const result = calculatePromoQuote({
      promo: { ...base, discountType: "tracking", percentOff: undefined }, eventId: "event-a", items,
    });
    expect(result.trackingOnly).toBe(true);
  });
  it("enforces eligible ticket scope", () => {
    expect(() => calculatePromoQuote({
      promo: { ...base, ticketTypeIds: ["other"] }, eventId: "event-a", items,
    })).toThrowError(expect.objectContaining({ code: "PROMO_ITEMS_NOT_ELIGIBLE" }));
  });
  it("normalizes codes and exposes stable errors", () => {
    expect(normalizePromoCode(" skie_10-a ")).toBe("SKIE_10-A");
    expect(new PromoPolicyError("PROMO_NOT_FOUND")).toMatchObject({ code: "PROMO_NOT_FOUND" });
  });
});
