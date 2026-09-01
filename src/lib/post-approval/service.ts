import "server-only";

import type Stripe from "stripe";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "@/lib/config";
import { readSiteData } from "@/lib/data/documents";
import { hasEventPasswordAccess } from "@/lib/event-access";
import { isSalesWindowOpen } from "@/lib/event-state";
import { sendTemplateEmail } from "@/lib/email";
import {
  retrieveStripePaymentIntent,
  stripeCaptureBefore,
} from "@/lib/payments";
import {
  failNormalizedCheckoutCreation,
  fulfilNormalizedPayment,
  reserveNormalizedCheckout,
} from "@/lib/payments/transaction-store";
import { normalizePromoCode } from "@/lib/promos/policy";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { orderPayloadSchema } from "@/lib/validate";
import type {
  ApplicationForm,
  EventItem,
  Order,
  ReservationProductLine,
  ReservationTicketLine,
  SessionUser,
} from "@/types/site";
import {
  addPostCheckoutAudit,
  extendPostCheckoutDeadline,
  getOwnedPostCheckoutApplication,
  getPostCheckoutApplicationByOrder,
  getPostCheckoutApplicationByPaymentIntent,
  listAdminPostCheckoutApplications,
  markPostCheckoutCancelled,
  markPostCheckoutCaptureConfirmed,
  preparePostCheckoutApplication,
  recordPostCheckoutAuthorization,
  requestPostCheckoutDecision,
  savePostCheckoutDraft,
  submitPostCheckoutApplication,
} from "@/lib/post-approval/store";
import {
  POST_CHECKOUT_MODE,
  type PostCheckoutApplication,
  type PostCheckoutDecision,
  type PostCheckoutFormSnapshot,
} from "@/lib/post-approval/types";

const postCheckoutOrderSchema = orderPayloadSchema.extend({
  authorizationAccepted: z.literal(true),
  termsAccepted: z.literal(true),
  privacyAccepted: z.literal(true),
  entryAccepted: z.literal(true),
  ageAccepted: z.literal(true),
}).strict();

export function isPostCheckoutApprovalEvent(event: Pick<EventItem, "ticketMode">) {
  return String(event.ticketMode) === POST_CHECKOUT_MODE;
}

function assertDurableStore() {
  if (config.dataProvider !== "supabase") {
    throw new Error("Post-checkout approval requires durable Supabase storage.");
  }
}

function assertNewPostCheckoutAvailable() {
  assertDurableStore();
  if (!config.postCheckoutApprovalEnabled) {
    throw new Error("Post-checkout approval is not currently enabled.");
  }
}

function formVersion(form: ApplicationForm) {
  const digest = createHash("sha256").update(JSON.stringify(form)).digest("hex").slice(0, 8);
  return Math.max(1, Number.parseInt(digest, 16) % 2_000_000_000);
}

export function snapshotApplicationForm(form: ApplicationForm): PostCheckoutFormSnapshot {
  return {
    id: form.id,
    name: form.name,
    intro: form.intro,
    version: formVersion(form),
    fields: form.fields.map((field) => ({
      id: field.id,
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      placeholder: field.placeholder,
      options: [...field.options],
      maxLength: field.maxLength,
    })),
  };
}

function answerPresent(value: string | boolean | number | undefined) {
  return value === true
    || typeof value === "number"
    || (typeof value === "string" && value.trim().length > 0);
}

export function validatePostCheckoutAnswers(
  form: PostCheckoutFormSnapshot,
  answers: Record<string, string | boolean | number>,
  requireComplete: boolean,
) {
  const allowed = new Set(form.fields.map((field) => field.key));
  if (Object.keys(answers).some((key) => !allowed.has(key))) {
    throw new Error("Application answers contain unknown fields.");
  }
  const requiredFields = form.fields.filter((field) => field.required);
  let requiredAnswered = 0;
  for (const field of form.fields) {
    const value = answers[field.key];
    if (field.required && answerPresent(value)) requiredAnswered += 1;
    if (requireComplete && field.required && !answerPresent(value)) {
      throw new Error(`${field.label} is required.`);
    }
    if (value === undefined) continue;
    if (field.type === "checkbox" && typeof value !== "boolean") {
      throw new Error(`${field.label} must be true or false.`);
    }
    if (field.type !== "checkbox" && typeof value !== "string") {
      throw new Error(`${field.label} must be text.`);
    }
    if (typeof value === "string" && value.length > (field.maxLength || 2000)) {
      throw new Error(`${field.label} is too long.`);
    }
    if (["select", "radio"].includes(field.type)
      && (typeof value !== "string" || !field.options.includes(value))) {
      throw new Error(`${field.label} has an invalid selection.`);
    }
    if (field.type === "email"
      && typeof value === "string"
      && value
      && !/^\S+@\S+\.\S+$/.test(value)) {
      throw new Error(`${field.label} must be a valid email address.`);
    }
  }
  return requiredFields.length
    ? Math.round((requiredAnswered / requiredFields.length) * 100)
    : 100;
}

async function assertNoActivePostCheckoutApplication(customerId: string, eventId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select("id,order_id,status")
    .eq("customer_id", customerId)
    .eq("event_id", eventId)
    .in("status", [
      "awaiting_authorization", "awaiting_form", "draft", "submitted", "under_review",
      "capture_pending", "approved", "approved_override", "rejection_pending", "manual_review",
    ])
    .limit(1);
  if (error) throw new Error("Post-checkout application availability could not be checked.");
  if (data?.length) {
    throw new Error("You already have an active application for this event. Open your account to continue it.");
  }
}

async function releaseUnstartedPostCheckout(order: Order, failureCode: string) {
  const client = createSupabaseAdminClient();
  try {
    await client.rpc("skie_fail_post_checkout_initialization", {
      p_order_id: order.id,
      p_failure_code: failureCode.slice(0, 120),
    });
  } catch {
    // The generic checkout cleanup below remains authoritative before Stripe exists.
  }

  if (!order.checkoutAttemptId) {
    throw new Error("POST_APPROVAL_PREPARATION_RELEASE_FAILED");
  }
  try {
    await failNormalizedCheckoutCreation(order.checkoutAttemptId);
  } catch {
    throw new Error("POST_APPROVAL_PREPARATION_RELEASE_FAILED");
  }
}

export async function createPostCheckoutOrder(user: SessionUser, raw: unknown) {
  assertNewPostCheckoutAvailable();
  const payload = postCheckoutOrderSchema.parse(raw);
  const site = await readSiteData();
  const event = site.events.find((item) => item.id === payload.eventId);
  if (!event || !isPostCheckoutApprovalEvent(event) || event.lifecycle !== "published") {
    throw new Error("This post-checkout application is not available.");
  }
  if (!["public", "private_link", "password"].includes(event.visibility)) {
    throw new Error("This event is not available for checkout.");
  }
  if (!(await hasEventPasswordAccess(event))) {
    throw new Error("Enter the event password before checkout.");
  }
  if (!event.formId) throw new Error("This event does not have an application form configured.");
  const form = site.forms.find((item) => item.id === event.formId && item.active);
  if (!form) throw new Error("This event application form is not available.");
  await assertNoActivePostCheckoutApplication(user.id, event.id);

  const ticketType = event.ticketTypes.find(
    (item) => item.id === payload.ticketTypeId && isSalesWindowOpen(item),
  );
  if (!ticketType) throw new Error("Ticket type is unavailable.");
  if (ticketType.priceCents <= 0) {
    throw new Error("Post-checkout approval requires a paid ticket type.");
  }

  const productLines: ReservationProductLine[] = payload.products.map((requested) => {
    const product = site.products.find((item) => item.id === requested.productId
      && item.eventId === event.id
      && event.productIds.includes(item.id)
      && isSalesWindowOpen(item));
    if (!product) throw new Error("An event extra is no longer available.");
    if (requested.quantity > product.maxPerOrder) {
      throw new Error(`${product.name} exceeds its per-order limit.`);
    }
    return {
      kind: "product",
      referenceId: product.id,
      name: product.name,
      quantity: requested.quantity,
      unitPriceCents: product.priceCents,
      stockQuantity: product.stockQuantity,
      maxPerCustomer: product.maxPerCustomer,
      unitsPerPurchase: Math.max(1, product.unitsPerPurchase || 1),
      redeemable: product.isRedeemable,
    };
  });

  const ticketLine: ReservationTicketLine = {
    kind: "ticket",
    referenceId: ticketType.id,
    name: ticketType.name,
    quantity: payload.ticketQuantity,
    unitPriceCents: ticketType.priceCents,
    ticketTypeCapacity: ticketType.capacity,
    eventPublicCapacity: event.publicCapacity,
    customerLimit: Math.min(event.defaultTicketLimit, ticketType.defaultMaxPerCustomer),
  };
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const order = await reserveNormalizedCheckout({
    customer: user,
    customerEmail: user.email,
    event,
    ticketLine,
    productLines,
    expiresAt,
    promoCode: payload.promoCode ? normalizePromoCode(payload.promoCode) : undefined,
  });

  if (order.totalCents <= 0) {
    await releaseUnstartedPostCheckout(order, "POST_APPROVAL_ZERO_VALUE_ORDER");
    throw new Error("Post-checkout approval cannot be used for a zero-value order.");
  }

  const formDueAt = new Date(
    Date.now() + config.postCheckoutFormMinutes * 60_000,
  ).toISOString();
  const consentSnapshot = {
    authorization: {
      accepted: true,
      text: "My card will be authorised now and charged only if SKIE approves my application.",
      acceptedAt: new Date().toISOString(),
    },
    terms: { accepted: true },
    privacy: { accepted: true },
    entry: { accepted: true },
    age: { accepted: true },
  };

  let prepared: Awaited<ReturnType<typeof preparePostCheckoutApplication>>;
  try {
    prepared = await preparePostCheckoutApplication({
      orderId: order.id,
      form: snapshotApplicationForm(form),
      consentSnapshot,
      formDueAt,
    });
  } catch (error) {
    await releaseUnstartedPostCheckout(
      order,
      error instanceof Error ? error.message : "POST_APPROVAL_PREPARATION_FAILED",
    );
    throw error;
  }

  await addPostCheckoutAudit({
    applicationId: prepared.applicationId,
    orderId: order.id,
    actorId: user.id,
    action: "post_checkout.created",
    safeMetadata: { eventId: event.id, totalCents: order.totalCents, formDueAt },
  }).catch(() => undefined);

  return { order, applicationId: prepared.applicationId, event, formDueAt };
}

export async function loadOwnedPostCheckoutApplication(orderId: string, userId: string) {
  assertDurableStore();
  const application = await getOwnedPostCheckoutApplication(orderId, userId);
  if (!application) return null;
  const site = await readSiteData();
  const event = site.events.find((item) => item.id === application.eventId);
  return { application, event };
}

export async function saveOwnedPostCheckoutDraft(input: {
  orderId: string;
  userId: string;
  answers: Record<string, string | boolean | number>;
  expectedStateVersion: number;
}) {
  const current = await getOwnedPostCheckoutApplication(input.orderId, input.userId);
  if (!current) throw new Error("Application not found.");
  const completionPercentage = validatePostCheckoutAnswers(current.formSnapshot, input.answers, false);
  return savePostCheckoutDraft({ ...input, completionPercentage, customerId: input.userId });
}

export async function submitOwnedPostCheckoutApplication(input: {
  orderId: string;
  user: SessionUser;
  answers: Record<string, string | boolean | number>;
  expectedStateVersion: number;
}) {
  const current = await getOwnedPostCheckoutApplication(input.orderId, input.user.id);
  if (!current) throw new Error("Application not found.");
  const completionPercentage = validatePostCheckoutAnswers(current.formSnapshot, input.answers, true);
  const requestedReviewDueAt = Date.now() + config.postCheckoutReviewHours * 60 * 60 * 1000;
  const captureLimit = current.captureBefore
    ? new Date(current.captureBefore).getTime() - config.postCheckoutCaptureSafetyMinutes * 60_000
    : requestedReviewDueAt;
  const reviewDueAt = Math.min(requestedReviewDueAt, captureLimit);
  if (!Number.isFinite(reviewDueAt) || reviewDueAt <= Date.now()) {
    throw new Error("This payment authorisation is too close to expiry. Restart checkout before submitting.");
  }
  const result = await submitPostCheckoutApplication({
    orderId: input.orderId,
    customerId: input.user.id,
    answers: input.answers,
    completionPercentage,
    expectedStateVersion: input.expectedStateVersion,
    reviewDueAt: new Date(reviewDueAt).toISOString(),
  });
  const site = await readSiteData();
  const event = site.events.find((item) => item.id === current.eventId);
  await sendTemplateEmail({
    templateKey: "post_checkout_form_submitted",
    to: input.user.email,
    recipientUserId: input.user.id,
    eventId: current.eventId,
    orderId: current.orderId,
    variables: {
      first_name: input.user.firstName,
      event_title: event?.title || "your SKIE event",
      account_url: `${config.siteUrl}/account`,
    },
    idempotencyKey: `post_checkout_form_submitted:${current.id}`,
  }).catch(() => undefined);
  await addPostCheckoutAudit({
    applicationId: current.id,
    orderId: current.orderId,
    actorId: input.user.id,
    action: "post_checkout.form_submitted",
    safeMetadata: { completionPercentage },
  }).catch(() => undefined);
  return result;
}

async function customerForApplication(application: PostCheckoutApplication) {
  const { data, error } = await createSupabaseAdminClient()
    .from("profiles")
    .select("first_name,last_name,email,phone")
    .eq("id", application.customerId)
    .single();
  if (error || !data) throw new Error("Customer profile was not found.");
  return {
    firstName: String(data.first_name || "there"),
    lastName: String(data.last_name || ""),
    email: String(data.email),
    phone: String(data.phone || ""),
  };
}

async function sessionIdForApplication(application: PostCheckoutApplication) {
  if (application.stripeCheckoutSessionId) return application.stripeCheckoutSessionId;
  const { data, error } = await createSupabaseAdminClient()
    .from("checkout_attempts")
    .select("stripe_checkout_session_id")
    .eq("id", application.checkoutAttemptId)
    .single();
  if (error || !data?.stripe_checkout_session_id) {
    throw new Error("POST_APPROVAL_CHECKOUT_SESSION_MISSING");
  }
  return String(data.stripe_checkout_session_id);
}

export async function recordPostCheckoutAuthorizationFromSession(session: Stripe.Checkout.Session) {
  if (session.metadata?.workflow_mode !== POST_CHECKOUT_MODE) return null;
  const orderId = session.metadata.order_id || session.client_reference_id;
  if (!orderId) throw new Error("POST_APPROVAL_ORDER_REFERENCE_MISSING");
  const paymentIntent = typeof session.payment_intent === "string"
    ? await retrieveStripePaymentIntent(session.payment_intent)
    : session.payment_intent as Stripe.PaymentIntent | null;
  if (!paymentIntent) throw new Error("POST_APPROVAL_PAYMENT_INTENT_MISSING");
  if (paymentIntent.status !== "requires_capture") {
    throw new Error("POST_APPROVAL_PAYMENT_NOT_AUTHORIZED");
  }
  const result = await recordPostCheckoutAuthorization({
    orderId,
    checkoutSessionId: session.id,
    paymentIntentId: paymentIntent.id,
    amountCents: paymentIntent.amount,
    capturableCents: paymentIntent.amount_capturable,
    currency: paymentIntent.currency,
    captureBefore: stripeCaptureBefore(paymentIntent),
  });
  await queueMandatoryFormNotification(orderId);
  return result;
}

export async function recordPostCheckoutAuthorizationFromPaymentIntent(
  paymentIntent: Stripe.PaymentIntent,
) {
  if (paymentIntent.metadata?.workflow_mode !== POST_CHECKOUT_MODE) return null;
  const expanded = await retrieveStripePaymentIntent(paymentIntent.id) || paymentIntent;
  const orderId = expanded.metadata?.order_id;
  if (!orderId) throw new Error("POST_APPROVAL_ORDER_REFERENCE_MISSING");
  if (expanded.status !== "requires_capture") {
    throw new Error("POST_APPROVAL_PAYMENT_NOT_AUTHORIZED");
  }
  const application = await getPostCheckoutApplicationByOrder(orderId);
  if (!application) throw new Error("POST_APPROVAL_APPLICATION_NOT_FOUND");
  const result = await recordPostCheckoutAuthorization({
    orderId,
    checkoutSessionId: await sessionIdForApplication(application),
    paymentIntentId: expanded.id,
    amountCents: expanded.amount,
    capturableCents: expanded.amount_capturable,
    currency: expanded.currency,
    captureBefore: stripeCaptureBefore(expanded),
  });
  await queueMandatoryFormNotification(orderId);
  return result;
}

async function queueMandatoryFormNotification(orderId: string) {
  const application = await getPostCheckoutApplicationByOrder(orderId);
  if (!application) throw new Error("POST_APPROVAL_APPLICATION_NOT_FOUND");
  const [customer, site] = await Promise.all([
    customerForApplication(application),
    readSiteData(),
  ]);
  const event = site.events.find((item) => item.id === application.eventId);
  await sendTemplateEmail({
    templateKey: "post_checkout_form_required",
    to: customer.email,
    recipientUserId: application.customerId,
    eventId: application.eventId,
    orderId: application.orderId,
    variables: {
      first_name: customer.firstName,
      event_title: event?.title || "your SKIE event",
      expires_at: new Date(application.formDueAt).toLocaleString("en-AU", {
        timeZone: config.timezone,
      }),
      account_url: `${config.siteUrl}/account/applications/${encodeURIComponent(application.orderId)}`,
    },
    idempotencyKey: `post_checkout_form_required:${application.id}`,
  });
}

export async function listPostCheckoutApplicationsForAdmin() {
  assertDurableStore();
  const [items, site] = await Promise.all([
    listAdminPostCheckoutApplications(),
    readSiteData(),
  ]);
  return items.map((item) => {
    const event = site.events.find((candidate) => candidate.id === item.eventId);
    return {
      ...item,
      event: {
        title: event?.title || item.eventId,
        slug: event?.slug || item.eventId,
      },
    };
  });
}

export async function sendPostCheckoutFormReminder(
  applicationId: string,
  requestedBy: string,
  final = false,
) {
  const items = await listAdminPostCheckoutApplications();
  const item = items.find((candidate) => candidate.id === applicationId);
  if (!item) throw new Error("Application not found.");
  if (!["awaiting_form", "draft"].includes(item.status) || item.paymentStatus !== "authorized") {
    throw new Error("This application no longer needs a form reminder.");
  }
  const site = await readSiteData();
  const event = site.events.find((candidate) => candidate.id === item.eventId);
  const templateKey = final
    ? "post_checkout_form_final_reminder"
    : "post_checkout_form_reminder";
  const resendBucket = Math.floor(Date.now() / (5 * 60_000));
  await sendTemplateEmail({
    templateKey,
    to: item.customer.email,
    recipientUserId: item.customerId,
    eventId: item.eventId,
    orderId: item.orderId,
    variables: {
      first_name: item.customer.firstName,
      event_title: event?.title || "your SKIE event",
      completion_percentage: item.completionPercentage,
      expires_at: new Date(item.formDueAt).toLocaleString("en-AU", {
        timeZone: config.timezone,
      }),
      account_url: `${config.siteUrl}/account/applications/${encodeURIComponent(item.orderId)}`,
    },
    idempotencyKey: `${templateKey}:${item.id}:manual:${resendBucket}`,
  });
  await addPostCheckoutAudit({
    applicationId: item.id,
    orderId: item.orderId,
    actorId: requestedBy,
    action: final
      ? "post_checkout.final_reminder_sent"
      : "post_checkout.form_reminder_sent",
    safeMetadata: { manual: true },
  });
  return { queued: true };
}

export async function decidePostCheckoutApplication(input: {
  applicationId: string;
  actor: SessionUser;
  decision: PostCheckoutDecision;
  internalReason: string;
  customerMessage?: string;
}) {
  const idempotencyKey = `post-approval-${input.decision}:${input.applicationId}:${randomUUID()}`;
  const requested = await requestPostCheckoutDecision({
    applicationId: input.applicationId,
    actorId: input.actor.id,
    decision: input.decision,
    internalReason: input.internalReason,
    customerMessage: input.customerMessage,
    idempotencyKey,
  });
  await addPostCheckoutAudit({
    applicationId: input.applicationId,
    actorId: input.actor.id,
    action: `post_checkout.${input.decision}`,
    safeMetadata: { actionId: requested.actionId },
  }).catch(() => undefined);
  return requested;
}

export async function extendPostCheckoutApplicationDeadline(
  applicationId: string,
  actorId: string,
  formDueAt: string,
) {
  return extendPostCheckoutDeadline(applicationId, actorId, formDueAt);
}

async function finaliseCapturedPayment(paymentIntent: Stripe.PaymentIntent, eventId: string) {
  const application = await getPostCheckoutApplicationByPaymentIntent(paymentIntent.id);
  if (!application) throw new Error("POST_APPROVAL_APPLICATION_NOT_FOUND");
  const sessionId = await sessionIdForApplication(application);
  await markPostCheckoutCaptureConfirmed(
    paymentIntent.id,
    paymentIntent.amount_received || paymentIntent.amount,
  );
  const fulfilled = await fulfilNormalizedPayment({
    eventId,
    eventType: "checkout.session.async_payment_succeeded",
    eventCreatedAtMs: Date.now(),
    sessionId,
    metadataOrderId: application.orderId,
    clientReferenceOrderId: application.orderId,
    paymentStatus: "paid",
    amountTotal: paymentIntent.amount_received || paymentIntent.amount,
    currency: paymentIntent.currency,
    paymentIntentId: paymentIntent.id,
  });
  const { error } = await createSupabaseAdminClient().rpc("skie_mark_post_checkout_fulfilled", {
    p_order_id: application.orderId,
  });
  if (error) throw new Error("POST_APPROVAL_FULFILMENT_STATUS_FAILED");
  return fulfilled;
}

export async function handlePostCheckoutPaymentSucceeded(
  paymentIntent: Stripe.PaymentIntent,
  stripeEventId: string,
) {
  if (paymentIntent.metadata?.workflow_mode !== POST_CHECKOUT_MODE) return null;
  return finaliseCapturedPayment(paymentIntent, stripeEventId);
}

export async function retryPostCheckoutPaymentAction(applicationId: string, actorId: string) {
  const { data, error } = await createSupabaseAdminClient().rpc(
    "skie_retry_post_checkout_payment_action",
    {
      p_application_id: applicationId,
      p_actor_id: actorId,
    },
  );
  if (error) {
    throw new Error(String(error.message || "POST_APPROVAL_PAYMENT_ACTION_RETRY_FAILED"));
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("POST_APPROVAL_PAYMENT_ACTION_RETRY_FAILED");
  return {
    actionId: String(row.action_id),
    actionType: String(row.action_type),
    status: String(row.status),
    attemptCount: Number(row.attempt_count || 0),
  };
}

export async function handlePostCheckoutPaymentCancelled(
  paymentIntent: Stripe.PaymentIntent,
  reason = "rejected",
) {
  if (paymentIntent.metadata?.workflow_mode !== POST_CHECKOUT_MODE) return null;
  const current = await getPostCheckoutApplicationByPaymentIntent(paymentIntent.id);
  const effectiveReason = current?.status === "form_expired"
    ? "form_expired"
    : current?.status === "authorization_expired"
      ? "authorization_expired"
      : reason;
  const result = await markPostCheckoutCancelled(paymentIntent.id, effectiveReason);
  const application = await getPostCheckoutApplicationByPaymentIntent(paymentIntent.id);
  if (application) {
    const [customer, site] = await Promise.all([
      customerForApplication(application),
      readSiteData(),
    ]);
    const event = site.events.find((item) => item.id === application.eventId);
    const templateKey = effectiveReason === "form_expired"
      ? "post_checkout_form_expired"
      : effectiveReason === "authorization_expired"
        ? "post_checkout_authorisation_expired"
        : "post_checkout_rejected";
    await sendTemplateEmail({
      templateKey,
      to: customer.email,
      recipientUserId: application.customerId,
      eventId: application.eventId,
      orderId: application.orderId,
      variables: {
        first_name: customer.firstName,
        event_title: event?.title || "your SKIE event",
        expires_at: new Date(application.formDueAt).toLocaleString("en-AU", {
          timeZone: config.timezone,
        }),
      },
      idempotencyKey: `${templateKey}:${application.id}`,
    }).catch(() => undefined);
  }
  return result;
}
