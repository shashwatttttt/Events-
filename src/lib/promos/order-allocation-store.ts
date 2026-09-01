import "server-only";

import { config } from "@/lib/config";
import {
  allocatePromoDiscount,
  promoLineKey,
  validatePromoDiscountAllocation,
  type PromoDiscountAllocation,
} from "@/lib/promos/allocation";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Order } from "@/types/site";

function mapStoredAllocation(value: unknown): PromoDiscountAllocation[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    return {
      kind: String(row.kind) as "ticket" | "product",
      referenceId: String(row.reference_id || row.referenceId || ""),
      discountCents: Number(row.discount_cents ?? row.discountCents ?? 0),
    };
  });
}

async function fallbackEligibleKeys(order: Order) {
  if (!order.promoCodeId || config.dataProvider !== "supabase") return undefined;
  const { data, error } = await createSupabaseAdminClient().from("promo_codes")
    .select("ticket_type_ids,product_ids")
    .eq("id", order.promoCodeId)
    .maybeSingle();
  if (error || !data) return undefined;
  const ticketIds = Array.isArray(data.ticket_type_ids) ? data.ticket_type_ids.map(String) : [];
  const productIds = Array.isArray(data.product_ids) ? data.product_ids.map(String) : [];
  if (!ticketIds.length && !productIds.length) return undefined;
  return new Set([
    ...ticketIds.map((referenceId) => promoLineKey({ kind: "ticket", referenceId })),
    ...productIds.map((referenceId) => promoLineKey({ kind: "product", referenceId })),
  ]);
}

export async function loadOrderDiscountAllocation(order: Order) {
  const discountCents = order.discountCents || 0;
  if (discountCents === 0) return [];

  if (config.dataProvider === "supabase") {
    const { data, error } = await createSupabaseAdminClient().from("orders")
      .select("discount_allocation")
      .eq("id", order.id)
      .maybeSingle();
    if (!error && data) {
      const stored = mapStoredAllocation(data.discount_allocation);
      if (stored.length) return validatePromoDiscountAllocation(order.items, discountCents, stored);
    }
  }

  // Migration-rollout and local compatibility fallback. The authoritative
  // total still comes from the reservation RPC; this only determines which
  // eligible Stripe line displays that already-verified discount.
  return allocatePromoDiscount({
    items: order.items,
    discountCents,
    eligibleKeys: await fallbackEligibleKeys(order),
  });
}
