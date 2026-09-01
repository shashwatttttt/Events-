import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

describe("promo tracking and Stripe integrity", () => {
  it("keeps tracking codes durable through the database reservation path", () => {
    const migration = source("supabase/migrations/20260725000023_promo_tracking_integrity.sql");
    expect(migration).toContain("discount_type in ('percentage','fixed','tracking')");
    expect(migration).toContain("v_discount := 0");
    expect(migration).toContain("skie_claim_promo_usage");
    expect(migration).toContain("promo_tracking_rpc_guard");
    expect(migration).toContain("select\n    23,");
  });

  it("binds immutable pricing, line allocation and promo attribution into Stripe", () => {
    const payments = source("src/lib/payments/index.ts");
    expect(payments).toContain("const discountAllocation = await loadOrderDiscountAllocation(order)");
    expect(payments).toContain("line_items: buildStripeLineItems(order, discountAllocation)");
    expect(payments).toContain("expected_total_cents: String(order.totalCents)");
    expect(payments).toContain("promo_code_id: order.promoCodeId");
    expect(payments).toContain("discount_cents: String(order.discountCents || 0)");
  });

  it("shows promoter attribution and pricing integrity during approval", () => {
    const store = source("src/lib/post-approval/store.ts");
    const panel = source("src/components/admin/PostCheckoutApplicationsPanel.tsx");
    expect(store).toContain("promo_codes");
    expect(store).toContain("pricingIntegrity");
    expect(panel).toContain("Promoter tracking code");
    expect(panel).toContain("Pricing snapshot mismatch");
  });
});
