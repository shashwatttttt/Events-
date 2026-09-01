import "server-only";

import type Stripe from "stripe";
import { queueMetaPurchaseForOrder } from "@/lib/meta/conversions";
import { retrieveStripeCheckoutSession, stripeCheckoutSnapshot } from "@/lib/payments";
import { failPostCheckoutInitialization } from "@/lib/post-approval/cleanup";
import {
  handlePostCheckoutPaymentCancelled,
  handlePostCheckoutPaymentSucceeded,
  recordPostCheckoutAuthorizationFromPaymentIntent,
  recordPostCheckoutAuthorizationFromSession,
} from "@/lib/post-approval/service";
import { POST_CHECKOUT_MODE } from "@/lib/post-approval/types";
import {
  applyStripeDisputeUpdate,
  applyStripeRefundUpdate,
  fulfillStripeOrder,
  recordStripeCheckoutTerminalEvent,
  recordStripePaymentIntentTerminal,
} from "@/lib/operations";

export type StripeWebhookProcessingFailure = {
  status: "temporary_failure" | "permanent_failure" | "manual_review";
  code: string;
  retry: boolean;
};

type ProviderObject = Record<string, unknown> & { id: string };

function providerId(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) return String(value.id);
  return undefined;
}

function providerObject(event: Stripe.Event) {
  return event.data.object as unknown as ProviderObject;
}

export function normalizedStripeWebhookMetadata(event: Stripe.Event, correlationId: string) {
  const object = providerObject(event);
  const type = event.type;
  return {
    stripeEventId: event.id,
    eventType: type,
    livemode: event.livemode,
    objectId: object.id,
    checkoutSessionId: type.startsWith("checkout.session.") ? object.id : undefined,
    paymentIntentId: type.startsWith("payment_intent.") ? object.id : providerId(object.payment_intent),
    chargeId: type.startsWith("charge.") ? object.id : providerId(object.charge),
    refundId: type.startsWith("refund.") ? object.id : undefined,
    disputeId: type.startsWith("charge.dispute.") ? object.id : undefined,
    correlationId,
    providerCreatedAt: new Date(event.created * 1000).toISOString(),
  };
}

function refundStatus(value: unknown): "pending" | "succeeded" | "failed" {
  return value === "succeeded" ? "succeeded" : value === "failed" || value === "canceled" ? "failed" : "pending";
}

function requireText(value: unknown, code: string) {
  const result = providerId(value);
  if (!result) throw new Error(code);
  return result;
}

function requireMoney(object: ProviderObject) {
  const amount = Number(object.amount);
  const currency = typeof object.currency === "string" ? object.currency : "";
  if (!Number.isInteger(amount) || amount < 0 || !currency) throw new Error("WEBHOOK_MONEY_INVALID");
  return { amountCents: amount, currency };
}

function isPostCheckoutMetadata(metadata: unknown) {
  return Boolean(metadata && typeof metadata === "object" && "workflow_mode" in metadata
    && String((metadata as Record<string, unknown>).workflow_mode) === POST_CHECKOUT_MODE);
}

async function handleRefundObject(event: Stripe.Event, object: ProviderObject) {
  const money = requireMoney(object);
  return applyStripeRefundUpdate({
    paymentIntentId: requireText(object.payment_intent, "REFUND_PAYMENT_INTENT_MISSING"),
    refundId: object.id,
    status: refundStatus(object.status),
    ...money,
    providerCreatedAt: new Date(event.created * 1000).toISOString(),
  });
}

async function handleChargeRefunded(event: Stripe.Event, charge: ProviderObject) {
  const refunds = charge.refunds && typeof charge.refunds === "object" && "data" in charge.refunds
    ? (charge.refunds as { data?: unknown }).data
    : undefined;
  if (!Array.isArray(refunds) || refunds.length === 0) throw new Error("CHARGE_REFUND_DETAILS_MISSING");
  for (const refund of refunds) {
    if (!refund || typeof refund !== "object" || !("id" in refund)) throw new Error("CHARGE_REFUND_DETAILS_INVALID");
    await handleRefundObject(event, refund as ProviderObject);
  }
}

export async function processVerifiedStripeEvent(event: Stripe.Event) {
  const object = providerObject(event);
  const providerOccurredAt = new Date(event.created * 1000).toISOString();
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.workflow_mode === POST_CHECKOUT_MODE) {
        const expanded = await retrieveStripeCheckoutSession(session.id);
        if (!expanded) throw new Error("POST_APPROVAL_CHECKOUT_SESSION_UNAVAILABLE");
        await recordPostCheckoutAuthorizationFromSession(expanded);
        return true;
      }
      await fulfillStripeOrder(stripeCheckoutSnapshot(event, event.type));
      const orderId = session.metadata?.order_id || session.client_reference_id;
      if (orderId) await queueMetaPurchaseForOrder(orderId, providerOccurredAt).catch(() => undefined);
      return true;
    }
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.workflow_mode === POST_CHECKOUT_MODE) {
        throw new Error("POST_APPROVAL_ASYNC_PAYMENT_METHOD_NOT_ALLOWED");
      }
      await fulfillStripeOrder(stripeCheckoutSnapshot(event, event.type));
      const orderId = session.metadata?.order_id || session.client_reference_id;
      if (orderId) await queueMetaPurchaseForOrder(orderId, providerOccurredAt).catch(() => undefined);
      return true;
    }
    case "payment_intent.amount_capturable_updated": {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      if (!isPostCheckoutMetadata(paymentIntent.metadata)) return false;
      await recordPostCheckoutAuthorizationFromPaymentIntent(paymentIntent);
      return true;
    }
    case "payment_intent.succeeded": {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      if (!isPostCheckoutMetadata(paymentIntent.metadata)) return false;
      await handlePostCheckoutPaymentSucceeded(paymentIntent, event.id);
      const orderId = paymentIntent.metadata?.order_id;
      if (orderId) await queueMetaPurchaseForOrder(orderId, providerOccurredAt).catch(() => undefined);
      return true;
    }
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.workflow_mode === POST_CHECKOUT_MODE) {
        const orderId = session.metadata.order_id || session.client_reference_id;
        if (orderId) await failPostCheckoutInitialization(orderId, event.type).catch(() => undefined);
      }
      await recordStripeCheckoutTerminalEvent(stripeCheckoutSnapshot(event, event.type));
      return true;
    }
    case "payment_intent.payment_failed": {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      if (isPostCheckoutMetadata(paymentIntent.metadata)) {
        const orderId = paymentIntent.metadata.order_id;
        if (orderId) await failPostCheckoutInitialization(orderId, "PAYMENT_INTENT_FAILED").catch(() => undefined);
      }
      await recordStripePaymentIntentTerminal(object.id, "failed");
      return true;
    }
    case "payment_intent.canceled": {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      if (isPostCheckoutMetadata(paymentIntent.metadata)) {
        const reason = paymentIntent.cancellation_reason === "abandoned" ? "authorization_expired" : "rejected";
        await handlePostCheckoutPaymentCancelled(paymentIntent, reason);
        return true;
      }
      await recordStripePaymentIntentTerminal(object.id, "cancelled");
      return true;
    }
    case "refund.created":
    case "refund.updated":
      await handleRefundObject(event, object);
      return true;
    case "charge.refunded":
      await handleChargeRefunded(event, object);
      return true;
    case "charge.dispute.created": {
      const money = requireMoney(object);
      await applyStripeDisputeUpdate({
        paymentIntentId: requireText(object.payment_intent, "DISPUTE_PAYMENT_INTENT_MISSING"),
        disputeId: object.id,
        status: "needs_response",
        ...money,
        providerCreatedAt: providerOccurredAt,
      });
      return true;
    }
    case "charge.dispute.closed": {
      const money = requireMoney(object);
      const status = object.status === "won" ? "won" : object.status === "lost" ? "lost" : "closed";
      await applyStripeDisputeUpdate({
        paymentIntentId: requireText(object.payment_intent, "DISPUTE_PAYMENT_INTENT_MISSING"),
        disputeId: object.id,
        status,
        ...money,
        providerCreatedAt: providerOccurredAt,
      });
      return true;
    }
    default:
      return false;
  }
}

const MANUAL_REVIEW_CODES = new Set([
  "PAYMENT_AMOUNT_MISMATCH",
  "PAYMENT_INTENT_MISMATCH",
  "PAYMENT_ORDER_REFERENCE_MISMATCH",
  "ORPHAN_STRIPE_SESSION",
  "PAYMENT_NOT_FOUND",
  "CHARGE_REFUND_DETAILS_MISSING",
  "CHARGE_REFUND_DETAILS_INVALID",
  "REFUND_PAYMENT_INTENT_MISSING",
  "DISPUTE_PAYMENT_INTENT_MISSING",
  "POST_APPROVAL_CAPTURE_WITHOUT_APPROVAL",
  "POST_APPROVAL_APPLICATION_NOT_FOUND",
  "POST_APPROVAL_PAYMENT_NOT_AUTHORIZED",
  "POST_APPROVAL_ASYNC_PAYMENT_METHOD_NOT_ALLOWED",
  "FULFILMENT_FAILED",
  "RESERVATION_READ_FAILED",
  "RESERVATION_NOT_PAID",
  "TICKET_COUNT_MISMATCH",
  "TICKET_LINE_NOT_FOUND",
  "PRODUCT_LINE_NOT_FOUND",
  "TICKET_FULFILMENT_INCOMPLETE",
]);
const PERMANENT_FAILURE_CODES = new Set(["WEBHOOK_MONEY_INVALID", "PAYMENT_SNAPSHOT_INCOMPLETE"]);

export function classifyStripeWebhookProcessingFailure(error: unknown): StripeWebhookProcessingFailure {
  const candidate = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : error instanceof Error ? error.message : "";
  if (MANUAL_REVIEW_CODES.has(candidate)) return { status: "manual_review", code: candidate, retry: false };
  if (PERMANENT_FAILURE_CODES.has(candidate)) return { status: "permanent_failure", code: candidate, retry: false };
  return { status: "temporary_failure", code: "WEBHOOK_PROCESSING_FAILED", retry: true };
}
