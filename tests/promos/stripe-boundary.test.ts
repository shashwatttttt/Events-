import { describe, expect, it } from "vitest";
import { buildStripeLineItems } from "@/lib/payments";
import type { Order } from "@/types/site";

function order(overrides: Partial<Order> = {}): Order {
  return { id: "order", eventId: "event", userId: "user", status: "pending", currency: "AUD", subtotalCents: 3_500,
    discountCents: 375, totalCents: 3_125, items: [
      { kind: "ticket", referenceId: "ticket", name: "Ticket", quantity: 3, unitPriceCents: 1_000 },
      { kind: "product", referenceId: "extra", name: "Extra", quantity: 1, unitPriceCents: 500 },
    ], idempotencyKey: "idem", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T01:00:00Z", ...overrides };
}

describe("discounted Stripe boundary", () => {
  it("sends only server-generated aggregate amounts equal to the final order", () => {
    const lines = buildStripeLineItems(order());
    expect(lines.reduce((sum, line) => sum + line.quantity * line.price_data.unit_amount, 0)).toBe(3_125);
    expect(lines[0].price_data.product_data.metadata).toMatchObject({ original_quantity: "3" });
  });
  it("keeps a tracking-only order at the exact full total", () => {
    const lines = buildStripeLineItems(order({
      discountCents: 0,
      totalCents: 3_500,
      promoCodeId: "promoter",
      promoCodeSnapshot: "ADI",
    }));
    expect(lines.reduce((sum, line) => sum + line.quantity * line.price_data.unit_amount, 0)).toBe(3_500);
  });

  it("omits a fully discounted eligible line without producing negative amounts", () => {
    const current = order({ subtotalCents: 3_500, totalCents: 500, discountCents: 3_000 });
    const lines = buildStripeLineItems(current, [
      { kind: "ticket", referenceId: "ticket", discountCents: 3_000 },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].price_data.unit_amount).toBe(500);
    expect(lines[0].price_data.product_data.metadata.reference_id).toBe("extra");
  });
  it("rejects a tampered total snapshot", () => expect(() => buildStripeLineItems(order({ totalCents: 3_124 }))).toThrow("ORDER_DISCOUNT_SNAPSHOT_INVALID"));
});
