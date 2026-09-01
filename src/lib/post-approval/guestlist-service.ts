import "server-only";

import { z } from "zod";
import { config } from "@/lib/config";
import { readSiteData } from "@/lib/data/documents";
import { hasEventPasswordAccess } from "@/lib/event-access";
import { isSalesWindowOpen } from "@/lib/event-state";
import { sendTemplateEmail } from "@/lib/email";
import { PublicApiError } from "@/lib/http";
import { failNormalizedCheckoutCreation, fulfilNormalizedOrder, reserveNormalizedCheckout } from "@/lib/payments/transaction-store";
import {
  activateGuestlistApplication,
  guestlistApplicationContext,
  guestlistOrderContext,
  markGuestlistFulfilled,
  markGuestlistManualReview,
  requestGuestlistDecision,
} from "@/lib/post-approval/guestlist-store";
import { addPostCheckoutAudit, preparePostCheckoutApplication } from "@/lib/post-approval/store";
import { isPostCheckoutApprovalEvent, snapshotApplicationForm } from "@/lib/post-approval/service";
import type { PostCheckoutDecision, PostCheckoutDecisionResult } from "@/lib/post-approval/types";
import { getPromoDiscountTypeById } from "@/lib/promos/service";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { orderPayloadSchema } from "@/lib/validate";
import type { ReservationProductLine, ReservationTicketLine, SessionUser } from "@/types/site";

const guestlistOrderSchema = orderPayloadSchema.extend({
  authorizationAccepted: z.literal(true),
  termsAccepted: z.literal(true),
  privacyAccepted: z.literal(true),
  entryAccepted: z.literal(true),
  ageAccepted: z.literal(true),
}).strict();

async function assertNoActiveApplication(customerId: string, eventId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select("id")
    .eq("customer_id", customerId)
    .eq("event_id", eventId)
    .in("status", ["awaiting_authorization", "awaiting_form", "draft", "submitted", "under_review", "capture_pending", "approved", "approved_override", "rejection_pending", "manual_review"])
    .limit(1);
  if (error) throw new Error("POST_APPROVAL_STORE_UNAVAILABLE");
  if (data?.length) throw new Error("POST_APPROVAL_ALREADY_ACTIVE");
}

async function releaseUnstartedOrder(orderId: string, checkoutAttemptId: string | undefined, failureCode: string) {
  try {
    await createSupabaseAdminClient().rpc("skie_fail_post_checkout_initialization", {
      p_order_id: orderId,
      p_failure_code: failureCode.slice(0, 120),
    });
  } catch {
    // Generic normalized cleanup below remains authoritative.
  }
  if (!checkoutAttemptId) throw new Error("POST_APPROVAL_PREPARATION_RELEASE_FAILED");
  try {
    await failNormalizedCheckoutCreation(checkoutAttemptId);
  } catch {
    throw new Error("POST_APPROVAL_PREPARATION_RELEASE_FAILED");
  }
}

async function customerForOrder(orderId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select("customer_id,event_id,customer:profiles!post_checkout_applications_customer_id_fkey(first_name,email)")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error || !data) throw new Error("POST_APPROVAL_APPLICATION_NOT_FOUND");
  const value = Array.isArray(data.customer) ? data.customer[0] : data.customer;
  const customer = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    customerId: String(data.customer_id),
    eventId: String(data.event_id),
    firstName: String(customer.first_name || "there"),
    email: String(customer.email || ""),
  };
}

async function queueFormEmail(input: {
  orderId: string;
  applicationId: string;
  eventId: string;
  user: SessionUser;
  eventTitle: string;
  formDueAt: string;
}) {
  const deadline = new Date(input.formDueAt).toLocaleString("en-AU", { timeZone: config.timezone });
  await sendTemplateEmail({
    templateKey: "admin_manual_message",
    to: input.user.email,
    recipientUserId: input.user.id,
    eventId: input.eventId,
    orderId: input.orderId,
    variables: {
      subject: `Complete your mandatory ${input.eventTitle} application`,
      event_title: input.eventTitle,
      message: `Hi ${input.user.firstName || "there"}, no payment is required for this ticket-only guest-list request. Complete the mandatory application before ${deadline}. No ticket or QR code will be issued unless SKIE approves the application.`,
      account_url: `${config.siteUrl}/account/applications/${encodeURIComponent(input.orderId)}`,
    },
    idempotencyKey: `guestlist_form_required:${input.applicationId}`,
  });
}

export async function createZeroPaymentGuestlistOrder(user: SessionUser, raw: unknown) {
  if (config.dataProvider !== "supabase" || !config.postCheckoutApprovalEnabled) throw new Error("GUESTLIST_APPLICATION_UNAVAILABLE");
  const payload = guestlistOrderSchema.parse(raw);
  if (!payload.promoCode || !payload.promoExpectation?.guestlistApplication) throw new Error("GUESTLIST_PROMO_REQUIRED");
  if (payload.promoExpectation.totalCents !== 0) throw new Error("GUESTLIST_PAYMENT_STILL_REQUIRED");

  const site = await readSiteData();
  const event = site.events.find((item) => item.id === payload.eventId);
  if (!event || !isPostCheckoutApprovalEvent(event) || event.lifecycle !== "published") throw new Error("GUESTLIST_APPLICATION_UNAVAILABLE");
  if (!["public", "private_link", "password"].includes(event.visibility)) throw new Error("CHECKOUT_NOT_AVAILABLE");
  if (!(await hasEventPasswordAccess(event))) throw new Error("EVENT_PASSWORD_REQUIRED");
  const form = site.forms.find((item) => item.id === event.formId && item.active);
  if (!form) throw new Error("POST_APPROVAL_FORM_REQUIRED");
  await assertNoActiveApplication(user.id, event.id);

  const ticketType = event.ticketTypes.find((item) => item.id === payload.ticketTypeId && isSalesWindowOpen(item));
  if (!ticketType || ticketType.priceCents <= 0) throw new Error("CHECKOUT_ITEMS_INVALID");
  const productLines: ReservationProductLine[] = payload.products.map((requested) => {
    const product = site.products.find((item) => item.id === requested.productId && item.eventId === event.id && event.productIds.includes(item.id) && isSalesWindowOpen(item));
    if (!product) throw new Error("CHECKOUT_ITEMS_INVALID");
    if (requested.quantity > product.maxPerOrder) throw new Error("CUSTOMER_PRODUCT_LIMIT_EXCEEDED");
    return {
      kind: "product", referenceId: product.id, name: product.name, quantity: requested.quantity,
      unitPriceCents: product.priceCents, stockQuantity: product.stockQuantity,
      maxPerCustomer: product.maxPerCustomer, unitsPerPurchase: Math.max(1, product.unitsPerPurchase || 1),
      redeemable: product.isRedeemable,
    };
  });
  const ticketLine: ReservationTicketLine = {
    kind: "ticket", referenceId: ticketType.id, name: ticketType.name, quantity: payload.ticketQuantity,
    unitPriceCents: ticketType.priceCents, ticketTypeCapacity: ticketType.capacity,
    eventPublicCapacity: event.publicCapacity,
    customerLimit: Math.min(event.defaultTicketLimit, ticketType.defaultMaxPerCustomer),
  };

  const order = await reserveNormalizedCheckout({
    customer: user, customerEmail: user.email, event, ticketLine, productLines,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), promoCode: payload.promoCode,
  });
  if (payload.expectedSubtotalCents === undefined
    || order.subtotalCents !== payload.expectedSubtotalCents) {
    await releaseUnstartedOrder(order.id, order.checkoutAttemptId, "CHECKOUT_PRICE_CHANGED");
    throw new PublicApiError(
      "CHECKOUT_PRICE_CHANGED",
      "Ticket or add-on prices changed before checkout. Refresh the page and review the new total; no payment or ticket was created.",
      409,
    );
  }
  const promoType = await getPromoDiscountTypeById(order.promoCodeId);
  if (promoType !== "guestlist" || order.totalCents !== 0) {
    await releaseUnstartedOrder(order.id, order.checkoutAttemptId, "GUESTLIST_PRICING_INTEGRITY_FAILED");
    throw new Error("PROMO_QUOTE_CHANGED");
  }
  if (productLines.some((line) => line.quantity * line.unitPriceCents > 0)) {
    await releaseUnstartedOrder(order.id, order.checkoutAttemptId, "GUESTLIST_PAID_ADDONS_REQUIRE_STRIPE");
    throw new Error("GUESTLIST_PAYMENT_STILL_REQUIRED");
  }

  const formDueAt = new Date(Date.now() + config.postCheckoutFormMinutes * 60_000).toISOString();
  let prepared: Awaited<ReturnType<typeof preparePostCheckoutApplication>>;
  try {
    prepared = await preparePostCheckoutApplication({
      orderId: order.id,
      form: snapshotApplicationForm(form),
      formDueAt,
      consentSnapshot: {
        authorization: { accepted: true, text: "No payment is required. A ticket is issued only after SKIE approval.", acceptedAt: new Date().toISOString() },
        terms: { accepted: true }, privacy: { accepted: true }, entry: { accepted: true }, age: { accepted: true },
      },
    });
    await activateGuestlistApplication(order.id);
  } catch (error) {
    await releaseUnstartedOrder(order.id, order.checkoutAttemptId, error instanceof Error ? error.message : "GUESTLIST_APPLICATION_PREPARATION_FAILED");
    throw error;
  }

  await addPostCheckoutAudit({ applicationId: prepared.applicationId, orderId: order.id, actorId: user.id, action: "post_checkout.guestlist_created", safeMetadata: { eventId: event.id, totalCents: 0, formDueAt } }).catch(() => undefined);
  await queueFormEmail({ orderId: order.id, applicationId: prepared.applicationId, eventId: event.id, user, eventTitle: event.title, formDueAt }).catch(() => undefined);
  return { order, applicationId: prepared.applicationId, event, formDueAt, guestlistApplication: true };
}

function safeFulfilmentCode(error: unknown) {
  const value = error instanceof Error ? error.message : "";
  return /^[A-Z0-9_]{3,120}$/.test(value) ? value : "GUESTLIST_FULFILMENT_FAILED";
}

export async function decideGuestlistApplication(input: {
  applicationId: string;
  actor: SessionUser;
  decision: PostCheckoutDecision;
  internalReason: string;
  customerMessage?: string;
}): Promise<PostCheckoutDecisionResult | null> {
  const context = await guestlistApplicationContext(input.applicationId);
  if (!context.guestlistApplication) return null;
  const decision = await requestGuestlistDecision({
    applicationId: input.applicationId, actorId: input.actor.id, decision: input.decision,
    internalReason: input.internalReason, customerMessage: input.customerMessage,
  });
  if (decision.actionType === "fulfil") {
    try {
      await fulfilNormalizedOrder(context.orderId, "free", `guestlist_approval_${decision.decisionId}`);
      await markGuestlistFulfilled(context.orderId);
    } catch (error) {
      const code = safeFulfilmentCode(error);
      await markGuestlistManualReview(context.orderId, code).catch(() => undefined);
      throw new Error(code);
    }
  } else {
    const customer = await customerForOrder(context.orderId).catch(() => null);
    const site = customer ? await readSiteData().catch(() => null) : null;
    const event = customer ? site?.events.find((item) => item.id === customer.eventId) : undefined;
    if (customer) await sendTemplateEmail({
      templateKey: "admin_manual_message", to: customer.email,
      recipientUserId: customer.customerId, eventId: customer.eventId, orderId: context.orderId,
      variables: {
        subject: `Update on your ${event?.title || "SKIE event"} application`,
        event_title: event?.title || "your SKIE event",
        message: "Your guest-list application was not approved. The reserved place has been released, no payment was taken, and no ticket or QR code was issued.",
        account_url: `${config.siteUrl}/account`,
      },
      idempotencyKey: `guestlist_rejected:${input.applicationId}`,
    }).catch(() => undefined);
  }
  return decision;
}

export async function retryGuestlistFulfilment(orderId: string) {
  const context = await guestlistOrderContext(orderId);
  if (!context.guestlistApplication || !["approved", "approved_override", "manual_review"].includes(context.status)) throw new Error("GUESTLIST_FULFILMENT_NOT_RETRYABLE");
  try {
    const fulfilled = await fulfilNormalizedOrder(orderId, "free", `guestlist_approval_retry_${context.id}`);
    await markGuestlistFulfilled(orderId);
    return fulfilled;
  } catch (error) {
    const code = safeFulfilmentCode(error);
    await markGuestlistManualReview(orderId, code).catch(() => undefined);
    throw new Error(code);
  }
}
