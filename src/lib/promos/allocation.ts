import type { CartItem } from "@/types/site";

export type PromoDiscountAllocation = {
  kind: "ticket" | "product";
  referenceId: string;
  discountCents: number;
};

export function promoLineKey(item: Pick<CartItem, "kind" | "referenceId">) {
  return `${item.kind}:${item.referenceId}`;
}

export function allocatePromoDiscount(input: {
  items: CartItem[];
  discountCents: number;
  eligibleKeys?: Set<string>;
}): PromoDiscountAllocation[] {
  if (!Number.isSafeInteger(input.discountCents) || input.discountCents < 0) {
    throw new Error("ORDER_DISCOUNT_ALLOCATION_INVALID");
  }
  if (input.discountCents === 0) return [];
  const eligible = input.items
    .map((item) => ({ item, lineCents: item.quantity * item.unitPriceCents }))
    .filter(({ item, lineCents }) => lineCents > 0
      && (!input.eligibleKeys || input.eligibleKeys.has(promoLineKey(item))));
  let remainingEligible = eligible.reduce((sum, line) => sum + line.lineCents, 0);
  if (remainingEligible < input.discountCents || remainingEligible <= 0) {
    throw new Error("ORDER_DISCOUNT_ALLOCATION_INVALID");
  }
  let remainingDiscount = input.discountCents;
  const allocation: PromoDiscountAllocation[] = [];
  for (const [index, line] of eligible.entries()) {
    const final = index === eligible.length - 1;
    const lineDiscount = final
      ? remainingDiscount
      : Math.min(
        line.lineCents,
        Math.floor((remainingDiscount * line.lineCents) / remainingEligible),
      );
    if (lineDiscount > 0) {
      allocation.push({
        kind: line.item.kind,
        referenceId: line.item.referenceId,
        discountCents: lineDiscount,
      });
    }
    remainingDiscount -= lineDiscount;
    remainingEligible -= line.lineCents;
  }
  if (remainingDiscount !== 0) throw new Error("ORDER_DISCOUNT_ALLOCATION_INVALID");
  return allocation;
}

export function validatePromoDiscountAllocation(
  items: CartItem[],
  discountCents: number,
  allocation: PromoDiscountAllocation[],
) {
  if (!Array.isArray(allocation)) throw new Error("ORDER_DISCOUNT_ALLOCATION_INVALID");
  const lines = new Map(items.map((item) => [promoLineKey(item), item]));
  const seen = new Set<string>();
  let total = 0;
  for (const allocated of allocation) {
    const key = promoLineKey(allocated);
    const item = lines.get(key);
    if (!item || seen.has(key)
      || !Number.isSafeInteger(allocated.discountCents)
      || allocated.discountCents <= 0
      || allocated.discountCents > item.quantity * item.unitPriceCents) {
      throw new Error("ORDER_DISCOUNT_ALLOCATION_INVALID");
    }
    seen.add(key);
    total += allocated.discountCents;
  }
  if (total !== discountCents || (discountCents === 0 && allocation.length > 0)) {
    throw new Error("ORDER_DISCOUNT_ALLOCATION_INVALID");
  }
  return allocation;
}
