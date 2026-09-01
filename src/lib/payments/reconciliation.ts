import type { Order, Payment } from "../../types/site";

export type PaidStripeCheckoutEvent =
  | "checkout.session.completed"
  | "checkout.session.async_payment_succeeded";

export type TerminalStripeCheckoutEvent =
  | "checkout.session.async_payment_failed"
  | "checkout.session.expired";

export type StripeCheckoutSnapshot = {
  eventId: string;
  eventType: PaidStripeCheckoutEvent | TerminalStripeCheckoutEvent;
  eventCreatedAtMs: number;
  sessionId: string;
  metadataOrderId: string | null;
  clientReferenceOrderId: string | null;
  paymentStatus: string;
  amountTotal: number | null;
  currency: string | null;
  paymentIntentId: string | null;
};

function assertSessionIdentity(
  order: Order,
  snapshot: StripeCheckoutSnapshot,
  requirePaymentIntent: boolean,
) {
  if (!snapshot.metadataOrderId || !snapshot.clientReferenceOrderId) {
    throw new Error("Stripe session is missing its order references.");
  }
  if (snapshot.metadataOrderId !== order.id || snapshot.clientReferenceOrderId !== order.id) {
    throw new Error("Stripe session order reference does not match.");
  }
  if (!order.stripeCheckoutSessionId || order.stripeCheckoutSessionId !== snapshot.sessionId) {
    throw new Error("Stripe Checkout Session does not match the stored order.");
  }
  if (requirePaymentIntent && !snapshot.paymentIntentId) {
    throw new Error("Stripe session is missing its PaymentIntent.");
  }
  if (snapshot.amountTotal === null || snapshot.amountTotal !== order.totalCents) {
    throw new Error("Stripe session amount does not match the stored order.");
  }
  if (!snapshot.currency || snapshot.currency.toUpperCase() !== order.currency.toUpperCase()) {
    throw new Error("Stripe session currency does not match the stored order.");
  }
}

export function reconcilePaidStripeSession(order: Order, snapshot: StripeCheckoutSnapshot) {
  if (
    snapshot.eventType !== "checkout.session.completed"
    && snapshot.eventType !== "checkout.session.async_payment_succeeded"
  ) {
    throw new Error("Stripe event is not supported for paid fulfilment.");
  }
  assertSessionIdentity(order, snapshot, true);

  if (["paid", "fulfilled"].includes(order.status)) {
    if (snapshot.paymentStatus !== "paid" || order.stripePaymentIntentId !== snapshot.paymentIntentId) {
      throw new Error("Stripe replay does not match the fulfilled order.");
    }
    return "replay" as const;
  }
  if (snapshot.paymentStatus !== "paid") {
    if (order.status === "pending" && snapshot.eventType === "checkout.session.completed" && snapshot.paymentStatus === "unpaid") {
      return "awaiting_payment" as const;
    }
    throw new Error("Stripe session is not paid.");
  }
  if (!Number.isFinite(snapshot.eventCreatedAtMs)) throw new Error("Stripe event time is invalid.");
  if (!["pending", "payment_received", "fulfilment_pending", "paid_unfulfilled", "cancelled", "expired", "failed", "manual_review", "recovery_failed"].includes(order.status)) {
    throw new Error("Order cannot accept Stripe payment.");
  }
  return "fulfill" as const;
}

export function reconcileTerminalStripeSession(order: Order, snapshot: StripeCheckoutSnapshot) {
  if (
    snapshot.eventType !== "checkout.session.async_payment_failed"
    && snapshot.eventType !== "checkout.session.expired"
  ) {
    throw new Error("Stripe event is not supported for terminal handling.");
  }
  assertSessionIdentity(
    order,
    snapshot,
    snapshot.eventType === "checkout.session.async_payment_failed",
  );
}

export function assertStripeReferencesAreUnique(
  order: Order,
  snapshot: StripeCheckoutSnapshot,
  orders: Order[],
  payments: Payment[],
) {
  const references = new Set([snapshot.sessionId, snapshot.paymentIntentId].filter(Boolean));
  const conflictingOrder = orders.some(
    (item) =>
      item.id !== order.id
      && (
        item.stripeCheckoutSessionId === snapshot.sessionId
        || (snapshot.paymentIntentId && item.stripePaymentIntentId === snapshot.paymentIntentId)
      ),
  );
  const conflictingPayment = payments.some(
    (payment) =>
      payment.orderId !== order.id
      && payment.provider === "stripe"
      && references.has(payment.providerReference),
  );
  if (conflictingOrder || conflictingPayment) {
    throw new Error("Stripe session or PaymentIntent is already linked to another order.");
  }
  if (order.stripePaymentIntentId && order.stripePaymentIntentId !== snapshot.paymentIntentId) {
    throw new Error("Stored Stripe PaymentIntent does not match.");
  }
}
