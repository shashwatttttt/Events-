import "server-only";

import { z } from "zod";
import { config } from "@/lib/config";
import { mutateOperationsData, readOperationsData, readSiteData } from "@/lib/data/documents";
import { hasEventPasswordAccess } from "@/lib/event-access";
import { canStartCheckout, isSalesWindowOpen } from "@/lib/event-state";
import { PublicApiError } from "@/lib/http";
import { getNormalizedAllocation } from "@/lib/payments/transaction-store";
import { POST_CHECKOUT_MODE } from "@/lib/post-approval/types";
import { calculatePromoQuote, normalizePromoCode, PromoPolicyError, type PromoQuote, type PromoUsage } from "@/lib/promos/policy";
import { randomId } from "@/lib/security/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { CartItem, PromoCode, PromoRedemption, SessionUser, TicketAllocation } from "@/types/site";

const optionalPositive = z.number().int().positive().max(1_000_000).nullable().optional();
const PROMO_PAGE_SIZE = 1_000;

export type PromoDiscountType = "percentage" | "fixed" | "tracking" | "guestlist";

export const promoAdminSchema = z.object({
  id: z.string().uuid().optional(),
  code: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  internalName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(""),
  active: z.boolean(),
  discountType: z.enum(["percentage", "fixed", "tracking", "guestlist"]),
  percentOff: z.number().positive().max(100).multipleOf(0.01).nullable().optional(),
  amountOffCents: z.number().int().positive().max(10_000_000).nullable().optional(),
  validFrom: z.string().datetime({ offset: true }).nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  maxRedemptions: optionalPositive,
  maxDiscountedTicketUnits: optionalPositive,
  maxUsesPerCustomer: optionalPositive,
  minimumOrderCents: z.number().int().min(0).max(100_000_000),
  firstPurchaseOnly: z.boolean(),
  eventIds: z.array(z.string().min(1).max(100)).max(100),
  ticketTypeIds: z.array(z.string().min(1).max(100)).max(100),
  productIds: z.array(z.string().min(1).max(100)).max(100),
  status: z.enum(["draft", "active", "inactive"]),
}).strict().superRefine((value, context) => {
  if (value.discountType === "percentage" && !value.percentOff) context.addIssue({ code: "custom", message: "Percentage discount is required.", path: ["percentOff"] });
  if (value.discountType === "percentage" && value.amountOffCents) context.addIssue({ code: "custom", message: "Fixed amount is not allowed for a percentage promo.", path: ["amountOffCents"] });
  if (value.discountType === "fixed" && !value.amountOffCents) context.addIssue({ code: "custom", message: "Fixed discount is required.", path: ["amountOffCents"] });
  if (value.discountType === "fixed" && value.percentOff) context.addIssue({ code: "custom", message: "Percentage is not allowed for a fixed promo.", path: ["percentOff"] });
  if (["tracking", "guestlist"].includes(value.discountType) && (value.percentOff || value.amountOffCents)) {
    context.addIssue({ code: "custom", message: "This code purpose cannot include a manual discount value.", path: ["discountType"] });
  }
  if (value.discountType === "guestlist" && value.productIds.length) {
    context.addIssue({ code: "custom", message: "Guest-list codes discount tickets only. Remove all products/add-ons from the code scope.", path: ["productIds"] });
  }
  if (value.validFrom && value.expiresAt && new Date(value.expiresAt) <= new Date(value.validFrom)) context.addIssue({ code: "custom", message: "Expiry must be after the start date.", path: ["expiresAt"] });
  if (value.active !== (value.status === "active")) context.addIssue({ code: "custom", message: "Active state and status must agree.", path: ["status"] });
});

function mapPromo(row: Record<string, unknown>): PromoCode {
  const textArray = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
  return {
    id: String(row.id), code: String(row.code), internalName: String(row.internal_name), description: String(row.description || ""),
    active: Boolean(row.active), discountType: String(row.discount_type) as PromoCode["discountType"],
    percentOff: row.percent_off === null || row.percent_off === undefined ? undefined : Number(row.percent_off),
    amountOffCents: row.amount_off_cents === null || row.amount_off_cents === undefined ? undefined : Number(row.amount_off_cents),
    currency: "AUD", validFrom: row.valid_from ? String(row.valid_from) : undefined, expiresAt: row.expires_at ? String(row.expires_at) : undefined,
    maxRedemptions: row.max_redemptions === null || row.max_redemptions === undefined ? undefined : Number(row.max_redemptions),
    maxDiscountedTicketUnits: row.max_discounted_ticket_units === null || row.max_discounted_ticket_units === undefined ? undefined : Number(row.max_discounted_ticket_units),
    maxUsesPerCustomer: row.max_uses_per_customer === null || row.max_uses_per_customer === undefined ? undefined : Number(row.max_uses_per_customer),
    minimumOrderCents: Number(row.minimum_order_cents), firstPurchaseOnly: Boolean(row.first_purchase_only),
    eventIds: textArray(row.event_ids), ticketTypeIds: textArray(row.ticket_type_ids), productIds: textArray(row.product_ids),
    status: String(row.status) as PromoCode["status"], createdBy: String(row.created_by), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function mapRedemption(row: Record<string, unknown>): PromoRedemption {
  return {
    id: String(row.id), promoCodeId: String(row.promo_code_id), reservationId: String(row.reservation_id), orderId: String(row.order_id),
    customerId: String(row.customer_id), eventId: String(row.event_id), status: String(row.status) as PromoRedemption["status"],
    discountedTicketUnits: Number(row.discounted_ticket_units), originalSubtotalCents: Number(row.original_subtotal_cents),
    discountCents: Number(row.discount_cents), finalTotalCents: Number(row.final_total_cents), reservedUntil: String(row.reserved_until),
    finalizedAt: row.finalized_at ? String(row.finalized_at) : undefined, releasedAt: row.released_at ? String(row.released_at) : undefined,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

type SupabaseAdminClient = ReturnType<typeof createSupabaseAdminClient>;

async function listAllPromoRows(client: SupabaseAdminClient) {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PROMO_PAGE_SIZE) {
    const result = await client.from("promo_codes")
      .select("*")
      .order("created_at", { ascending: false })
      .range(from, from + PROMO_PAGE_SIZE - 1);
    if (result.error) throw new PublicApiError("PROMO_STORE_UNAVAILABLE", "Promo data is temporarily unavailable.", 503);
    const page = (result.data || []) as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < PROMO_PAGE_SIZE) return rows;
  }
}

async function listAllPromoRedemptionRows(client: SupabaseAdminClient) {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PROMO_PAGE_SIZE) {
    const result = await client.from("promo_redemptions")
      .select("*")
      .order("created_at", { ascending: false })
      .range(from, from + PROMO_PAGE_SIZE - 1);
    if (result.error) throw new PublicApiError("PROMO_STORE_UNAVAILABLE", "Promo data is temporarily unavailable.", 503);
    const page = (result.data || []) as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < PROMO_PAGE_SIZE) return rows;
  }
}

export async function listPromos() {
  if (config.dataProvider !== "supabase") {
    const ops = await readOperationsData();
    return { promos: ops.promoCodes, redemptions: ops.promoRedemptions };
  }
  const client = createSupabaseAdminClient();
  const [promos, redemptions] = await Promise.all([
    listAllPromoRows(client),
    listAllPromoRedemptionRows(client),
  ]);
  return { promos: promos.map((row) => mapPromo(row)), redemptions: redemptions.map((row) => mapRedemption(row)) };
}

export async function getPromoDiscountTypeById(promoCodeId?: string): Promise<PromoDiscountType | undefined> {
  if (!promoCodeId) return undefined;
  if (config.dataProvider !== "supabase") {
    const operations = await readOperationsData();
    const promo = operations.promoCodes.find((item) => item.id === promoCodeId);
    return promo ? String(promo.discountType) as PromoDiscountType : undefined;
  }
  const { data, error } = await createSupabaseAdminClient()
    .from("promo_codes")
    .select("discount_type")
    .eq("id", promoCodeId)
    .maybeSingle();
  if (error) throw new PublicApiError("PROMO_STORE_UNAVAILABLE", "Promo data is temporarily unavailable.", 503);
  return data?.discount_type ? String(data.discount_type) as PromoDiscountType : undefined;
}

export async function savePromo(actor: SessionUser, raw: unknown) {
  const input = promoAdminSchema.parse(raw);
  const timestamp = new Date().toISOString();
  const code = normalizePromoCode(input.code);
  if (config.dataProvider !== "supabase") {
    return mutateOperationsData((ops) => {
      const collision = ops.promoCodes.find((item) => normalizePromoCode(item.code) === code && item.id !== input.id);
      if (collision) throw new PublicApiError("PROMO_CODE_EXISTS", "That promo code is already in use.", 409);
      const existing = input.id ? ops.promoCodes.find((item) => item.id === input.id) : undefined;
      const item: PromoCode = {
        id: existing?.id || randomId("promo"), code, internalName: input.internalName, description: input.description,
        active: input.active, discountType: input.discountType as PromoCode["discountType"],
        percentOff: input.discountType === "percentage" ? input.percentOff ?? undefined : undefined,
        amountOffCents: input.discountType === "fixed" ? input.amountOffCents ?? undefined : undefined,
        currency: "AUD", validFrom: input.validFrom ?? undefined,
        expiresAt: input.expiresAt ?? undefined, maxRedemptions: input.maxRedemptions ?? undefined,
        maxDiscountedTicketUnits: input.maxDiscountedTicketUnits ?? undefined, maxUsesPerCustomer: input.maxUsesPerCustomer ?? undefined,
        minimumOrderCents: input.minimumOrderCents, firstPurchaseOnly: input.firstPurchaseOnly, eventIds: input.eventIds,
        ticketTypeIds: input.ticketTypeIds, productIds: input.discountType === "guestlist" ? [] : input.productIds, status: input.status,
        createdBy: existing?.createdBy || actor.id, createdAt: existing?.createdAt || timestamp, updatedAt: timestamp,
      };
      if (existing) Object.assign(existing, item); else ops.promoCodes.push(item);
      ops.auditLogs.push({ id: randomId("audit"), actorId: actor.id, actorEmail: actor.email, action: existing ? "promo.updated" : "promo.created", entityType: "promo", entityId: item.id, metadata: { code: item.code, status: item.status }, createdAt: timestamp });
      return item;
    });
  }
  const client = createSupabaseAdminClient();
  const mutableRecord = {
    code,
    internal_name: input.internalName,
    description: input.description,
    active: input.active,
    discount_type: input.discountType,
    percent_off: input.discountType === "percentage" ? input.percentOff : null,
    amount_off_cents: input.discountType === "fixed" ? input.amountOffCents : null,
    valid_from: input.validFrom || null,
    expires_at: input.expiresAt || null,
    max_redemptions: input.maxRedemptions || null,
    max_discounted_ticket_units: input.maxDiscountedTicketUnits || null,
    max_uses_per_customer: input.maxUsesPerCustomer || null,
    minimum_order_cents: input.minimumOrderCents,
    first_purchase_only: input.firstPurchaseOnly,
    event_ids: input.eventIds,
    ticket_type_ids: input.ticketTypeIds,
    product_ids: input.discountType === "guestlist" ? [] : input.productIds,
    status: input.status,
  };
  const result = input.id
    ? await client.from("promo_codes").update(mutableRecord).eq("id", input.id).select("*").single()
    : await client.from("promo_codes").insert({ ...mutableRecord, created_by: actor.id }).select("*").single();
  if (result.error) {
    if (result.error.code === "23505") throw new PublicApiError("PROMO_CODE_EXISTS", "That promo code is already in use.", 409);
    throw new PublicApiError("PROMO_SAVE_FAILED", "The promo code could not be saved.", 503);
  }
  await client.from("promo_admin_audit").insert({ promo_code_id: result.data.id, actor_id: actor.id, action: input.id ? "updated" : "created", safe_metadata: { status: input.status } });
  return mapPromo(result.data as unknown as Record<string, unknown>);
}

async function pagedPromoUsage(
  client: SupabaseAdminClient,
  promoCodeId: string,
  customerId: string,
): Promise<Pick<PromoUsage, "redemptions" | "discountedTicketUnits" | "customerRedemptions">> {
  let redemptions = 0;
  let discountedTicketUnits = 0;
  let customerRedemptions = 0;
  for (let from = 0; ; from += PROMO_PAGE_SIZE) {
    const result = await client.from("promo_redemptions")
      .select("customer_id,status,discounted_ticket_units,reserved_until")
      .eq("promo_code_id", promoCodeId)
      .in("status", ["reserved", "finalized", "refunded", "disputed"])
      .order("created_at", { ascending: true })
      .range(from, from + PROMO_PAGE_SIZE - 1);
    if (result.error) throw new PublicApiError("PROMO_STORE_UNAVAILABLE", "Promo data is temporarily unavailable.", 503);
    const page = (result.data || []) as unknown as Record<string, unknown>[];
    for (const row of page) {
      if (String(row.status) === "reserved" && new Date(String(row.reserved_until)).getTime() <= Date.now()) continue;
      redemptions += 1;
      discountedTicketUnits += Number(row.discounted_ticket_units || 0);
      if (String(row.customer_id) === customerId) customerRedemptions += 1;
    }
    if (page.length < PROMO_PAGE_SIZE) break;
  }
  return { redemptions, discountedTicketUnits, customerRedemptions };
}

async function promoUsageSnapshot(
  client: SupabaseAdminClient,
  promoCodeId: string,
  customerId: string,
) {
  const result = await client.rpc("skie_promo_usage_snapshot", {
    p_promo_code_id: promoCodeId,
    p_customer_id: customerId,
  });
  if (!result.error) {
    const value = Array.isArray(result.data) ? result.data[0] : result.data;
    if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      const redemptions = Number(row.redemptions || 0);
      const discountedTicketUnits = Number(row.discounted_ticket_units || 0);
      const customerRedemptions = Number(row.customer_redemptions || 0);
      if ([redemptions, discountedTicketUnits, customerRedemptions].every((count) => Number.isSafeInteger(count) && count >= 0)) {
        return { redemptions, discountedTicketUnits, customerRedemptions };
      }
    }
  }
  return pagedPromoUsage(client, promoCodeId, customerId);
}

async function findPromoAndUsage(code: string, customerId: string): Promise<{ promo: PromoCode; usage: PromoUsage }> {
  const normalized = normalizePromoCode(code);
  if (config.dataProvider !== "supabase") {
    const ops = await readOperationsData();
    const promo = ops.promoCodes.find((item) => normalizePromoCode(item.code) === normalized);
    if (!promo) throw new PromoPolicyError("PROMO_NOT_FOUND");
    const activeStatuses = new Set(["reserved", "finalized", "refunded", "disputed"]);
    const current = ops.promoRedemptions.filter((item) => item.promoCodeId === promo.id && activeStatuses.has(item.status)
      && !(item.status === "reserved" && new Date(item.reservedUntil).getTime() <= Date.now()));
    const customerHasPriorPurchase = ops.orders.some((order) => order.userId === customerId && order.status !== "pending" && order.status !== "expired" && order.status !== "failed");
    return { promo, usage: {
      redemptions: current.length,
      discountedTicketUnits: current.reduce((sum, item) => sum + item.discountedTicketUnits, 0),
      customerRedemptions: current.filter((item) => item.customerId === customerId).length,
      customerHasPriorPurchase,
    } };
  }

  const client = createSupabaseAdminClient();
  const promoResult = await client.from("promo_codes").select("*").eq("code", normalized).maybeSingle();
  if (promoResult.error) throw new PublicApiError("PROMO_STORE_UNAVAILABLE", "Promo data is temporarily unavailable.", 503);
  if (!promoResult.data) throw new PromoPolicyError("PROMO_NOT_FOUND");
  const promo = mapPromo(promoResult.data as unknown as Record<string, unknown>);
  const [usage, priorPurchase] = await Promise.all([
    promoUsageSnapshot(client, promo.id, customerId),
    client.from("orders").select("id", { count: "exact", head: true })
      .eq("customer_id", customerId)
      .in("status", ["payment_received", "fulfilment_pending", "paid_unfulfilled", "fulfilled", "partially_refunded", "refunded", "disputed", "suspended"]),
  ]);
  if (priorPurchase.error) throw new PublicApiError("PROMO_STORE_UNAVAILABLE", "Promo data is temporarily unavailable.", 503);
  return { promo, usage: {
    ...usage,
    customerHasPriorPurchase: (priorPurchase.count || 0) > 0,
  } };
}

export async function quotePromo(input: { code: string; customerId: string; eventId: string; items: CartItem[] }): Promise<PromoQuote> {
  const { promo, usage } = await findPromoAndUsage(input.code, input.customerId);
  return calculatePromoQuote({ promo, eventId: input.eventId, items: input.items, usage });
}

async function quoteAllocation(input: {
  allocationId?: string;
  customerId: string;
  eventId: string;
}): Promise<TicketAllocation | undefined> {
  if (!input.allocationId) return undefined;
  if (config.dataProvider === "supabase") {
    return (await getNormalizedAllocation(input.allocationId, input.customerId)) || undefined;
  }
  const operations = await readOperationsData();
  return operations.allocations.find((item) => item.id === input.allocationId
    && item.userId === input.customerId
    && item.eventId === input.eventId);
}

export async function quotePromoCart(user: SessionUser, input: {
  eventId: string;
  allocationId?: string;
  ticketTypeId: string;
  ticketQuantity: number;
  products: Array<{ productId: string; quantity: number }>;
  promoCode?: string;
}) {
  if (!input.promoCode) throw new PublicApiError("PROMO_REQUIRED", "Enter a promo code.", 422);
  const site = await readSiteData();
  const event = site.events.find((item) => item.id === input.eventId);
  if (!event || !canStartCheckout(event)) {
    throw new PublicApiError("CHECKOUT_NOT_AVAILABLE", "This event is not available for checkout.", 422);
  }
  if (!(await hasEventPasswordAccess(event))) {
    throw new PublicApiError("EVENT_PASSWORD_REQUIRED", "Enter the event password before checkout.", 403);
  }

  const ticket = event.ticketTypes.find((item) => item.id === input.ticketTypeId && isSalesWindowOpen(item));
  if (!ticket) throw new PublicApiError("CHECKOUT_ITEMS_INVALID", "That ticket type is no longer available.", 422);

  let allocation: TicketAllocation | undefined;
  if (event.ticketMode === "invite_only") {
    allocation = await quoteAllocation({
      allocationId: input.allocationId,
      customerId: user.id,
      eventId: event.id,
    });
    if (!allocation
      || allocation.eventId !== event.id
      || !["unlocked", "checkout_started"].includes(allocation.status)
      || allocation.ticketTypeId !== ticket.id
      || allocation.priceCents !== ticket.priceCents
      || new Date(allocation.expiresAt).getTime() <= Date.now()) {
      throw new PublicApiError("ALLOCATION_NOT_AVAILABLE", "Your ticket allocation is not active.", 409);
    }
    const remaining = allocation.maxQuantity - allocation.purchasedQuantity;
    if (input.ticketQuantity > remaining) {
      throw new PublicApiError("ALLOCATION_LIMIT_EXCEEDED", `You can buy up to ${Math.max(0, remaining)} ticket(s).`, 409);
    }
  } else if (!["direct_purchase", "free_rsvp", POST_CHECKOUT_MODE].includes(String(event.ticketMode))) {
    throw new PublicApiError("CHECKOUT_NOT_AVAILABLE", "Tickets are not currently available.", 422);
  } else {
    const customerLimit = Math.min(event.defaultTicketLimit, ticket.defaultMaxPerCustomer);
    if (input.ticketQuantity > customerLimit) {
      throw new PublicApiError("CUSTOMER_TICKET_LIMIT_EXCEEDED", `Maximum ${customerLimit} tickets per customer.`, 409);
    }
  }

  const items: CartItem[] = [{
    kind: "ticket",
    referenceId: ticket.id,
    name: ticket.name,
    quantity: input.ticketQuantity,
    unitPriceCents: ticket.priceCents,
  }];
  for (const requested of input.products) {
    const product = site.products.find((item) => item.id === requested.productId
      && item.eventId === event.id
      && event.productIds.includes(item.id)
      && isSalesWindowOpen(item));
    if (!product) throw new PublicApiError("CHECKOUT_ITEMS_INVALID", "An event extra is no longer available.", 422);
    if (requested.quantity > product.maxPerOrder) {
      throw new PublicApiError("CUSTOMER_PRODUCT_LIMIT_EXCEEDED", `${product.name} exceeds its per-order limit.`, 409);
    }
    if (product.requiresApproval && event.ticketMode !== "invite_only" && String(event.ticketMode) !== POST_CHECKOUT_MODE) {
      throw new PublicApiError("PRODUCT_APPROVAL_REQUIRED", `${product.name} requires an approved checkout.`, 409);
    }
    items.push({ kind: "product", referenceId: product.id, name: product.name, quantity: requested.quantity, unitPriceCents: product.priceCents });
  }
  return quotePromo({ code: input.promoCode, customerId: user.id, eventId: event.id, items });
}
