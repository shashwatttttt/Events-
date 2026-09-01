import "server-only";
import Stripe from "stripe";
import { config } from "@/lib/config";
import { isEffectiveTestMode } from "@/lib/mode";
import { mutateOperationsData, readOperationsData } from "@/lib/data/documents";
import { linkLocalStripeSession } from "@/lib/payments/state";
import {
  expireNormalizedSessionState,
  failNormalizedCheckoutCreation,
  findNormalizedOrderStatusBySession,
  linkNormalizedStripeSession,
} from "@/lib/payments/transaction-store";
import {
  allocatePromoDiscount,
  promoLineKey,
  validatePromoDiscountAllocation,
  type PromoDiscountAllocation,
} from "@/lib/promos/allocation";
import { loadOrderDiscountAllocation } from "@/lib/promos/order-allocation-store";
import type { Order } from "@/types/site";
import type {
  PaidStripeCheckoutEvent,
  StripeCheckoutSnapshot,
  TerminalStripeCheckoutEvent,
} from "@/lib/payments/reconciliation";
import { POST_CHECKOUT_MODE } from "@/lib/post-approval/types";

export function buildStripeLineItems(
  order: Order,
  suppliedAllocation?: PromoDiscountAllocation[],
) {
  const discountCents = order.subtotalCents - order.totalCents;
  if (discountCents !== (order.discountCents || 0) || discountCents < 0) {
    throw new Error("ORDER_DISCOUNT_SNAPSHOT_INVALID");
  }
  const allocation = suppliedAllocation
    ? validatePromoDiscountAllocation(order.items, discountCents, suppliedAllocation)
    : allocatePromoDiscount({ items: order.items, discountCents });
  const discountByLine = new Map(allocation.map((item) => [promoLineKey(item), item.discountCents]));
  const lines = order.items.flatMap((item) => {
    const originalLineCents = item.quantity * item.unitPriceCents;
    const lineDiscount = discountByLine.get(promoLineKey(item)) || 0;
    const amount = originalLineCents - lineDiscount;
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("ORDER_DISCOUNT_ALLOCATION_INVALID");
    if (amount === 0) return [];
    return [{
      quantity: 1,
      price_data: {
        currency: order.currency.toLowerCase(),
        unit_amount: amount,
        product_data: {
          name: item.quantity === 1 ? item.name : `${item.name} × ${item.quantity}`,
          metadata: {
            kind: item.kind,
            reference_id: item.referenceId,
            original_quantity: String(item.quantity),
            discount_cents: String(lineDiscount),
          },
        },
      },
    }];
  });
  const total = lines.reduce((sum, line) => sum + line.price_data.unit_amount, 0);
  if (total !== order.totalCents) throw new Error("ORDER_DISCOUNT_SNAPSHOT_INVALID");
  return lines;
}

async function failCheckoutCreation(order: Order) {
  if (!order.checkoutAttemptId) return;
  if (config.dataProvider === "supabase") {
    await failNormalizedCheckoutCreation(order.checkoutAttemptId);
    return;
  }
  await mutateOperationsData((ops) => {
    const attempt = ops.checkoutAttempts.find((item) => item.id === order.checkoutAttemptId);
    const reservation = ops.reservations.find((item) => item.id === order.reservationId);
    const storedOrder = ops.orders.find((item) => item.id === order.id);
    if (!attempt || !reservation || !storedOrder || attempt.status !== "creating_session" || reservation.status !== "reserved") return;
    const timestamp = new Date().toISOString();
    attempt.status = "session_failed"; attempt.failureCode = "SESSION_CREATION_FAILED"; attempt.updatedAt = timestamp;
    reservation.status = "failed"; reservation.failureCode = "SESSION_CREATION_FAILED"; reservation.updatedAt = timestamp;
    storedOrder.status = "failed"; storedOrder.updatedAt = timestamp;
    const redemption = ops.promoRedemptions.find((item) => item.reservationId === reservation.id && item.status === "reserved");
    if (redemption) { redemption.status = "released"; redemption.releasedAt = timestamp; redemption.updatedAt = timestamp; }
    const allocation = reservation.allocationId ? ops.allocations.find((item) => item.id === reservation.allocationId) : undefined;
    if (allocation?.status === "checkout_started") allocation.status = new Date(allocation.expiresAt) <= new Date() ? "expired" : "unlocked";
  });
}

async function markUnlinkedSessionForReview(order: Order, sessionId: string) {
  if (config.dataProvider === "supabase") {
    await expireNormalizedSessionState(sessionId, "orphan").catch(() => undefined);
    return;
  }
  await mutateOperationsData((ops) => {
    const attempt = ops.checkoutAttempts.find((item) => item.id === order.checkoutAttemptId);
    if (attempt) {
      attempt.status = "orphan_session";
      attempt.stripeCheckoutSessionId = sessionId;
      attempt.failureCode = "SESSION_LINK_FAILED";
      attempt.updatedAt = new Date().toISOString();
    }
  }).catch(() => undefined);
}

async function abandonUnlinkedStripeSession(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  order: Order,
) {
  try {
    await stripe.checkout.sessions.expire(session.id);
  } catch {
    await markUnlinkedSessionForReview(order, session.id);
    return false;
  }

  try {
    await failCheckoutCreation(order);
  } catch {
    throw new Error("CHECKOUT_CREATION_RELEASE_FAILED");
  }
  return true;
}

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || (!key.startsWith("sk_test_") && !key.startsWith("sk_live_"))) {
    throw new Error("STRIPE_CONFIGURATION_INVALID");
  }
  return new Stripe(key);
}

export type CheckoutCreationOptions = {
  postCheckoutApproval?: boolean;
};

export async function createCheckoutForOrder(order: Order, customerEmail: string, options: CheckoutCreationOptions = {}) {
  const testMode = await isEffectiveTestMode();
  if (config.appMode === "live" && testMode) throw new Error("CHECKOUT_MODE_MISMATCH");
  if (testMode) {
    const target = options.postCheckoutApproval
      ? `${config.siteUrl}/payment/application?order=${encodeURIComponent(order.id)}&provider=test`
      : `${config.siteUrl}/checkout/test?order=${encodeURIComponent(order.id)}`;
    return { provider: "test" as const, url: target };
  }
  if (!order.reservationId || !order.checkoutAttemptId || !order.reservationVersion) {
    throw new Error("CHECKOUT_RESERVATION_MISSING");
  }
  const stripe = stripeClient();
  const workflowMode = options.postCheckoutApproval ? POST_CHECKOUT_MODE : "standard";
  let session: Stripe.Checkout.Session;
  try {
    const discountAllocation = await loadOrderDiscountAllocation(order);
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: customerEmail,
      client_reference_id: order.id,
      line_items: buildStripeLineItems(order, discountAllocation),
      ...(options.postCheckoutApproval ? { payment_method_types: ["card" as const] } : {}),
      metadata: {
        order_id: order.id,
        reservation_id: order.reservationId,
        reservation_version: String(order.reservationVersion),
        checkout_attempt_id: order.checkoutAttemptId,
        event_id: order.eventId,
        user_id: order.userId,
        allocation_id: order.allocationId || "",
        promo_code_id: order.promoCodeId || "",
        promo_code: order.promoCodeSnapshot || "",
        subtotal_cents: String(order.subtotalCents),
        discount_cents: String(order.discountCents || 0),
        expected_total_cents: String(order.totalCents),
        workflow_mode: workflowMode,
      },
      success_url: options.postCheckoutApproval
        ? `${config.siteUrl}/payment/application?session_id={CHECKOUT_SESSION_ID}`
        : `${config.siteUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.siteUrl}/account?checkout=cancelled`,
      expires_at: Math.floor(new Date(order.expiresAt).getTime() / 1000),
      payment_intent_data: {
        ...(options.postCheckoutApproval ? { capture_method: "manual" as const } : {}),
        metadata: {
          order_id: order.id,
          reservation_id: order.reservationId,
          checkout_attempt_id: order.checkoutAttemptId,
          event_id: order.eventId,
          user_id: order.userId,
          promo_code_id: order.promoCodeId || "",
          promo_code: order.promoCodeSnapshot || "",
          subtotal_cents: String(order.subtotalCents),
          discount_cents: String(order.discountCents || 0),
          expected_total_cents: String(order.totalCents),
          workflow_mode: workflowMode,
        },
      },
    }, { idempotencyKey: order.idempotencyKey });
  } catch {
    try {
      await failCheckoutCreation(order);
    } catch {
      throw new Error("CHECKOUT_CREATION_RELEASE_FAILED");
    }
    throw new Error("CHECKOUT_SESSION_CREATION_FAILED");
  }

  if (!session.url) {
    await abandonUnlinkedStripeSession(stripe, session, order);
    throw new Error("CHECKOUT_SESSION_URL_MISSING");
  }

  try {
    const providerExpiresAt = new Date(
      (session.expires_at || Math.floor(new Date(order.expiresAt).getTime() / 1000)) * 1000,
    ).toISOString();
    if (config.dataProvider === "supabase") {
      await linkNormalizedStripeSession(order.checkoutAttemptId, session.id, providerExpiresAt);
    } else {
      await mutateOperationsData((ops) => {
        linkLocalStripeSession(ops, order.checkoutAttemptId!, session.id, providerExpiresAt);
      });
    }
  } catch {
    await abandonUnlinkedStripeSession(stripe, session, order);
    throw new Error("CHECKOUT_SESSION_LINK_FAILED");
  }
  return { provider: "stripe" as const, url: session.url, sessionId: session.id };
}

export async function expireStripeCheckoutSession(sessionId: string) {
  if (config.appMode !== "live") return { id: sessionId, status: "expired" as const };
  const session = await stripeClient().checkout.sessions.expire(sessionId);
  return { id: session.id, status: session.status };
}

export async function retrieveStripeOrder(sessionId: string) {
  if (config.appMode !== "live") return null;
  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const orderId = session.metadata?.order_id || session.client_reference_id;
  if (!orderId) return null;
  if (config.dataProvider === "supabase") {
    return { session, order: await findNormalizedOrderStatusBySession(sessionId) };
  }
  const ops = await readOperationsData();
  return { session, order: ops.orders.find((item) => item.id === orderId) || null };
}

export async function retrieveStripeCheckoutSession(sessionId: string) {
  if (config.appMode !== "live") return null;
  return stripeClient().checkout.sessions.retrieve(sessionId, { expand: ["payment_intent", "payment_intent.latest_charge"] });
}

export async function retrieveStripePaymentIntent(paymentIntentId: string) {
  if (config.appMode !== "live") return null;
  return stripeClient().paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
}

export async function captureStripePaymentIntent(paymentIntentId: string, idempotencyKey: string) {
  if (config.appMode !== "live") {
    return { id: paymentIntentId, status: "succeeded", amount_received: 0, amount_capturable: 0 } as const;
  }
  return stripeClient().paymentIntents.capture(paymentIntentId, {}, { idempotencyKey });
}

export async function cancelStripePaymentIntent(paymentIntentId: string, idempotencyKey: string) {
  if (config.appMode !== "live") return { id: paymentIntentId, status: "canceled" } as const;
  return stripeClient().paymentIntents.cancel(paymentIntentId, {}, { idempotencyKey });
}

export function stripeCaptureBefore(paymentIntent: Stripe.PaymentIntent | null | undefined) {
  const charge = paymentIntent?.latest_charge;
  if (!charge || typeof charge === "string") return undefined;
  const details = charge.payment_method_details;
  const card = details?.type === "card" ? details.card : undefined;
  const captureBefore = card && "capture_before" in card ? Number(card.capture_before) : 0;
  return Number.isFinite(captureBefore) && captureBefore > 0
    ? new Date(captureBefore * 1000).toISOString()
    : undefined;
}

export async function retrieveStripeSnapshotForRecovery(sessionId: string): Promise<StripeCheckoutSnapshot | null> {
  if (config.appMode !== "live") {
    const ops = await readOperationsData();
    const attempt = ops.checkoutAttempts.find((item) => item.stripeCheckoutSessionId === sessionId);
    const order = ops.orders.find((item) => item.id === attempt?.orderId);
    const payment = ops.payments.find((item) => item.orderId === order?.id && item.provider === "stripe");
    if (!attempt || !order || !payment) return null;
    return {
      eventId: `recovery_${payment.providerReference}`,
      eventType: "checkout.session.async_payment_succeeded",
      eventCreatedAtMs: new Date(payment.createdAt).getTime(),
      sessionId,
      metadataOrderId: order.id,
      clientReferenceOrderId: order.id,
      paymentStatus: "paid",
      amountTotal: payment.amountCents,
      currency: payment.currency.toLowerCase(),
      paymentIntentId: payment.providerReference,
    };
  }
  const session = await stripeClient().checkout.sessions.retrieve(sessionId);
  return {
    eventId: `recovery_${session.id}_${stripeObjectId(session.payment_intent) || "pending"}`,
    eventType: "checkout.session.async_payment_succeeded",
    eventCreatedAtMs: session.created * 1000,
    sessionId: session.id,
    metadataOrderId: session.metadata?.order_id || null,
    clientReferenceOrderId: session.client_reference_id || null,
    paymentStatus: session.payment_status,
    amountTotal: session.amount_total,
    currency: session.currency,
    paymentIntentId: stripeObjectId(session.payment_intent),
  };
}

export async function requestStripeFullRefund(paymentIntentId: string, idempotencyKey: string) {
  if (config.appMode !== "live") return { provider: "test" as const, status: "dry_run" as const };
  const refund = await stripeClient().refunds.create({ payment_intent: paymentIntentId }, { idempotencyKey });
  return { provider: "stripe" as const, id: refund.id, status: refund.status };
}

export function constructStripeEvent(payload: string | Buffer, signature: string) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is missing.");
  return stripeClient().webhooks.constructEvent(payload, signature, secret);
}

function stripeObjectId(value: string | { id: string } | null) {
  if (typeof value === "string") return value;
  return value?.id || null;
}

export function stripeCheckoutSnapshot(
  event: Stripe.Event,
  eventType: PaidStripeCheckoutEvent | TerminalStripeCheckoutEvent,
): StripeCheckoutSnapshot {
  const session = event.data.object as Stripe.Checkout.Session;
  return {
    eventId: event.id,
    eventType,
    eventCreatedAtMs: event.created * 1000,
    sessionId: session.id,
    metadataOrderId: session.metadata?.order_id || null,
    clientReferenceOrderId: session.client_reference_id || null,
    paymentStatus: session.payment_status,
    amountTotal: session.amount_total,
    currency: session.currency,
    paymentIntentId: stripeObjectId(session.payment_intent),
  };
}
