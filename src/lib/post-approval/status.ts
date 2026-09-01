import "server-only";

import type Stripe from "stripe";
import {
  retrieveStripeCheckoutSession,
  retrieveStripePaymentIntent,
  stripeCaptureBefore,
} from "@/lib/payments";
import { loadOwnedPostCheckoutApplication } from "@/lib/post-approval/service";
import { recordPostCheckoutAuthorization } from "@/lib/post-approval/store";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function safeDiagnosticCode(error: unknown) {
  const candidate = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : error instanceof Error ? error.message : "";
  return /^[A-Z0-9_]{3,100}$/.test(candidate)
    ? candidate
    : "POST_APPROVAL_RETURN_RECONCILIATION_FAILED";
}

async function reconcileCompletedAuthorization(
  session: Stripe.Checkout.Session,
  orderId: string,
) {
  const paymentIntent = typeof session.payment_intent === "string"
    ? await retrieveStripePaymentIntent(session.payment_intent)
    : session.payment_intent as Stripe.PaymentIntent | null;

  if (!paymentIntent) throw new Error("POST_APPROVAL_PAYMENT_INTENT_MISSING");
  if (paymentIntent.status !== "requires_capture") {
    throw new Error("POST_APPROVAL_PAYMENT_NOT_AUTHORIZED");
  }

  await recordPostCheckoutAuthorization({
    orderId,
    checkoutSessionId: session.id,
    paymentIntentId: paymentIntent.id,
    amountCents: paymentIntent.amount,
    capturableCents: paymentIntent.amount_capturable,
    currency: paymentIntent.currency.trim().toUpperCase(),
    captureBefore: stripeCaptureBefore(paymentIntent),
  });
}

export async function getPostCheckoutStatusForStripeSession(sessionId: string, userId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("checkout_attempts")
    .select("order_id,orders(customer_id)")
    .eq("stripe_checkout_session_id", sessionId)
    .maybeSingle();

  if (error || !data) return null;
  const joinedOrder = Array.isArray(data.orders) ? data.orders[0] : data.orders;
  if (!joinedOrder || String(joinedOrder.customer_id) !== userId) return null;

  const orderId = String(data.order_id);
  let current = await loadOwnedPostCheckoutApplication(orderId, userId);
  if (!current || current.application.paymentStatus !== "authorization_pending") return current;

  try {
    const session = await retrieveStripeCheckoutSession(sessionId);
    const providerOrderId = session?.metadata?.order_id || session?.client_reference_id;
    const providerUserId = session?.metadata?.user_id;

    if (!session || providerOrderId !== orderId || (providerUserId && providerUserId !== userId)) {
      return current;
    }

    if (session.status === "complete") {
      await reconcileCompletedAuthorization(session, orderId);
      current = await loadOwnedPostCheckoutApplication(orderId, userId);
    }
  } catch (reconciliationError) {
    console.error("Post-checkout return reconciliation failed.", {
      code: safeDiagnosticCode(reconciliationError),
    });
  }

  return current;
}
