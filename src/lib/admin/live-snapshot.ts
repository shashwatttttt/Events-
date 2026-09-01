import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type {
  CheckInRecord,
  Entitlement,
  EntitlementRedemption,
  OperationsData,
  Order,
  Payment,
  Ticket,
  TicketAllocation,
  UserProfile,
} from "@/types/site";

export type AdminOperationalMetrics = {
  source: "normalized" | "legacy";
  grossRevenueCents: number;
  refundedCents: number;
  netRevenueCents: number;
  paidOrders: number;
  issuedTickets: number;
  checkedInTickets: number;
  pendingOrders: number;
  updatedAt: string;
};

function one<T>(value: T | T[] | null | undefined): T | undefined {
  return Array.isArray(value) ? value[0] : value || undefined;
}

function asText(value: unknown, fallback = "") {
  return value === null || value === undefined ? fallback : String(value);
}

function asOptionalText(value: unknown) {
  return value === null || value === undefined || value === "" ? undefined : String(value);
}

function mapUser(row: Record<string, unknown>, legacy?: UserProfile): UserProfile {
  const createdAt = asText(row.created_at, legacy?.createdAt || new Date().toISOString());
  return {
    id: asText(row.id),
    firstName: asText(row.first_name),
    lastName: asText(row.last_name),
    email: asText(row.email).toLowerCase(),
    phone: asText(row.phone),
    instagram: asText(row.instagram),
    role: asText(row.role, "customer") as UserProfile["role"],
    tags: legacy?.tags || [],
    internalNotes: legacy?.internalNotes || "",
    createdAt,
    updatedAt: asText(row.updated_at, legacy?.updatedAt || createdAt),
  };
}

export async function normalizedAdminOperations(legacy: OperationsData) {
  const client = createSupabaseAdminClient();
  const [
    profileResult,
    allocationResult,
    orderResult,
    paymentResult,
    ticketResult,
    entitlementResult,
    redemptionResult,
    checkInResult,
  ] = await Promise.all([
    client.from("profiles")
      .select("id,first_name,last_name,email,phone,instagram,role,created_at,updated_at")
      .order("created_at", { ascending: false })
      .limit(5_000),
    client.from("ticket_allocations")
      .select("id,customer_id,event_id,application_id,ticket_type_id,max_quantity,purchased_quantity,price_cents,status,expires_at,approved_by,approved_at,created_at")
      .order("created_at", { ascending: false })
      .limit(5_000),
    client.from("orders")
      .select("id,reservation_id,customer_id,event_id,allocation_id,status,currency,subtotal_cents,discount_cents,total_cents,refunded_cents,paid_at,created_at,updated_at,reservations(expires_at,promo_code_id),order_lines(kind,reference_id,name,quantity,unit_price_cents)")
      .order("created_at", { ascending: false })
      .limit(5_000),
    client.from("payments")
      .select("id,order_id,provider,provider_reference,status,stripe_checkout_session_id,stripe_payment_intent_id,amount_cents,refunded_cents,currency,created_at,updated_at")
      .order("created_at", { ascending: false })
      .limit(5_000),
    client.from("tickets")
      .select("id,order_id,event_id,customer_id,ticket_type_id,ticket_code,token_hash,token_preview,holder_name,status,status_before_suspension,checked_in_at,checked_in_by,created_at,orders(reservations(customer_email))")
      .order("created_at", { ascending: false })
      .limit(10_000),
    client.from("entitlements")
      .select("id,order_id,event_id,customer_id,product_id,name,quantity_total,quantity_remaining,status,status_before_suspension,created_at")
      .order("created_at", { ascending: false })
      .limit(10_000),
    client.from("entitlement_redemptions")
      .select("id,entitlement_id,event_id,quantity,redeemed_by,idempotency_key,redeemed_at,reversed_at,reversed_by,reversal_reason")
      .order("redeemed_at", { ascending: false })
      .limit(10_000),
    client.from("check_ins")
      .select("id,event_id,ticket_id,scanned_by,result,notes,scanned_at,reversed_at,reversed_by,reversal_reason")
      .order("scanned_at", { ascending: false })
      .limit(10_000),
  ]);

  const failure = [
    profileResult,
    allocationResult,
    orderResult,
    paymentResult,
    ticketResult,
    entitlementResult,
    redemptionResult,
    checkInResult,
  ].find((result) => result.error);
  if (failure?.error) throw new Error("LIVE_ADMIN_SNAPSHOT_UNAVAILABLE");

  const legacyUsers = new Map(legacy.users.map((user) => [user.id, user]));
  const users = (profileResult.data || []).map((row) => mapUser(
    row as unknown as Record<string, unknown>,
    legacyUsers.get(String(row.id)),
  ));

  const allocations: TicketAllocation[] = (allocationResult.data || []).map((row) => ({
    id: String(row.id),
    eventId: String(row.event_id),
    userId: String(row.customer_id),
    applicationId: asOptionalText(row.application_id),
    ticketTypeId: String(row.ticket_type_id),
    maxQuantity: Number(row.max_quantity),
    purchasedQuantity: Number(row.purchased_quantity),
    priceCents: Number(row.price_cents),
    status: String(row.status) as TicketAllocation["status"],
    expiresAt: String(row.expires_at),
    approvedBy: asText(row.approved_by, "system"),
    approvedAt: String(row.approved_at),
  }));

  const orders: Order[] = (orderResult.data || []).map((row) => {
    const reservation = one(row.reservations);
    const lines = Array.isArray(row.order_lines) ? row.order_lines : [];
    return {
      id: String(row.id),
      reservationId: String(row.reservation_id),
      reservationVersion: 1,
      eventId: String(row.event_id),
      userId: String(row.customer_id),
      allocationId: asOptionalText(row.allocation_id),
      status: String(row.status) as Order["status"],
      currency: String(row.currency),
      subtotalCents: Number(row.subtotal_cents),
      discountCents: Number(row.discount_cents || 0),
      totalCents: Number(row.total_cents),
      promoCodeId: reservation?.promo_code_id ? String(reservation.promo_code_id) : undefined,
      items: lines.map((line) => ({
        kind: String(line.kind) as "ticket" | "product",
        referenceId: String(line.reference_id),
        name: String(line.name),
        quantity: Number(line.quantity),
        unitPriceCents: Number(line.unit_price_cents),
      })),
      idempotencyKey: `normalized:${row.id}`,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      paidAt: asOptionalText(row.paid_at),
      expiresAt: reservation?.expires_at ? String(reservation.expires_at) : String(row.created_at),
    };
  });

  const payments: Payment[] = (paymentResult.data || []).map((row) => ({
    id: String(row.id),
    orderId: String(row.order_id),
    provider: String(row.provider) as Payment["provider"],
    providerReference: asText(
      row.provider_reference || row.stripe_payment_intent_id || row.stripe_checkout_session_id,
      `payment:${row.id}`,
    ),
    amountCents: Number(row.amount_cents),
    currency: String(row.currency),
    status: String(row.status) as Payment["status"],
    refundedCents: Number(row.refunded_cents || 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));

  const tickets: Ticket[] = (ticketResult.data || []).map((row) => {
    const order = one(row.orders);
    const reservation = order ? one(order.reservations) : undefined;
    return {
      id: String(row.id),
      eventId: String(row.event_id),
      userId: String(row.customer_id),
      orderId: String(row.order_id),
      ticketTypeId: String(row.ticket_type_id),
      ticketCode: String(row.ticket_code),
      tokenHash: String(row.token_hash),
      tokenPreview: String(row.token_preview),
      status: String(row.status) as Ticket["status"],
      statusBeforeSuspension: row.status_before_suspension
        ? String(row.status_before_suspension) as Ticket["statusBeforeSuspension"]
        : undefined,
      holderName: String(row.holder_name),
      holderEmail: reservation?.customer_email ? String(reservation.customer_email) : "",
      checkedInAt: asOptionalText(row.checked_in_at),
      checkedInBy: asOptionalText(row.checked_in_by),
      createdAt: String(row.created_at),
    };
  });

  const entitlements: Entitlement[] = (entitlementResult.data || []).map((row) => ({
    id: String(row.id),
    eventId: String(row.event_id),
    userId: String(row.customer_id),
    orderId: String(row.order_id),
    productId: String(row.product_id),
    name: String(row.name),
    quantityTotal: Number(row.quantity_total),
    quantityRemaining: Number(row.quantity_remaining),
    status: String(row.status) as Entitlement["status"],
    statusBeforeSuspension: row.status_before_suspension
      ? String(row.status_before_suspension) as Entitlement["statusBeforeSuspension"]
      : undefined,
    createdAt: String(row.created_at),
  }));

  const entitlementRedemptions: EntitlementRedemption[] = (redemptionResult.data || []).map((row) => ({
    id: String(row.id),
    entitlementId: String(row.entitlement_id),
    eventId: String(row.event_id),
    quantity: Number(row.quantity),
    redeemedBy: String(row.redeemed_by),
    idempotencyKey: String(row.idempotency_key),
    redeemedAt: String(row.redeemed_at),
    reversedAt: asOptionalText(row.reversed_at),
    reversedBy: asOptionalText(row.reversed_by),
    reversalReason: asOptionalText(row.reversal_reason),
  }));

  const checkIns: CheckInRecord[] = (checkInResult.data || []).map((row) => ({
    id: String(row.id),
    eventId: String(row.event_id),
    ticketId: String(row.ticket_id),
    scannedBy: String(row.scanned_by),
    result: String(row.result) as CheckInRecord["result"],
    notes: asText(row.notes),
    scannedAt: String(row.scanned_at),
    reversedAt: asOptionalText(row.reversed_at),
    reversedBy: asOptionalText(row.reversed_by),
    reversalReason: asOptionalText(row.reversal_reason),
  }));

  const stripePayments = payments.filter((payment) => payment.provider === "stripe"
    && !["failed", "cancelled"].includes(payment.status));
  const paidOrderIds = new Set(stripePayments
    .filter((payment) => payment.status !== "refunded")
    .map((payment) => payment.orderId));
  const grossRevenueCents = stripePayments.reduce((sum, payment) => sum + payment.amountCents, 0);
  const refundedCents = stripePayments.reduce((sum, payment) => sum + (payment.refundedCents || 0), 0);

  const metrics: AdminOperationalMetrics = {
    source: "normalized",
    grossRevenueCents,
    refundedCents,
    netRevenueCents: Math.max(0, grossRevenueCents - refundedCents),
    paidOrders: paidOrderIds.size,
    issuedTickets: tickets.length,
    checkedInTickets: tickets.filter((ticket) => ticket.status === "checked_in").length,
    pendingOrders: orders.filter((order) => [
      "reserved", "checkout_pending", "payment_received", "fulfilment_pending",
      "paid_unfulfilled", "manual_review", "recovery_failed",
    ].includes(order.status)).length,
    updatedAt: new Date().toISOString(),
  };

  return {
    operations: {
      ...legacy,
      users,
      allocations,
      orders,
      payments,
      tickets,
      entitlements,
      entitlementRedemptions,
      checkIns,
    } satisfies OperationsData,
    metrics,
  };
}

export function legacyAdminMetrics(ops: OperationsData): AdminOperationalMetrics {
  const paid = ops.payments.filter((payment) => payment.status === "paid");
  const grossRevenueCents = paid.reduce((sum, payment) => sum + payment.amountCents, 0);
  const refundedCents = paid.reduce((sum, payment) => sum + (payment.refundedCents || 0), 0);
  return {
    source: "legacy",
    grossRevenueCents,
    refundedCents,
    netRevenueCents: Math.max(0, grossRevenueCents - refundedCents),
    paidOrders: new Set(paid.map((payment) => payment.orderId)).size,
    issuedTickets: ops.tickets.length,
    checkedInTickets: ops.tickets.filter((ticket) => ticket.status === "checked_in").length,
    pendingOrders: ops.orders.filter((order) => order.status === "pending").length,
    updatedAt: new Date().toISOString(),
  };
}
