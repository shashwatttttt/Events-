import "server-only";

import { config } from "@/lib/config";
import { expireStripeCheckoutSession, retrieveStripeCheckoutSession } from "@/lib/payments";
import { restartUnpaidPostCheckout } from "@/lib/post-approval/cleanup";
import { normalizePromoCode } from "@/lib/promos/policy";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { PromoExpectation } from "@/lib/validate";

const ACTIVE_STATUSES = [
  "awaiting_authorization",
  "awaiting_form",
  "draft",
  "submitted",
  "under_review",
  "capture_pending",
  "approved",
  "approved_override",
  "rejection_pending",
  "manual_review",
] as const;

type ActivePostCheckoutRow = {
  id: string;
  order_id: string;
  reservation_id: string;
  checkout_attempt_id: string;
  status: string;
  payment_status: string;
  form_due_at: string;
};

export type RequestedPostCheckoutSelection = {
  ticketTypeId: string;
  ticketQuantity: number;
  products: Array<{ productId: string; quantity: number }>;
  expectedSubtotalCents: number;
  promoCode?: string;
  promoExpectation?: PromoExpectation;
};

export type ResumablePostCheckout = {
  applicationId: string;
  orderId: string;
  formDueAt: string;
  checkout: {
    provider: "stripe" | "resume" | "guestlist";
    url: string;
    sessionId?: string;
  };
};

type ExistingSelection = {
  ticketTypeId: string;
  ticketQuantity: number;
  products: Array<{ productId: string; quantity: number }>;
  promoCode?: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  guestlistApplication: boolean;
};

export function postCheckoutContinuationPath(row: Pick<ActivePostCheckoutRow, "order_id" | "status" | "payment_status">) {
  if (["awaiting_form", "draft"].includes(row.status)
    && ["authorized", "not_required"].includes(row.payment_status)) {
    return `/account/applications/${encodeURIComponent(row.order_id)}`;
  }
  return "/account";
}

function sortedProducts(products: Array<{ productId: string; quantity: number }>) {
  return [...products].sort((left, right) => left.productId.localeCompare(right.productId));
}

function selectionsMatch(requested: RequestedPostCheckoutSelection, existing: ExistingSelection) {
  const requestedProducts = sortedProducts(requested.products);
  const existingProducts = sortedProducts(existing.products);
  const requestedPromo = requested.promoCode ? normalizePromoCode(requested.promoCode) : "";
  const existingPromo = existing.promoCode ? normalizePromoCode(existing.promoCode) : "";
  const expectationMatches = requested.promoExpectation
    ? requested.promoExpectation.code === existingPromo
      && requested.promoExpectation.subtotalCents === existing.subtotalCents
      && requested.promoExpectation.discountCents === existing.discountCents
      && requested.promoExpectation.totalCents === existing.totalCents
      && requested.promoExpectation.trackingOnly === (existing.discountCents === 0 && !existing.guestlistApplication)
      && requested.promoExpectation.guestlistApplication === existing.guestlistApplication
    : !existingPromo && existing.discountCents === 0 && !existing.guestlistApplication;

  return requested.ticketTypeId === existing.ticketTypeId
    && requested.ticketQuantity === existing.ticketQuantity
    && requested.expectedSubtotalCents === existing.subtotalCents
    && requestedPromo === existingPromo
    && expectationMatches
    && requestedProducts.length === existingProducts.length
    && requestedProducts.every((product, index) => product.productId === existingProducts[index]?.productId
      && product.quantity === existingProducts[index]?.quantity);
}

async function loadExistingSelection(row: ActivePostCheckoutRow): Promise<ExistingSelection> {
  const client = createSupabaseAdminClient();
  const [reservationResult, ticketResult, productResult] = await Promise.all([
    client.from("reservations")
      .select("promo_code_id,expected_subtotal_cents,expected_discount_cents,expected_total_cents")
      .eq("id", row.reservation_id)
      .maybeSingle(),
    client.from("reservation_ticket_lines")
      .select("ticket_type_id,quantity")
      .eq("reservation_id", row.reservation_id),
    client.from("reservation_product_lines")
      .select("product_id,quantity")
      .eq("reservation_id", row.reservation_id),
  ]);

  if (reservationResult.error || ticketResult.error || productResult.error
    || !reservationResult.data || ticketResult.data?.length !== 1) {
    throw new Error("Post-checkout application availability could not be checked.");
  }

  const promoCodeId = reservationResult.data.promo_code_id
    ? String(reservationResult.data.promo_code_id)
    : "";
  let promoCode: string | undefined;
  let guestlistApplication = false;
  if (promoCodeId) {
    const promoResult = await client.from("promo_codes")
      .select("code,discount_type")
      .eq("id", promoCodeId)
      .maybeSingle();
    if (promoResult.error || !promoResult.data?.code) {
      throw new Error("Post-checkout application availability could not be checked.");
    }
    promoCode = normalizePromoCode(String(promoResult.data.code));
    guestlistApplication = String(promoResult.data.discount_type) === "guestlist";
  }

  const ticket = ticketResult.data[0];
  return {
    ticketTypeId: String(ticket.ticket_type_id),
    ticketQuantity: Number(ticket.quantity),
    products: (productResult.data || []).map((product) => ({
      productId: String(product.product_id),
      quantity: Number(product.quantity),
    })),
    promoCode,
    subtotalCents: Number(reservationResult.data.expected_subtotal_cents),
    discountCents: Number(reservationResult.data.expected_discount_cents),
    totalCents: Number(reservationResult.data.expected_total_cents),
    guestlistApplication,
  };
}

async function releaseUnpaidSession(orderId: string, sessionId: string | undefined, reason: string) {
  if (sessionId) {
    try {
      await expireStripeCheckoutSession(sessionId);
    } catch {
      throw new Error("POST_APPROVAL_SESSION_RESTART_FAILED");
    }
  }
  await restartUnpaidPostCheckout(orderId, reason);
}

export async function resumeExistingPostCheckout(
  customerId: string,
  eventId: string,
  requested: RequestedPostCheckoutSelection,
): Promise<ResumablePostCheckout | null> {
  if (config.dataProvider !== "supabase" || !config.postCheckoutApprovalEnabled) return null;

  const client = createSupabaseAdminClient();
  const { data, error } = await client
    .from("post_checkout_applications")
    .select("id,order_id,reservation_id,checkout_attempt_id,status,payment_status,form_due_at")
    .eq("customer_id", customerId)
    .eq("event_id", eventId)
    .in("status", [...ACTIVE_STATUSES])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error("Post-checkout application availability could not be checked.");
  if (!data) return null;

  const row = data as ActivePostCheckoutRow;
  if (row.payment_status === "not_required") {
    if (["awaiting_form", "draft"].includes(row.status)) {
      const existingSelection = await loadExistingSelection(row);
      if (!selectionsMatch(requested, existingSelection)) {
        return {
          applicationId: row.id,
          orderId: row.order_id,
          formDueAt: row.form_due_at,
          checkout: {
            provider: "resume",
            url: "/account?checkout=application-active",
          },
        };
      }
    }
    return {
      applicationId: row.id,
      orderId: row.order_id,
      formDueAt: row.form_due_at,
      checkout: {
        provider: "guestlist",
        url: postCheckoutContinuationPath(row),
      },
    };
  }

  if (row.status === "awaiting_authorization" && row.payment_status === "authorization_pending") {
    const [{ data: attempt, error: attemptError }, existingSelection] = await Promise.all([
      client.from("checkout_attempts")
        .select("stripe_checkout_session_id")
        .eq("id", row.checkout_attempt_id)
        .maybeSingle(),
      loadExistingSelection(row),
    ]);

    if (attemptError) throw new Error("Post-checkout application availability could not be checked.");
    const sessionId = attempt?.stripe_checkout_session_id
      ? String(attempt.stripe_checkout_session_id)
      : "";
    const compatible = selectionsMatch(requested, existingSelection);

    if (!sessionId) {
      if (!compatible) {
        await releaseUnpaidSession(row.order_id, undefined, "POST_APPROVAL_CART_CHANGED");
        return null;
      }
      return {
        applicationId: row.id,
        orderId: row.order_id,
        formDueAt: row.form_due_at,
        checkout: { provider: "resume", url: "/account" },
      };
    }

    let session;
    try {
      session = await retrieveStripeCheckoutSession(sessionId);
    } catch {
      throw new Error("CHECKOUT_SESSION_RETRIEVAL_FAILED");
    }

    if (session?.status === "complete") {
      return {
        applicationId: row.id,
        orderId: row.order_id,
        formDueAt: row.form_due_at,
        checkout: {
          provider: "resume",
          url: `/payment/application?session_id=${encodeURIComponent(sessionId)}`,
          sessionId,
        },
      };
    }

    if (session?.status === "expired") {
      await releaseUnpaidSession(row.order_id, undefined, "CHECKOUT_SESSION_EXPIRED_BEFORE_AUTHORIZATION");
      return null;
    }

    if (session?.status === "open" && session.url) {
      if (!compatible) {
        await releaseUnpaidSession(row.order_id, sessionId, "POST_APPROVAL_CART_CHANGED");
        return null;
      }
      return {
        applicationId: row.id,
        orderId: row.order_id,
        formDueAt: row.form_due_at,
        checkout: { provider: "stripe", url: session.url, sessionId },
      };
    }

    throw new Error("POST_APPROVAL_SESSION_STATE_UNAVAILABLE");
  }

  return {
    applicationId: row.id,
    orderId: row.order_id,
    formDueAt: row.form_due_at,
    checkout: {
      provider: "resume",
      url: postCheckoutContinuationPath(row),
    },
  };
}
