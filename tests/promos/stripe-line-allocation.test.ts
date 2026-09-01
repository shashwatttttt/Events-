import { describe, expect, it } from "vitest";
import { buildStripeLineItems } from "@/lib/payments";
import {
  allocatePromoDiscount,
  promoLineKey,
  validatePromoDiscountAllocation,
} from "@/lib/promos/allocation";
import type { Order } from "@/types/site";

function order(): Order {
  return {
    id: "order-line-allocation",
    eventId: "house",
    userId: "customer",
    status: "pending",
    currency: "AUD",
    subtotalCents: 6298,
    discountCents: 480,
    totalCents: 5818,
    promoCodeId: "promo",
    promoCodeSnapshot: "DRINK10",
    items: [
      { kind: "ticket", referenceId: "entry", name: "Entry", quantity: 1, unitPriceCents: 1499 },
      { kind: "product", referenceId: "five-drinks", name: "5 Drinks Pass", quantity: 1, unitPriceCents: 4799 },
    ],
    idempotencyKey: "line-allocation",
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    expiresAt: "2026-07-27T01:00:00.000Z",
  };
}

describe("promo Stripe line allocation", () => {
  it("places a product-only discount only on the eligible add-on", () => {
    const current = order();
    const allocation = allocatePromoDiscount({
      items: current.items,
      discountCents: 480,
      eligibleKeys: new Set([promoLineKey({ kind: "product", referenceId: "five-drinks" })]),
    });
    expect(allocation).toEqual([{ kind: "product", referenceId: "five-drinks", discountCents: 480 }]);

    const lines = buildStripeLineItems(current, allocation);
    expect(lines[0].price_data.unit_amount).toBe(1499);
    expect(lines[1].price_data.unit_amount).toBe(4319);
    expect(lines[0].price_data.product_data.metadata.discount_cents).toBe("0");
    expect(lines[1].price_data.product_data.metadata.discount_cents).toBe("480");
  });

  it("distributes an unrestricted discount deterministically and preserves the exact total", () => {
    const current = order();
    const allocation = allocatePromoDiscount({ items: current.items, discountCents: 480 });
    expect(allocation.reduce((sum, item) => sum + item.discountCents, 0)).toBe(480);
    expect(buildStripeLineItems(current, allocation).reduce(
      (sum, item) => sum + item.price_data.unit_amount,
      0,
    )).toBe(current.totalCents);
  });

  it("rejects duplicate, excessive or incomplete snapshots", () => {
    const current = order();
    expect(() => validatePromoDiscountAllocation(current.items, 480, [
      { kind: "product", referenceId: "five-drinks", discountCents: 240 },
      { kind: "product", referenceId: "five-drinks", discountCents: 240 },
    ])).toThrow("ORDER_DISCOUNT_ALLOCATION_INVALID");
    expect(() => validatePromoDiscountAllocation(current.items, 480, [
      { kind: "ticket", referenceId: "entry", discountCents: 1500 },
    ])).toThrow("ORDER_DISCOUNT_ALLOCATION_INVALID");
    expect(() => validatePromoDiscountAllocation(current.items, 480, [
      { kind: "product", referenceId: "five-drinks", discountCents: 479 },
    ])).toThrow("ORDER_DISCOUNT_ALLOCATION_INVALID");
  });

  it("persists and guards the same allocation in migration 33", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const migration = readFileSync(join(process.cwd(), "supabase/migrations/20260727000033_promo_line_discount_allocation.sql"), "utf8");
    const store = readFileSync(join(process.cwd(), "src/lib/promos/order-allocation-store.ts"), "utf8");

    expect(migration).toContain("discount_allocation jsonb");
    expect(migration).toContain("skie_build_promo_discount_allocation");
    expect(migration).toContain("orders_discount_allocation_guard");
    expect(migration).toContain("ORDER_DISCOUNT_ALLOCATION_IMMUTABLE");
    expect(store).toContain('select("discount_allocation")');
    expect(store).toContain("allocatePromoDiscount");
  });
});
