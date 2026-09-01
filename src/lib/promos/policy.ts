import type { CartItem, PromoCode } from "@/types/site";

export const PROMO_TIMEZONE = "Australia/Melbourne";

export type PromoRejectionCode =
  | "PROMO_NOT_FOUND"
  | "PROMO_NOT_AVAILABLE"
  | "PROMO_NOT_STARTED"
  | "PROMO_EXPIRED"
  | "PROMO_MINIMUM_NOT_MET"
  | "PROMO_EVENT_RESTRICTED"
  | "PROMO_ITEMS_NOT_ELIGIBLE"
  | "PROMO_FIRST_PURCHASE_ONLY"
  | "PROMO_REDEMPTION_LIMIT"
  | "PROMO_TICKET_UNIT_LIMIT"
  | "PROMO_CUSTOMER_LIMIT";

const rejectionMessages: Record<PromoRejectionCode, string> = {
  PROMO_NOT_FOUND: "That promo code is not recognised.",
  PROMO_NOT_AVAILABLE: "That promo code is not currently available.",
  PROMO_NOT_STARTED: "That promo code is not available yet.",
  PROMO_EXPIRED: "That promo code has expired.",
  PROMO_MINIMUM_NOT_MET: "This order does not meet the promo minimum.",
  PROMO_EVENT_RESTRICTED: "That promo code is not valid for this event.",
  PROMO_ITEMS_NOT_ELIGIBLE: "That promo code does not apply to these items.",
  PROMO_FIRST_PURCHASE_ONLY: "That promo code is only available for a first purchase.",
  PROMO_REDEMPTION_LIMIT: "That promo code has reached its usage limit.",
  PROMO_TICKET_UNIT_LIMIT: "That promo code has reached its attributed-ticket limit.",
  PROMO_CUSTOMER_LIMIT: "You have already used that promo code the maximum number of times.",
};

export class PromoPolicyError extends Error {
  constructor(public readonly code: PromoRejectionCode) {
    super(rejectionMessages[code]);
    this.name = "PromoPolicyError";
  }
}

export function normalizePromoCode(value: string) {
  return value.trim().toUpperCase();
}

export type PromoUsage = {
  redemptions: number;
  discountedTicketUnits: number;
  customerRedemptions: number;
  customerHasPriorPurchase: boolean;
};

export type PromoQuote = {
  promoCodeId: string;
  code: string;
  subtotalCents: number;
  eligibleSubtotalCents: number;
  discountCents: number;
  totalCents: number;
  discountedTicketUnits: number;
  trackingOnly: boolean;
  guestlistApplication: boolean;
};

export function calculatePromoQuote(input: {
  promo: PromoCode;
  eventId: string;
  items: CartItem[];
  usage?: PromoUsage;
  now?: Date;
}): PromoQuote {
  const { promo, eventId, items } = input;
  const now = (input.now || new Date()).getTime();
  const usage = input.usage || {
    redemptions: 0,
    discountedTicketUnits: 0,
    customerRedemptions: 0,
    customerHasPriorPurchase: false,
  };
  const discountType = String(promo.discountType);
  const guestlistApplication = discountType === "guestlist";

  if (!promo.active || promo.status !== "active") throw new PromoPolicyError("PROMO_NOT_AVAILABLE");
  if (promo.validFrom && new Date(promo.validFrom).getTime() > now) throw new PromoPolicyError("PROMO_NOT_STARTED");
  if (promo.expiresAt && new Date(promo.expiresAt).getTime() <= now) throw new PromoPolicyError("PROMO_EXPIRED");
  if (promo.eventIds.length && !promo.eventIds.includes(eventId)) throw new PromoPolicyError("PROMO_EVENT_RESTRICTED");

  const subtotalCents = items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
  if (subtotalCents < promo.minimumOrderCents) throw new PromoPolicyError("PROMO_MINIMUM_NOT_MET");
  if (promo.firstPurchaseOnly && usage.customerHasPriorPurchase) throw new PromoPolicyError("PROMO_FIRST_PURCHASE_ONLY");
  if (promo.maxRedemptions !== undefined && usage.redemptions >= promo.maxRedemptions) throw new PromoPolicyError("PROMO_REDEMPTION_LIMIT");
  if (promo.maxUsesPerCustomer !== undefined && usage.customerRedemptions >= promo.maxUsesPerCustomer) throw new PromoPolicyError("PROMO_CUSTOMER_LIMIT");

  const hasLineRestrictions = guestlistApplication
    ? promo.ticketTypeIds.length > 0
    : promo.ticketTypeIds.length > 0 || promo.productIds.length > 0;
  const eligibleItems = items.filter((item) => {
    if (guestlistApplication) {
      return item.kind === "ticket"
        && (!hasLineRestrictions || promo.ticketTypeIds.includes(item.referenceId));
    }
    return !hasLineRestrictions
      || (item.kind === "ticket" && promo.ticketTypeIds.includes(item.referenceId))
      || (item.kind === "product" && promo.productIds.includes(item.referenceId));
  });
  const eligibleSubtotalCents = eligibleItems.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
  const trackingOnly = discountType === "tracking";
  if (!eligibleItems.length || (!trackingOnly && eligibleSubtotalCents <= 0)) {
    throw new PromoPolicyError("PROMO_ITEMS_NOT_ELIGIBLE");
  }

  const attributedTicketUnits = eligibleItems
    .filter((item) => item.kind === "ticket")
    .reduce((sum, item) => sum + item.quantity, 0);
  const capacityUnits = attributedTicketUnits
    || items.filter((item) => item.kind === "ticket").reduce((sum, item) => sum + item.quantity, 0);
  if (promo.maxDiscountedTicketUnits !== undefined
    && usage.discountedTicketUnits + capacityUnits > promo.maxDiscountedTicketUnits) {
    throw new PromoPolicyError("PROMO_TICKET_UNIT_LIMIT");
  }

  const rawDiscount = trackingOnly
    ? 0
    : guestlistApplication
      ? eligibleSubtotalCents
      : discountType === "percentage"
        ? Math.round((eligibleSubtotalCents * Math.round((promo.percentOff || 0) * 100)) / 10_000)
        : promo.amountOffCents || 0;
  const discountCents = Math.min(eligibleSubtotalCents, Math.max(0, rawDiscount));
  if (!trackingOnly && discountCents <= 0) throw new PromoPolicyError("PROMO_NOT_AVAILABLE");

  return {
    promoCodeId: promo.id,
    code: promo.code,
    subtotalCents,
    eligibleSubtotalCents,
    discountCents,
    totalCents: Math.max(0, subtotalCents - discountCents),
    discountedTicketUnits: capacityUnits,
    trackingOnly,
    guestlistApplication,
  };
}

function offsetAt(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PROMO_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - date.getTime();
}

export function melbourneLocalToIso(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("INVALID_MELBOURNE_DATETIME");
  const wallClock = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
  let instant = new Date(wallClock);
  instant = new Date(wallClock - offsetAt(instant));
  instant = new Date(wallClock - offsetAt(instant));
  return instant.toISOString();
}
