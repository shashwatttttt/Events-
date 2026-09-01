import "server-only";

import { randomId } from "@/lib/security/crypto";
import type {
  CheckoutAttempt,
  EventItem,
  OperationsData,
  Order,
  PaymentAdjustment,
  Reservation,
  ReservationProductLine,
  ReservationTicketLine,
  SessionUser,
  StripeWebhookEventRecord,
} from "@/types/site";
import type { StripeCheckoutSnapshot } from "@/lib/payments/reconciliation";

export type ReservationInput = {
  order: Order;
  event: EventItem;
  customer: SessionUser;
  customerEmail: string;
  ticketLine: ReservationTicketLine;
  productLines: ReservationProductLine[];
};

export function createReservationRecords(input: ReservationInput): {
  order: Order;
  reservation: Reservation;
  checkoutAttempt: CheckoutAttempt;
} {
  const createdAt = input.order.createdAt;
  const reservationId = randomId("res");
  const checkoutAttemptId = randomId("attempt");
  const reservationVersion = 1;
  const reservation: Reservation = {
    id: reservationId,
    reservationKey: randomId("reskey"),
    version: reservationVersion,
    orderId: input.order.id,
    checkoutAttemptId,
    customerId: input.customer.id,
    customerEmail: input.customerEmail.toLowerCase(),
    customerName: `${input.customer.firstName} ${input.customer.lastName}`.trim() || "Customer",
    eventId: input.event.id,
    eventTitle: input.event.title,
    allocationId: input.order.allocationId,
    promoCodeId: input.order.promoCodeId,
    status: "reserved",
    ticketLines: [structuredClone(input.ticketLine)],
    productLines: structuredClone(input.productLines),
    expectedSubtotalCents: input.order.subtotalCents,
    expectedDiscountCents: input.order.subtotalCents - input.order.totalCents,
    expectedTotalCents: input.order.totalCents,
    currency: input.order.currency.toUpperCase(),
    expiresAt: input.order.expiresAt,
    correlationId: randomId("corr"),
    createdAt,
    updatedAt: createdAt,
  };
  const checkoutAttempt: CheckoutAttempt = {
    id: checkoutAttemptId,
    reservationId,
    reservationVersion,
    orderId: input.order.id,
    status: "creating_session",
    idempotencyKey: input.order.idempotencyKey,
    correlationId: reservation.correlationId,
    recoveryAttempts: 0,
    createdAt,
    updatedAt: createdAt,
  };
  const order: Order = {
    ...input.order,
    reservationId,
    reservationVersion,
    checkoutAttemptId,
  };
  return { order, reservation, checkoutAttempt };
}

export function assertReservationMatchesOrder(reservation: Reservation, order: Order) {
  if (reservation.orderId !== order.id || reservation.customerId !== order.userId || reservation.eventId !== order.eventId) {
    throw new Error("RESERVATION_IDENTITY_MISMATCH");
  }
  if (reservation.expectedTotalCents !== order.totalCents || reservation.currency !== order.currency.toUpperCase()) {
    throw new Error("RESERVATION_TOTAL_MISMATCH");
  }
  const snapshotTotal = [...reservation.ticketLines, ...reservation.productLines]
    .reduce((total, line) => total + line.quantity * line.unitPriceCents, 0);
  if (snapshotTotal !== reservation.expectedSubtotalCents) throw new Error("RESERVATION_LINES_MISMATCH");
  if (reservation.expectedSubtotalCents - reservation.expectedDiscountCents !== reservation.expectedTotalCents) {
    throw new Error("RESERVATION_DISCOUNT_MISMATCH");
  }
}

export function linkLocalStripeSession(
  operations: OperationsData,
  checkoutAttemptId: string,
  sessionId: string,
  providerExpiresAt: string,
) {
  const attempt = operations.checkoutAttempts.find((item) => item.id === checkoutAttemptId);
  if (!attempt) throw new Error("CHECKOUT_ATTEMPT_NOT_FOUND");
  if (attempt.stripeCheckoutSessionId) {
    if (attempt.stripeCheckoutSessionId !== sessionId) throw new Error("CHECKOUT_SESSION_ALREADY_LINKED");
    return attempt;
  }
  if (operations.checkoutAttempts.some((item) => item.stripeCheckoutSessionId === sessionId)) {
    throw new Error("CHECKOUT_SESSION_ALREADY_LINKED");
  }
  if (attempt.status !== "creating_session") throw new Error("CHECKOUT_ATTEMPT_NOT_LINKABLE");
  const reservation = operations.reservations.find((item) => item.id === attempt.reservationId);
  const order = operations.orders.find((item) => item.id === attempt.orderId);
  if (!reservation || !order) throw new Error("CHECKOUT_DATA_INCOMPLETE");
  const updatedAt = new Date().toISOString();
  attempt.stripeCheckoutSessionId = sessionId;
  attempt.providerExpiresAt = providerExpiresAt;
  attempt.status = "session_active";
  attempt.updatedAt = updatedAt;
  reservation.status = "session_active";
  reservation.updatedAt = updatedAt;
  order.stripeCheckoutSessionId = sessionId;
  order.updatedAt = updatedAt;
  return attempt;
}

export function recordLocalStripeWebhook(
  operations: OperationsData,
  event: Omit<StripeWebhookEventRecord, "status" | "processingAttempts" | "receivedAt">,
) {
  const existing = operations.stripeWebhookEvents.find((item) => item.stripeEventId === event.stripeEventId);
  if (existing) return { event: existing, duplicate: true };
  const record: StripeWebhookEventRecord = {
    ...event,
    status: "received",
    processingAttempts: 0,
    receivedAt: new Date().toISOString(),
  };
  operations.stripeWebhookEvents.push(record);
  return { event: record, duplicate: false };
}

export function markLocalWebhookResult(
  operations: OperationsData,
  stripeEventId: string,
  status: StripeWebhookEventRecord["status"],
  safeErrorCode?: string,
) {
  const event = operations.stripeWebhookEvents.find((item) => item.stripeEventId === stripeEventId);
  if (!event) throw new Error("WEBHOOK_EVENT_NOT_FOUND");
  event.status = status;
  event.safeErrorCode = safeErrorCode;
  event.processingAttempts += 1;
  if (status === "processed") event.processedAt = new Date().toISOString();
  return event;
}

export function recordLocalPaymentReceived(
  operations: OperationsData,
  order: Order,
  snapshot: StripeCheckoutSnapshot,
) {
  const reservation = operations.reservations.find((item) => item.id === order.reservationId);
  const attempt = operations.checkoutAttempts.find((item) => item.id === order.checkoutAttemptId);
  if (!reservation || !attempt) throw new Error("PAYMENT_RESERVATION_NOT_FOUND");
  assertReservationMatchesOrder(reservation, order);
  if (snapshot.amountTotal !== reservation.expectedTotalCents || snapshot.currency?.toUpperCase() !== reservation.currency) {
    reservation.status = "manual_review";
    reservation.failureCode = "PAYMENT_AMOUNT_MISMATCH";
    order.status = "manual_review";
    throw new Error("PAYMENT_AMOUNT_MISMATCH");
  }
  const existing = operations.payments.find((payment) =>
    payment.provider === "stripe" && payment.providerReference === snapshot.paymentIntentId,
  );
  if (!existing) {
    operations.payments.push({
      id: randomId("pay"),
      orderId: order.id,
      provider: "stripe",
      providerReference: snapshot.paymentIntentId || snapshot.sessionId,
      amountCents: reservation.expectedTotalCents,
      currency: reservation.currency,
      status: "payment_received",
      createdAt: new Date(snapshot.eventCreatedAtMs).toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  const updatedAt = new Date().toISOString();
  order.status = "payment_received";
  order.paidAt = new Date(snapshot.eventCreatedAtMs).toISOString();
  order.stripePaymentIntentId = snapshot.paymentIntentId || undefined;
  order.updatedAt = updatedAt;
  reservation.status = "payment_received";
  reservation.failureCode = undefined;
  reservation.updatedAt = updatedAt;
  attempt.status = "payment_received";
  attempt.stripePaymentIntentId = snapshot.paymentIntentId || undefined;
  attempt.updatedAt = updatedAt;
  return { reservation, attempt, duplicate: Boolean(existing) };
}

export function markLocalPaidUnfulfilled(
  operations: OperationsData,
  reservationId: string,
  safeErrorCode: string,
) {
  const reservation = operations.reservations.find((item) => item.id === reservationId);
  if (!reservation) throw new Error("RESERVATION_NOT_FOUND");
  const order = operations.orders.find((item) => item.id === reservation.orderId);
  const attempt = operations.checkoutAttempts.find((item) => item.id === reservation.checkoutAttemptId);
  if (!order || !attempt) throw new Error("CHECKOUT_DATA_INCOMPLETE");
  const updatedAt = new Date().toISOString();
  reservation.status = "paid_unfulfilled";
  reservation.failureCode = safeErrorCode;
  reservation.updatedAt = updatedAt;
  order.status = "paid_unfulfilled";
  order.updatedAt = updatedAt;
  attempt.failureCode = safeErrorCode;
  attempt.updatedAt = updatedAt;
  return reservation;
}

export type LocalRefundInput = {
  providerObjectId: string;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  status: "pending" | "succeeded" | "failed";
  lineAttribution?: PaymentAdjustment["lineAttribution"];
};

export function applyLocalRefund(operations: OperationsData, input: LocalRefundInput) {
  const duplicate = operations.paymentAdjustments.find((item) => item.providerObjectId === input.providerObjectId);
  const payment = operations.payments.find((item) => item.provider === "stripe" && item.providerReference === input.paymentIntentId);
  if (!payment) throw new Error("PAYMENT_NOT_FOUND");
  const order = operations.orders.find((item) => item.id === payment.orderId);
  if (!order) throw new Error("ORDER_NOT_FOUND");
  if (duplicate?.status === input.status) return { order, duplicate: true };
  if (input.currency.toUpperCase() !== payment.currency.toUpperCase() || input.amountCents > payment.amountCents) {
    throw new Error("REFUND_AMOUNT_MISMATCH");
  }
  const now = new Date().toISOString();
  if (duplicate) {
    duplicate.status = input.status;
    duplicate.updatedAt = now;
    duplicate.lineAttribution = input.lineAttribution || duplicate.lineAttribution;
  } else {
    operations.paymentAdjustments.push({
      id: randomId("adjustment"),
      orderId: order.id,
      paymentId: payment.id,
      kind: "refund",
      providerObjectId: input.providerObjectId,
      status: input.status,
      amountCents: input.amountCents,
      currency: input.currency.toUpperCase(),
      lineAttribution: input.lineAttribution,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (input.status === "failed") return { order, duplicate: false };
  const reservation = operations.reservations.find((item) => item.id === order.reservationId);
  if (input.status === "pending") {
    order.status = "refund_pending";
    payment.status = "refund_pending";
    if (reservation) reservation.status = "refund_pending";
    return { order, duplicate: false };
  }
  const refundedCents = operations.paymentAdjustments
    .filter((item) => item.paymentId === payment.id && item.kind === "refund" && item.status === "succeeded")
    .reduce((total, item) => total + item.amountCents, 0);
  payment.refundedCents = refundedCents;
  if (refundedCents >= payment.amountCents) {
    order.status = "refunded";
    payment.status = "refunded";
    if (reservation) reservation.status = "refunded";
    operations.tickets.filter((item) => item.orderId === order.id).forEach((item) => { item.status = "refunded"; });
    operations.entitlements.filter((item) => item.orderId === order.id).forEach((item) => { item.status = "refunded"; });
  } else if (!input.lineAttribution?.length) {
    order.status = "manual_review";
    payment.status = "manual_review";
    if (reservation) {
      reservation.status = "manual_review";
      reservation.failureCode = "UNATTRIBUTABLE_PARTIAL_REFUND";
    }
  } else {
    order.status = "partially_refunded";
    payment.status = "partially_refunded";
    if (reservation) reservation.status = "partially_refunded";
    const ticketIds = new Set(input.lineAttribution.flatMap((item) => item.ticketIds || []));
    const entitlementIds = new Set(input.lineAttribution.flatMap((item) => item.entitlementIds || []));
    operations.tickets.filter((item) => ticketIds.has(item.id)).forEach((item) => { item.status = "refunded"; });
    operations.entitlements.filter((item) => entitlementIds.has(item.id)).forEach((item) => { item.status = "refunded"; });
  }
  order.updatedAt = now;
  payment.updatedAt = now;
  return { order, duplicate: false };
}

export type LocalDisputeInput = {
  providerObjectId: string;
  paymentIntentId: string;
  amountCents: number;
  currency: string;
  status: "needs_response" | "won" | "lost" | "closed";
};

export function applyLocalDispute(operations: OperationsData, input: LocalDisputeInput) {
  const payment = operations.payments.find((item) => item.provider === "stripe" && item.providerReference === input.paymentIntentId);
  if (!payment) throw new Error("PAYMENT_NOT_FOUND");
  const order = operations.orders.find((item) => item.id === payment.orderId);
  if (!order) throw new Error("ORDER_NOT_FOUND");
  const existing = operations.paymentAdjustments.find((item) => item.providerObjectId === input.providerObjectId);
  if (existing?.status === input.status) return { order, duplicate: true };
  if (input.amountCents !== payment.amountCents || input.currency.toUpperCase() !== payment.currency.toUpperCase()) {
    throw new Error("DISPUTE_AMOUNT_MISMATCH");
  }
  const now = new Date().toISOString();
  if (existing) {
    existing.status = input.status;
    existing.updatedAt = now;
  } else {
    operations.paymentAdjustments.push({
      id: randomId("adjustment"),
      orderId: order.id,
      paymentId: payment.id,
      kind: "dispute",
      providerObjectId: input.providerObjectId,
      status: input.status,
      amountCents: input.amountCents,
      currency: input.currency.toUpperCase(),
      createdAt: now,
      updatedAt: now,
    });
  }
  const reservation = operations.reservations.find((item) => item.id === order.reservationId);
  if (input.status === "needs_response") {
    order.status = "disputed";
    payment.status = "disputed";
    if (reservation) reservation.status = "disputed";
    operations.tickets.filter((item) => item.orderId === order.id && !["refunded", "cancelled", "expired"].includes(item.status))
      .forEach((item) => {
        item.statusBeforeSuspension = item.status === "suspended" ? item.statusBeforeSuspension : item.status;
        item.status = "suspended";
      });
    operations.entitlements.filter((item) => item.orderId === order.id && !["refunded", "cancelled"].includes(item.status))
      .forEach((item) => {
        item.statusBeforeSuspension = item.status === "suspended" ? item.statusBeforeSuspension : item.status;
        item.status = "suspended";
      });
  } else if (input.status === "won") {
    order.status = "fulfilled";
    payment.status = "paid";
    if (reservation) reservation.status = "fulfilled";
    operations.tickets.filter((item) => item.orderId === order.id && item.status === "suspended")
      .forEach((item) => {
        item.status = item.statusBeforeSuspension || "valid";
        item.statusBeforeSuspension = undefined;
      });
    operations.entitlements.filter((item) => item.orderId === order.id && item.status === "suspended")
      .forEach((item) => {
        item.status = item.statusBeforeSuspension || "active";
        item.statusBeforeSuspension = undefined;
      });
  } else {
    order.status = "refunded";
    payment.status = "refunded";
    payment.refundedCents = payment.amountCents;
    if (reservation) reservation.status = "refunded";
    operations.tickets.filter((item) => item.orderId === order.id).forEach((item) => { item.status = "refunded"; });
    operations.entitlements.filter((item) => item.orderId === order.id).forEach((item) => { item.status = "refunded"; });
  }
  order.updatedAt = now;
  payment.updatedAt = now;
  return { order, duplicate: false };
}
