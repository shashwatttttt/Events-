import "server-only";

import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createTicketToken, createTicketTokenHash } from "@/lib/tickets/security";
import { sha256 } from "@/lib/security/crypto";
import { enqueueOrderFulfilmentNotifications } from "@/lib/notifications/service";
import type {
  Entitlement,
  EventItem,
  Order,
  ReservationProductLine,
  ReservationTicketLine,
  SessionUser,
  StripeWebhookEventRecord,
  TicketAllocation,
  Ticket,
} from "@/types/site";
import type { StripeCheckoutSnapshot } from "@/lib/payments/reconciliation";

const SAFE_DATABASE_CODES = new Set([
  "ACTIVE_CHECKOUT_CONFLICT",
  "ALLOCATION_LIMIT_EXCEEDED",
  "ALLOCATION_NOT_AVAILABLE",
  "CHECKOUT_ATTEMPT_NOT_FOUND",
  "CHECKOUT_ATTEMPT_NOT_LINKABLE",
  "CHECKOUT_CREATION_CONFLICT",
  "CUSTOMER_PRODUCT_LIMIT_EXCEEDED",
  "CUSTOMER_TICKET_LIMIT_EXCEEDED",
  "EVENT_CAPACITY_EXCEEDED",
  "EVENT_SALES_CLOSED",
  "ORPHAN_STRIPE_SESSION",
  "PAYMENT_AMOUNT_MISMATCH",
  "PAYMENT_INTENT_MISMATCH",
  "PAYMENT_ORDER_REFERENCE_MISMATCH",
  "PRODUCT_STOCK_EXCEEDED",
  "PROMO_CUSTOMER_LIMIT",
  "PROMO_EVENT_RESTRICTED",
  "PROMO_EXPIRED",
  "PROMO_FIRST_PURCHASE_ONLY",
  "PROMO_ITEMS_NOT_ELIGIBLE",
  "PROMO_MINIMUM_NOT_MET",
  "PROMO_NOT_AVAILABLE",
  "PROMO_NOT_FOUND",
  "PROMO_NOT_STARTED",
  "PROMO_REDEMPTION_LIMIT",
  "PROMO_TICKET_UNIT_LIMIT",
  "RESERVATION_NOT_LINKABLE",
  "TICKET_CAPACITY_EXCEEDED",
]);

export class TransactionStoreError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "TransactionStoreError";
  }
}

function safeDatabaseCode(error: unknown) {
  const message = typeof error === "object" && error && "message" in error
    ? String((error as { message?: unknown }).message || "")
    : "";
  const matched = [...SAFE_DATABASE_CODES].find((code) => message.includes(code));
  return matched || "TRANSACTION_STORE_UNAVAILABLE";
}

function assertNormalizedStore() {
  if (config.dataProvider !== "supabase") throw new TransactionStoreError("NORMALIZED_STORE_NOT_ACTIVE");
}

type RpcRow = Record<string, unknown>;

function firstRow(data: unknown): RpcRow {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") throw new TransactionStoreError("TRANSACTION_STORE_INVALID_RESPONSE");
  return row as RpcRow;
}

export type NormalizedCheckoutInput = {
  customer: SessionUser;
  customerEmail: string;
  event: EventItem;
  allocation?: TicketAllocation;
  ticketLine: ReservationTicketLine;
  productLines: ReservationProductLine[];
  expiresAt: string;
  promoCode?: string;
};

export async function reserveNormalizedCheckout(input: NormalizedCheckoutInput): Promise<Order> {
  assertNormalizedStore();
  const client = createSupabaseAdminClient();
  const rpcName = input.promoCode ? "skie_reserve_checkout_with_promo" : "skie_reserve_checkout_v2";
  const rpcInput = {
    p_customer_id: input.customer.id,
    p_customer_email: input.customerEmail,
    p_customer_name: `${input.customer.firstName} ${input.customer.lastName}`.trim() || "Customer",
    p_event_id: input.event.id,
    p_event_title: input.event.title,
    p_event_public_capacity: input.event.publicCapacity,
    p_currency: config.currency.toUpperCase(),
    p_expires_at: input.expiresAt,
    p_ticket_lines: [{
      ticket_type_id: input.ticketLine.referenceId,
      name: input.ticketLine.name,
      quantity: input.ticketLine.quantity,
      unit_price_cents: input.ticketLine.unitPriceCents,
      capacity: input.ticketLine.ticketTypeCapacity,
      customer_limit: input.ticketLine.customerLimit,
    }],
    p_product_lines: input.productLines.map((line) => ({
      product_id: line.referenceId,
      name: line.name,
      quantity: line.quantity,
      unit_price_cents: line.unitPriceCents,
      stock_quantity: line.stockQuantity,
      max_per_customer: line.maxPerCustomer,
      units_per_purchase: line.unitsPerPurchase,
      redeemable: line.redeemable,
    })),
    p_allocation_id: input.allocation?.id || null,
    ...(input.promoCode ? { p_promo_code: input.promoCode } : { p_expected_discount_cents: 0 }),
  };
  const { data, error } = await client.rpc(rpcName, rpcInput);
  if (error) throw new TransactionStoreError(safeDatabaseCode(error));
  const row = firstRow(data);
  const createdAt = new Date().toISOString();
  const items = [input.ticketLine, ...input.productLines].map((line) => ({
    kind: line.kind,
    referenceId: line.referenceId,
    name: line.name,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
  }));
  const subtotalCents = items.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
  const discountCents = Number(row.discount_cents || 0);
  return {
    id: String(row.order_id),
    reservationId: String(row.reservation_id),
    reservationVersion: 1,
    checkoutAttemptId: String(row.checkout_attempt_id),
    eventId: input.event.id,
    userId: input.customer.id,
    allocationId: input.allocation?.id,
    status: "pending",
    currency: config.currency.toUpperCase(),
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
    promoCodeId: row.promo_code_id ? String(row.promo_code_id) : undefined,
    promoCodeSnapshot: input.promoCode?.trim().toUpperCase(),
    items,
    idempotencyKey: String(row.idempotency_key),
    createdAt,
    updatedAt: createdAt,
    expiresAt: input.expiresAt,
  };
}

export async function linkNormalizedStripeSession(
  checkoutAttemptId: string,
  sessionId: string,
  providerExpiresAt: string,
) {
  assertNormalizedStore();
  const { data, error } = await createSupabaseAdminClient().rpc("skie_link_stripe_session", {
    p_checkout_attempt_id: checkoutAttemptId,
    p_stripe_session_id: sessionId,
    p_provider_expires_at: providerExpiresAt,
  });
  if (error) throw new TransactionStoreError(safeDatabaseCode(error));
  const row = firstRow(data);
  if (row.failure_code) throw new TransactionStoreError(String(row.failure_code));
  return row;
}

export async function failNormalizedCheckoutCreation(checkoutAttemptId: string) {
  assertNormalizedStore();
  const { error } = await createSupabaseAdminClient().rpc("skie_fail_checkout_creation", {
    p_checkout_attempt_id: checkoutAttemptId,
  });
  if (error) throw new TransactionStoreError(safeDatabaseCode(error));
}

export async function upsertNormalizedAllocation(allocation: TicketAllocation) {
  assertNormalizedStore();
  const { data, error } = await createSupabaseAdminClient().rpc("skie_upsert_ticket_allocation", {
    p_id: allocation.id,
    p_customer_id: allocation.userId,
    p_event_id: allocation.eventId,
    p_ticket_type_id: allocation.ticketTypeId,
    p_max_quantity: allocation.maxQuantity,
    p_price_cents: allocation.priceCents,
    p_expires_at: allocation.expiresAt,
    p_approved_by: allocation.approvedBy,
    p_approved_at: allocation.approvedAt,
  });
  if (error) throw new TransactionStoreError(safeDatabaseCode(error));
  return firstRow(data);
}

export async function getNormalizedAllocation(allocationId: string, customerId?: string) {
  assertNormalizedStore();
  let query = createSupabaseAdminClient()
    .from("ticket_allocations")
    .select("id,event_id,customer_id,application_id,ticket_type_id,max_quantity,purchased_quantity,price_cents,status,expires_at,approved_by,approved_at")
    .eq("id", allocationId);
  if (customerId) query = query.eq("customer_id", customerId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new TransactionStoreError("TRANSACTION_STORE_UNAVAILABLE");
  if (!data) return null;
  return {
    id: String(data.id),
    eventId: String(data.event_id),
    userId: String(data.customer_id),
    applicationId: data.application_id ? String(data.application_id) : undefined,
    ticketTypeId: String(data.ticket_type_id),
    maxQuantity: Number(data.max_quantity),
    purchasedQuantity: Number(data.purchased_quantity),
    priceCents: Number(data.price_cents),
    status: String(data.status) as TicketAllocation["status"],
    expiresAt: String(data.expires_at),
    approvedBy: data.approved_by ? String(data.approved_by) : "system",
    approvedAt: String(data.approved_at),
  } satisfies TicketAllocation;
}

export async function mutateNormalizedAllocation(
  allocationId: string,
  action: "extend" | "unlock" | "cancel",
  expiresAt?: string,
) {
  assertNormalizedStore();
  const { data, error } = await createSupabaseAdminClient().rpc("skie_mutate_ticket_allocation", {
    p_id: allocationId,
    p_action: action,
    p_expires_at: expiresAt || null,
  });
  if (error) throw new TransactionStoreError(safeDatabaseCode(error));
  return firstRow(data);
}

export async function findNormalizedAllocationSession(allocationId: string) {
  assertNormalizedStore();
  const { data, error } = await createSupabaseAdminClient()
    .from("reservations")
    .select("id,status,checkout_attempts(id,status,stripe_checkout_session_id,provider_expires_at)")
    .eq("allocation_id", allocationId)
    .in("status", ["reserved", "session_active", "payment_received", "fulfilment_pending", "paid_unfulfilled", "manual_review"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new TransactionStoreError("TRANSACTION_STORE_UNAVAILABLE");
  const attempts = data?.checkout_attempts;
  const attempt = Array.isArray(attempts) ? attempts[0] : attempts;
  return data && attempt ? {
    reservationId: String(data.id),
    reservationStatus: String(data.status),
    checkoutAttemptId: String(attempt.id),
    attemptStatus: String(attempt.status),
    sessionId: attempt.stripe_checkout_session_id ? String(attempt.stripe_checkout_session_id) : undefined,
    providerExpiresAt: attempt.provider_expires_at ? String(attempt.provider_expires_at) : undefined,
  } : null;
}

export async function findNormalizedOrderStatusBySession(sessionId: string) {
  assertNormalizedStore();
  const { data: attempt, error } = await createSupabaseAdminClient()
    .from("checkout_attempts")
    .select("order_id,orders(id,status)")
    .eq("stripe_checkout_session_id", sessionId)
    .maybeSingle();
  if (error) throw new TransactionStoreError("TRANSACTION_STORE_UNAVAILABLE");
  const joined = attempt?.orders;
  const order = Array.isArray(joined) ? joined[0] : joined;
  return order ? { id: String(order.id), status: String(order.status) as Order["status"] } : null;
}

export async function listNormalizedActiveEventSessions(eventIds: string[]) {
  assertNormalizedStore();
  if (!eventIds.length) return [];
  const { data, error } = await createSupabaseAdminClient().from("reservations")
    .select("event_id,status,checkout_attempts(id,status,stripe_checkout_session_id)")
    .in("event_id", eventIds)
    .in("status", ["reserved", "session_active"]);
  if (error) throw new TransactionStoreError("TRANSACTION_STORE_UNAVAILABLE");
  return (data || []).flatMap((reservation) => {
    const attempts = Array.isArray(reservation.checkout_attempts)
      ? reservation.checkout_attempts
      : reservation.checkout_attempts ? [reservation.checkout_attempts] : [];
    return attempts
      .filter((attempt) => attempt.status === "session_active" && attempt.stripe_checkout_session_id)
      .map((attempt) => ({ eventId: String(reservation.event_id), sessionId: String(attempt.stripe_checkout_session_id) }));
  });
}

export type NormalizedWebhookInput = Omit<StripeWebhookEventRecord,
  "status" | "processingAttempts" | "receivedAt" | "processedAt" | "safeErrorCode"> & {
  apiVersion?: string;
};

export async function recordNormalizedWebhook(input: NormalizedWebhookInput) {
  assertNormalizedStore();
  const { data, error } = await createSupabaseAdminClient().rpc("skie_record_stripe_webhook", {
    p_stripe_event_id: input.stripeEventId,
    p_event_type: input.eventType,
    p_livemode: input.livemode,
    p_provider_created_at: input.providerCreatedAt,
    p_api_version: input.apiVersion || null,
    p_object_id: input.objectId || null,
    p_checkout_session_id: input.checkoutSessionId || null,
    p_payment_intent_id: input.paymentIntentId || null,
    p_charge_id: input.chargeId || null,
    p_refund_id: input.refundId || null,
    p_dispute_id: input.disputeId || null,
    p_correlation_id: input.correlationId,
  });
  if (error) throw new TransactionStoreError("WEBHOOK_INBOX_UNAVAILABLE");
  return firstRow(data);
}

export async function markNormalizedWebhookResult(
  stripeEventId: string,
  status: "processed" | "temporary_failure" | "permanent_failure" | "manual_review",
  safeErrorCode?: string,
) {
  assertNormalizedStore();
  const { error } = await createSupabaseAdminClient().rpc("skie_mark_webhook_result", {
    p_stripe_event_id: stripeEventId,
    p_status: status,
    p_safe_error_code: safeErrorCode || null,
  });
  if (error) throw new TransactionStoreError("WEBHOOK_INBOX_UNAVAILABLE");
}

export async function expireNormalizedSessionState(sessionId: string, result: "expired" | "failed" | "orphan" | "manual_review") {
  assertNormalizedStore();
  const { error } = await createSupabaseAdminClient().rpc("skie_expire_checkout_session", {
    p_stripe_session_id: sessionId,
    p_result: result,
  });
  if (error) throw new TransactionStoreError(safeDatabaseCode(error));
}

export async function recordNormalizedPayment(snapshot: StripeCheckoutSnapshot) {
  assertNormalizedStore();
  if (snapshot.paymentStatus !== "paid") throw new TransactionStoreError("PAYMENT_NOT_PAID");
  if (!snapshot.paymentIntentId || snapshot.amountTotal === null || !snapshot.currency) {
    throw new TransactionStoreError("PAYMENT_SNAPSHOT_INCOMPLETE");
  }
  const { data, error } = await createSupabaseAdminClient().rpc("skie_record_payment_received", {
    p_stripe_event_id: snapshot.eventId,
    p_stripe_session_id: snapshot.sessionId,
    p_payment_intent_id: snapshot.paymentIntentId,
    p_amount_cents: snapshot.amountTotal,
    p_currency: snapshot.currency,
    p_provider_created_at: new Date(snapshot.eventCreatedAtMs).toISOString(),
    p_metadata_order_id: snapshot.metadataOrderId,
    p_client_reference_order_id: snapshot.clientReferenceOrderId,
  });
  if (error) throw new TransactionStoreError(safeDatabaseCode(error));
  const row = firstRow(data);
  if (row.failure_code) throw new TransactionStoreError(String(row.failure_code));
  return row;
}

export async function fulfilNormalizedPayment(snapshot: StripeCheckoutSnapshot) {
  assertNormalizedStore();
  if (snapshot.eventType === "checkout.session.completed" && snapshot.paymentStatus === "unpaid") {
    return { awaitingPayment: true, duplicate: false };
  }
  const received = await recordNormalizedPayment(snapshot);
  const fulfilled = await fulfilNormalizedReservation(String(received.reservation_id));
  await enqueueOrderFulfilmentNotifications(String(fulfilled.order_id)).catch(() => undefined);
  return fulfilled;
}

async function fulfilNormalizedReservation(reservationId: string) {
  const client = createSupabaseAdminClient();
  const { data: reservation, error: reservationError } = await client
    .from("reservations")
    .select("id,customer_id,customer_name,event_id,reservation_ticket_lines(ticket_type_id,quantity),reservation_product_lines(product_id,name,quantity,units_per_purchase,redeemable)")
    .eq("id", reservationId)
    .single();
  if (reservationError || !reservation) {
    await client.rpc("skie_mark_paid_unfulfilled", { p_reservation_id: reservationId, p_safe_error_code: "RESERVATION_READ_FAILED" });
    throw new TransactionStoreError("FULFILMENT_FAILED");
  }
  const ticketLines = Array.isArray(reservation.reservation_ticket_lines)
    ? reservation.reservation_ticket_lines
    : [];
  const productLines = Array.isArray(reservation.reservation_product_lines)
    ? reservation.reservation_product_lines
    : [];
  const tickets: Array<Record<string, unknown>> = [];
  for (const line of ticketLines) {
    for (let index = 0; index < Number(line.quantity); index += 1) {
      const id = randomUUID();
      const ticket = {
        id,
        eventId: String(reservation.event_id),
        userId: String(reservation.customer_id),
      };
      const token = createTicketToken(ticket);
      tickets.push({
        id,
        ticket_type_id: String(line.ticket_type_id),
        ticket_code: `SKIE-${id.replaceAll("-", "").slice(-12).toUpperCase().match(/.{1,4}/g)?.join("-")}`,
        token_hash: createTicketTokenHash(ticket),
        token_preview: token.slice(0, 8),
        holder_name: String(reservation.customer_name),
      });
    }
  }
  const entitlements = productLines
    .filter((line) => Boolean(line.redeemable))
    .map((line) => ({
      id: randomUUID(),
      product_id: String(line.product_id),
      name: String(line.name),
      quantity_total: Number(line.quantity) * Number(line.units_per_purchase),
    }));
  const { data, error } = await client.rpc("skie_fulfil_payment", {
    p_reservation_id: reservationId,
    p_tickets: tickets,
    p_entitlements: entitlements,
  });
  if (error) {
    await client.rpc("skie_mark_paid_unfulfilled", { p_reservation_id: reservationId, p_safe_error_code: "FULFILMENT_FAILED" });
    throw new TransactionStoreError("FULFILMENT_FAILED");
  }
  return firstRow(data);
}

export async function fulfilNormalizedOrder(
  orderId: string,
  provider: "test" | "free",
  providerReference: string,
) {
  assertNormalizedStore();
  const client = createSupabaseAdminClient();
  const { data, error } = await client.rpc("skie_record_offline_payment", {
    p_order_id: orderId,
    p_provider: provider,
    p_provider_reference: providerReference,
  });
  if (error) throw new TransactionStoreError(safeDatabaseCode(error));
  const received = firstRow(data);
  const fulfilled = await fulfilNormalizedReservation(String(received.reservation_id));
  await enqueueOrderFulfilmentNotifications(String(fulfilled.order_id)).catch(() => undefined);
  return fulfilled;
}

export async function applyNormalizedRefund(input: {
  paymentIntentId: string;
  refundId: string;
  status: "pending" | "succeeded" | "failed";
  amountCents: number;
  currency: string;
  providerCreatedAt: string;
  lineAttribution?: unknown;
}) {
  assertNormalizedStore();
  const { data, error } = await createSupabaseAdminClient().rpc("skie_apply_refund", {
    p_payment_intent_id: input.paymentIntentId,
    p_refund_id: input.refundId,
    p_refund_status: input.status,
    p_amount_cents: input.amountCents,
    p_currency: input.currency,
    p_provider_created_at: input.providerCreatedAt,
    p_line_attribution: input.lineAttribution || null,
  });
  if (error) throw new TransactionStoreError(safeDatabaseCode(error));
  return firstRow(data);
}

export async function applyNormalizedDispute(input: {
  paymentIntentId: string;
  disputeId: string;
  status: "needs_response" | "won" | "lost" | "closed";
  amountCents: number;
  currency: string;
  providerCreatedAt: string;
}) {
  assertNormalizedStore();
  const { data, error } = await createSupabaseAdminClient().rpc("skie_apply_dispute", {
    p_payment_intent_id: input.paymentIntentId,
    p_dispute_id: input.disputeId,
    p_dispute_status: input.status,
    p_amount_cents: input.amountCents,
    p_currency: input.currency,
    p_provider_created_at: input.providerCreatedAt,
  });
  if (error) throw new TransactionStoreError(safeDatabaseCode(error));
  return firstRow(data);
}

export async function markNormalizedPaymentIntentTerminal(
  paymentIntentId: string,
  result: "failed" | "cancelled",
) {
  assertNormalizedStore();
  const { data, error } = await createSupabaseAdminClient().rpc("skie_mark_payment_intent_terminal", {
    p_payment_intent_id: paymentIntentId,
    p_result: result,
  });
  if (error) throw new TransactionStoreError(safeDatabaseCode(error));
  return firstRow(data);
}

export const PAYMENT_RECOVERY_STATUSES = [
  "payment_received",
  "fulfilment_pending",
  "paid_unfulfilled",
  "refund_pending",
  "partially_refunded",
  "disputed",
  "suspended",
  "manual_review",
  "recovery_failed",
] as const;

export type PaymentRecoveryItem = {
  kind: "payment" | "orphan_session" | "webhook";
  reservationId: string;
  orderId: string;
  eventId: string;
  status: string;
  totalCents: number;
  currency: string;
  failureCode?: string;
  sessionId?: string;
  paymentIntentId?: string;
  updatedAt: string;
};

export async function listNormalizedPaymentRecovery(): Promise<PaymentRecoveryItem[]> {
  assertNormalizedStore();
  const client = createSupabaseAdminClient();
  const [reservationsResult, orphanResult, webhookResult] = await Promise.all([
    client
    .from("reservations")
    .select("id,event_id,status,failure_code,updated_at,orders(id,total_cents,currency),checkout_attempts(stripe_checkout_session_id,stripe_payment_intent_id)")
    .in("status", [...PAYMENT_RECOVERY_STATUSES])
    .order("updated_at", { ascending: false })
    .limit(250),
    client.from("checkout_attempts")
      .select("id,reservation_id,stripe_checkout_session_id,stripe_payment_intent_id,updated_at,reservations(event_id,failure_code,orders(id,total_cents,currency))")
      .eq("status", "orphan_session")
      .order("updated_at", { ascending: false })
      .limit(100),
    client.from("stripe_webhook_events")
      .select("stripe_event_id,event_type,status,object_id,safe_error_code,updated_at")
      .in("status", ["temporary_failure", "permanent_failure", "manual_review"])
      .order("updated_at", { ascending: false })
      .limit(100),
  ]);
  if (reservationsResult.error || orphanResult.error || webhookResult.error) {
    throw new TransactionStoreError("TRANSACTION_STORE_UNAVAILABLE");
  }
  const payments = (reservationsResult.data || []).flatMap((row) => {
    const joinedOrder = Array.isArray(row.orders) ? row.orders[0] : row.orders;
    const joinedAttempt = Array.isArray(row.checkout_attempts) ? row.checkout_attempts[0] : row.checkout_attempts;
    if (!joinedOrder) return [];
    return [{
      kind: "payment" as const,
      reservationId: String(row.id),
      orderId: String(joinedOrder.id),
      eventId: String(row.event_id),
      status: String(row.status),
      totalCents: Number(joinedOrder.total_cents),
      currency: String(joinedOrder.currency),
      failureCode: row.failure_code ? String(row.failure_code) : undefined,
      sessionId: joinedAttempt?.stripe_checkout_session_id ? String(joinedAttempt.stripe_checkout_session_id) : undefined,
      paymentIntentId: joinedAttempt?.stripe_payment_intent_id ? String(joinedAttempt.stripe_payment_intent_id) : undefined,
      updatedAt: String(row.updated_at),
    }];
  });
  const orphans = (orphanResult.data || []).flatMap((row) => {
    const reservation = Array.isArray(row.reservations) ? row.reservations[0] : row.reservations;
    const joinedOrder = reservation && (Array.isArray(reservation.orders) ? reservation.orders[0] : reservation.orders);
    if (!reservation || !joinedOrder) return [];
    return [{
      kind: "orphan_session" as const,
      reservationId: String(row.reservation_id),
      orderId: String(joinedOrder.id),
      eventId: String(reservation.event_id),
      status: "orphan_session",
      totalCents: Number(joinedOrder.total_cents),
      currency: String(joinedOrder.currency),
      failureCode: reservation.failure_code ? String(reservation.failure_code) : "SESSION_LINK_FAILED",
      sessionId: row.stripe_checkout_session_id ? String(row.stripe_checkout_session_id) : undefined,
      paymentIntentId: row.stripe_payment_intent_id ? String(row.stripe_payment_intent_id) : undefined,
      updatedAt: String(row.updated_at),
    }];
  });
  const webhooks = (webhookResult.data || []).map((row) => ({
    kind: "webhook" as const,
    reservationId: `webhook:${row.stripe_event_id}`,
    orderId: row.object_id ? String(row.object_id) : String(row.stripe_event_id),
    eventId: String(row.event_type),
    status: "webhook_failed",
    totalCents: 0,
    currency: "AUD",
    failureCode: row.safe_error_code ? String(row.safe_error_code) : String(row.status),
    updatedAt: String(row.updated_at),
  }));
  return [...payments, ...orphans, ...webhooks]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 250);
}

export async function recordNormalizedRecoveryAction(input: {
  reservationId: string;
  orderId: string;
  action: string;
  actorId: string;
  actorLabel: string;
  idempotencyKey: string;
  status: "requested" | "completed" | "failed" | "manual_review";
  safeMetadata?: Record<string, string | number | boolean | null>;
  safeErrorCode?: string;
}) {
  assertNormalizedStore();
  const { data, error } = await createSupabaseAdminClient()
    .from("payment_recovery_actions")
    .upsert({
      reservation_id: input.reservationId,
      order_id: input.orderId,
      action: input.action,
      actor_id: input.actorId,
      actor_label: input.actorLabel,
      idempotency_key: input.idempotencyKey,
      status: input.status,
      safe_metadata: input.safeMetadata || {},
      safe_error_code: input.safeErrorCode || null,
      completed_at: input.status === "completed" ? new Date().toISOString() : null,
    }, { onConflict: "idempotency_key" })
    .select("id,status")
    .maybeSingle();
  if (error) throw new TransactionStoreError("RECOVERY_AUDIT_FAILED");
  return data;
}

export async function markNormalizedRecoveryResolved(reservationId: string) {
  assertNormalizedStore();
  const { data, error } = await createSupabaseAdminClient().rpc("skie_mark_recovery_resolved", {
    p_reservation_id: reservationId,
  });
  if (error) throw new TransactionStoreError(safeDatabaseCode(error));
  return firstRow(data);
}

export async function getNormalizedCustomerTransactions(customerId: string) {
  assertNormalizedStore();
  const client = createSupabaseAdminClient();
  const [allocationResult, orderResult, ticketResult, entitlementResult] = await Promise.all([
    client.from("ticket_allocations")
      .select("id,event_id,application_id,ticket_type_id,max_quantity,purchased_quantity,price_cents,status,expires_at,approved_by,approved_at")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
    client.from("orders")
      .select("id,reservation_id,event_id,allocation_id,status,currency,subtotal_cents,discount_cents,total_cents,paid_at,created_at,updated_at,reservations(expires_at),order_lines(kind,reference_id,name,quantity,unit_price_cents)")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
    client.from("tickets")
      .select("id,order_id,event_id,ticket_type_id,ticket_code,token_hash,token_preview,holder_name,status,status_before_suspension,checked_in_at,checked_in_by,created_at,orders(reservations(customer_email))")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
    client.from("entitlements")
      .select("id,order_id,event_id,product_id,name,quantity_total,quantity_remaining,status,status_before_suspension,created_at")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false }),
  ]);
  if (allocationResult.error || orderResult.error || ticketResult.error || entitlementResult.error) {
    throw new TransactionStoreError("TRANSACTION_STORE_UNAVAILABLE");
  }
  const allocations: TicketAllocation[] = (allocationResult.data || []).map((row) => ({
    id: String(row.id), eventId: String(row.event_id), userId: customerId,
    applicationId: row.application_id ? String(row.application_id) : undefined,
    ticketTypeId: String(row.ticket_type_id), maxQuantity: Number(row.max_quantity),
    purchasedQuantity: Number(row.purchased_quantity), priceCents: Number(row.price_cents),
    status: String(row.status) as TicketAllocation["status"], expiresAt: String(row.expires_at),
    approvedBy: String(row.approved_by), approvedAt: String(row.approved_at),
  }));
  const orders: Order[] = (orderResult.data || []).map((row) => {
    const reservation = Array.isArray(row.reservations) ? row.reservations[0] : row.reservations;
    return {
      id: String(row.id), reservationId: String(row.reservation_id), reservationVersion: 1,
      eventId: String(row.event_id), userId: customerId,
      allocationId: row.allocation_id ? String(row.allocation_id) : undefined,
      status: String(row.status) as Order["status"], currency: String(row.currency),
      subtotalCents: Number(row.subtotal_cents), totalCents: Number(row.total_cents),
      items: (row.order_lines || []).map((line) => ({
        kind: String(line.kind) as "ticket" | "product", referenceId: String(line.reference_id),
        name: String(line.name), quantity: Number(line.quantity), unitPriceCents: Number(line.unit_price_cents),
      })),
      idempotencyKey: `normalized:${row.id}`, createdAt: String(row.created_at),
      updatedAt: String(row.updated_at), paidAt: row.paid_at ? String(row.paid_at) : undefined,
      expiresAt: reservation?.expires_at ? String(reservation.expires_at) : String(row.created_at),
    };
  });
  const entitlements: Entitlement[] = (entitlementResult.data || []).map((row) => ({
    id: String(row.id), eventId: String(row.event_id), userId: customerId, orderId: String(row.order_id),
    productId: String(row.product_id), name: String(row.name), quantityTotal: Number(row.quantity_total),
    quantityRemaining: Number(row.quantity_remaining), status: String(row.status) as Entitlement["status"],
    statusBeforeSuspension: row.status_before_suspension ? String(row.status_before_suspension) as Entitlement["statusBeforeSuspension"] : undefined,
    createdAt: String(row.created_at),
  }));
  const tickets: Ticket[] = (ticketResult.data || []).map((row) => {
    const order = Array.isArray(row.orders) ? row.orders[0] : row.orders;
    const reservation = order && (Array.isArray(order.reservations) ? order.reservations[0] : order.reservations);
    return {
      id: String(row.id), eventId: String(row.event_id), userId: customerId, orderId: String(row.order_id),
      ticketTypeId: String(row.ticket_type_id), ticketCode: String(row.ticket_code), tokenHash: String(row.token_hash),
      tokenPreview: String(row.token_preview), status: String(row.status) as Ticket["status"],
      statusBeforeSuspension: row.status_before_suspension ? String(row.status_before_suspension) as Ticket["statusBeforeSuspension"] : undefined,
      holderName: String(row.holder_name), holderEmail: reservation?.customer_email ? String(reservation.customer_email) : "",
      checkedInAt: row.checked_in_at ? String(row.checked_in_at) : undefined,
      checkedInBy: row.checked_in_by ? String(row.checked_in_by) : undefined,
      createdAt: String(row.created_at),
    };
  });
  return { allocations, orders, tickets, entitlements };
}

export async function getNormalizedOwnedTicket(ticketId: string, customerId: string) {
  const data = await getNormalizedCustomerTransactions(customerId);
  const ticket = data.tickets.find((item) => item.id === ticketId) || null;
  return ticket ? { ticket, entitlements: data.entitlements.filter((item) => item.orderId === ticket.orderId) } : null;
}

async function assertNormalizedEventAssignment(actorId: string, eventId: string, allowedRoles: string[]) {
  const client = createSupabaseAdminClient();
  const { data: profile, error: profileError } = await client.from("profiles").select("role").eq("id", actorId).single();
  if (profileError || !profile) throw new TransactionStoreError("FORBIDDEN");
  if (["admin", "super_admin"].includes(String(profile.role))) return;
  const now = new Date().toISOString();
  const { data, error } = await client.from("event_staff_assignments")
    .select("id")
    .eq("user_id", actorId)
    .eq("event_id", eventId)
    .eq("active", true)
    .lte("starts_at", now)
    .or(`ends_at.is.null,ends_at.gt.${now}`)
    .in("role", allowedRoles)
    .limit(1);
  if (error || !data?.length) throw new TransactionStoreError("FORBIDDEN");
}

function normalizedTicket(row: Record<string, unknown>, holderEmail = ""): Ticket {
  return {
    id: String(row.id), eventId: String(row.event_id), userId: String(row.customer_id),
    orderId: String(row.order_id), ticketTypeId: String(row.ticket_type_id),
    ticketCode: String(row.ticket_code), tokenHash: String(row.token_hash), tokenPreview: String(row.token_preview),
    status: String(row.status) as Ticket["status"],
    statusBeforeSuspension: row.status_before_suspension ? String(row.status_before_suspension) as Ticket["statusBeforeSuspension"] : undefined,
    holderName: String(row.holder_name), holderEmail,
    checkedInAt: row.checked_in_at ? String(row.checked_in_at) : undefined,
    checkedInBy: row.checked_in_by ? String(row.checked_in_by) : undefined,
    createdAt: String(row.created_at),
  };
}

export async function verifyNormalizedTicket(ticketId: string, token: string, expectedEventId?: string) {
  assertNormalizedStore();
  const { data, error } = await createSupabaseAdminClient().from("tickets")
    .select("id,order_id,event_id,customer_id,ticket_type_id,ticket_code,token_hash,token_preview,holder_name,status,status_before_suspension,checked_in_at,checked_in_by,created_at")
    .eq("id", ticketId)
    .eq("token_hash", sha256(token))
    .maybeSingle();
  if (error) throw new TransactionStoreError("TRANSACTION_STORE_UNAVAILABLE");
  if (!data) return { result: "invalid" as const, ticket: null };
  const ticket = normalizedTicket(data);
  if (expectedEventId && ticket.eventId !== expectedEventId) return { result: "wrong_event" as const, ticket };
  if (ticket.status === "checked_in") return { result: "already_checked_in" as const, ticket };
  if (ticket.status !== "valid") return { result: ticket.status, ticket };
  return { result: "valid" as const, ticket };
}

export async function checkInNormalizedTicket(input: {
  ticketId: string;
  token?: string;
  eventId: string;
  actorId: string;
  notes?: string;
  manual?: boolean;
}) {
  assertNormalizedStore();
  await assertNormalizedEventAssignment(input.actorId, input.eventId, ["scanner_only", "door_staff", "event_admin"]);
  const client = createSupabaseAdminClient();
  let tokenHash = input.token ? sha256(input.token) : "";
  if (input.manual) {
    const { data } = await client.from("tickets").select("token_hash,event_id").eq("id", input.ticketId).maybeSingle();
    if (!data || String(data.event_id) !== input.eventId) return { result: "wrong_event" as const, ticket: null, record: null };
    tokenHash = String(data.token_hash);
  }
  const { data, error } = await client.rpc("skie_check_in", {
    p_ticket_id: input.ticketId,
    p_token_hash: tokenHash,
    p_expected_event_id: input.eventId,
    p_actor_id: input.actorId,
    p_notes: input.notes || "",
  });
  if (error) throw new TransactionStoreError(safeDatabaseCode(error));
  const result = firstRow(data);
  const { data: row, error: ticketError } = await client.from("tickets")
    .select("id,order_id,event_id,customer_id,ticket_type_id,ticket_code,token_hash,token_preview,holder_name,status,status_before_suspension,checked_in_at,checked_in_by,created_at")
    .eq("id", input.ticketId)
    .maybeSingle();
  if (ticketError) throw new TransactionStoreError("TRANSACTION_STORE_UNAVAILABLE");
  return { result: String(result.result), ticket: row ? normalizedTicket(row) : null, record: null };
}

export async function searchNormalizedDoorTickets(query: string, eventId: string, actorId: string) {
  assertNormalizedStore();
  await assertNormalizedEventAssignment(actorId, eventId, ["scanner_only", "door_staff", "event_admin"]);
  const safeQuery = query.trim().replaceAll(/[%,()]/g, "").slice(0, 120);
  if (safeQuery.length < 2) return [];
  const { data, error } = await createSupabaseAdminClient().from("tickets")
    .select("id,order_id,event_id,customer_id,ticket_type_id,ticket_code,token_hash,token_preview,holder_name,status,status_before_suspension,checked_in_at,checked_in_by,created_at")
    .eq("event_id", eventId)
    .or(`holder_name.ilike.%${safeQuery}%,ticket_code.ilike.%${safeQuery}%`)
    .limit(30);
  if (error) throw new TransactionStoreError("TRANSACTION_STORE_UNAVAILABLE");
  return (data || []).map((row) => normalizedTicket(row));
}

export async function getNormalizedOrderEntitlements(orderId: string, eventId: string, actorId: string) {
  assertNormalizedStore();
  await assertNormalizedEventAssignment(actorId, eventId, ["door_staff", "event_admin"]);
  const { data, error } = await createSupabaseAdminClient().from("entitlements")
    .select("id,name,quantity_remaining,status,event_id")
    .eq("order_id", orderId)
    .eq("event_id", eventId)
    .eq("status", "active");
  if (error) throw new TransactionStoreError("TRANSACTION_STORE_UNAVAILABLE");
  return data || [];
}

export async function redeemNormalizedEntitlement(input: {
  entitlementId: string;
  eventId: string;
  quantity: number;
  actorId: string;
  idempotencyKey: string;
}) {
  assertNormalizedStore();
  await assertNormalizedEventAssignment(input.actorId, input.eventId, ["door_staff", "event_admin"]);
  const { data, error } = await createSupabaseAdminClient().rpc("skie_redeem_entitlement", {
    p_entitlement_id: input.entitlementId,
    p_expected_event_id: input.eventId,
    p_quantity: input.quantity,
    p_actor_id: input.actorId,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw new TransactionStoreError(safeDatabaseCode(error));
  return data;
}
