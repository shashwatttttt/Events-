import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type {
  PostCheckoutAdminItem,
  PostCheckoutApplication,
  PostCheckoutDecision,
  PostCheckoutFormSnapshot,
} from "@/lib/post-approval/types";

const SAFE_CODES = new Set([
  "POST_APPROVAL_APPLICATION_NOT_FOUND",
  "POST_APPROVAL_ALREADY_CAPTURED",
  "POST_APPROVAL_ALREADY_DECIDED",
  "POST_APPROVAL_ANSWERS_INVALID",
  "POST_APPROVAL_AUTHORIZATION_TOO_CLOSE_TO_EXPIRY",
  "POST_APPROVAL_CAPTURE_WITHOUT_APPROVAL",
  "POST_APPROVAL_CAPTURE_DEADLINE_MISSING",
  "POST_APPROVAL_DEADLINE_NOT_EXTENDABLE",
  "POST_APPROVAL_DECISION_INVALID",
  "POST_APPROVAL_FORM_DEADLINE_INVALID",
  "POST_APPROVAL_FORM_DEADLINE_TOO_LATE",
  "POST_APPROVAL_FORM_EXPIRED",
  "POST_APPROVAL_FORM_NOT_EDITABLE",
  "POST_APPROVAL_FORM_NOT_SUBMITTABLE",
  "POST_APPROVAL_FORM_REQUIRED",
  "POST_APPROVAL_MODE_MISMATCH",
  "POST_APPROVAL_ORDER_NOT_FOUND",
  "POST_APPROVAL_ORDER_NOT_PREPARABLE",
  "POST_APPROVAL_OVERRIDE_NOT_ALLOWED",
  "POST_APPROVAL_PAYMENT_NOT_AUTHORIZED",
  "POST_APPROVAL_PAYMENT_ACTION_NOT_FOUND",
  "POST_APPROVAL_PAYMENT_ACTION_NOT_RETRYABLE",
  "POST_APPROVAL_REASON_REQUIRED",
  "POST_APPROVAL_RESERVATION_NOT_ACTIVE",
  "POST_APPROVAL_REJECTION_NOT_ALLOWED",
  "POST_APPROVAL_REVIEW_DEADLINE_INVALID",
  "POST_APPROVAL_REVIEW_DEADLINE_TOO_LATE",
  "POST_APPROVAL_STALE_VERSION",
  "POST_APPROVAL_TRANSACTION_INCOMPLETE",
  "PAYMENT_AMOUNT_MISMATCH",
  "PAYMENT_INTENT_MISMATCH",
]);

export class PostCheckoutStoreError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "PostCheckoutStoreError";
  }
}

function safeCode(error: unknown, fallback = "POST_APPROVAL_STORE_UNAVAILABLE") {
  const message = error && typeof error === "object" && "message" in error
    ? String((error as { message?: unknown }).message || "")
    : "";
  return [...SAFE_CODES].find((code) => message.includes(code)) || fallback;
}

function rowRecord(value: unknown) {
  if (!value || typeof value !== "object") throw new PostCheckoutStoreError("POST_APPROVAL_INVALID_RESPONSE");
  return value as Record<string, unknown>;
}

function firstRow(value: unknown) {
  return rowRecord(Array.isArray(value) ? value[0] : value);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function answerRecord(value: unknown): Record<string, string | boolean | number> {
  const source = objectRecord(value);
  return Object.fromEntries(
    Object.entries(source).filter(([, item]) => ["string", "boolean", "number"].includes(typeof item)),
  ) as Record<string, string | boolean | number>;
}

function optionalText(value: unknown) {
  return value === null || value === undefined || value === "" ? undefined : String(value);
}

function mapApplication(row: Record<string, unknown>): PostCheckoutApplication {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    reservationId: String(row.reservation_id),
    checkoutAttemptId: String(row.checkout_attempt_id),
    customerId: String(row.customer_id),
    eventId: String(row.event_id),
    formId: String(row.form_id),
    formVersion: Number(row.form_version),
    formSnapshot: objectRecord(row.form_snapshot) as PostCheckoutFormSnapshot,
    draftAnswers: answerRecord(row.draft_answers),
    submittedAnswers: row.submitted_answers ? answerRecord(row.submitted_answers) : undefined,
    consentSnapshot: objectRecord(row.consent_snapshot),
    status: String(row.status) as PostCheckoutApplication["status"],
    paymentStatus: String(row.payment_status) as PostCheckoutApplication["paymentStatus"],
    completionPercentage: Number(row.completion_percentage || 0),
    stripeCheckoutSessionId: optionalText(row.stripe_checkout_session_id),
    stripePaymentIntentId: optionalText(row.stripe_payment_intent_id),
    authorizedAmountCents: row.authorized_amount_cents === null ? undefined : Number(row.authorized_amount_cents),
    capturableAmountCents: row.capturable_amount_cents === null ? undefined : Number(row.capturable_amount_cents),
    currency: String(row.currency || "AUD"),
    formDueAt: String(row.form_due_at),
    reviewDueAt: optionalText(row.review_due_at),
    captureBefore: optionalText(row.capture_before),
    nextReminderAt: optionalText(row.next_reminder_at),
    reminderCount: Number(row.reminder_count || 0),
    lastReminderAt: optionalText(row.last_reminder_at),
    lastActivityAt: String(row.last_activity_at),
    submittedAt: optionalText(row.submitted_at),
    reviewedAt: optionalText(row.reviewed_at),
    reviewedBy: optionalText(row.reviewed_by),
    overrideUsed: Boolean(row.override_used),
    overrideReason: optionalText(row.override_reason),
    failureCode: optionalText(row.failure_code),
    stateVersion: Number(row.state_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const APPLICATION_COLUMNS = [
  "id", "order_id", "reservation_id", "checkout_attempt_id", "customer_id", "event_id",
  "form_id", "form_version", "form_snapshot", "draft_answers", "submitted_answers", "consent_snapshot",
  "status", "payment_status", "completion_percentage", "stripe_checkout_session_id",
  "stripe_payment_intent_id", "authorized_amount_cents", "capturable_amount_cents", "currency",
  "form_due_at", "review_due_at", "capture_before", "next_reminder_at", "reminder_count",
  "last_reminder_at", "last_activity_at", "submitted_at", "reviewed_at", "reviewed_by",
  "override_used", "override_reason", "failure_code", "state_version", "created_at", "updated_at",
].join(",");

export async function preparePostCheckoutApplication(input: {
  orderId: string;
  form: PostCheckoutFormSnapshot;
  consentSnapshot: Record<string, unknown>;
  formDueAt: string;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc("skie_prepare_post_checkout_application", {
    p_order_id: input.orderId,
    p_form_id: input.form.id,
    p_form_version: input.form.version,
    p_form_snapshot: input.form,
    p_consent_snapshot: input.consentSnapshot,
    p_form_due_at: input.formDueAt,
  });
  if (error) throw new PostCheckoutStoreError(safeCode(error));
  const row = firstRow(data);
  return { applicationId: String(row.application_id), stateVersion: Number(row.state_version) };
}

export async function getOwnedPostCheckoutApplication(orderId: string, customerId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select(APPLICATION_COLUMNS)
    .eq("order_id", orderId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  return data ? mapApplication(data as unknown as Record<string, unknown>) : null;
}

export async function getPostCheckoutApplicationByOrder(orderId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select(APPLICATION_COLUMNS)
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  return data ? mapApplication(data as unknown as Record<string, unknown>) : null;
}

export async function getPostCheckoutApplicationByPaymentIntent(paymentIntentId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select(APPLICATION_COLUMNS)
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();
  if (error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  return data ? mapApplication(data as unknown as Record<string, unknown>) : null;
}

export async function savePostCheckoutDraft(input: {
  orderId: string;
  customerId: string;
  answers: Record<string, string | boolean | number>;
  completionPercentage: number;
  expectedStateVersion: number;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc("skie_save_post_checkout_draft", {
    p_order_id: input.orderId,
    p_customer_id: input.customerId,
    p_answers: input.answers,
    p_completion_percentage: input.completionPercentage,
    p_expected_state_version: input.expectedStateVersion,
  });
  if (error) throw new PostCheckoutStoreError(safeCode(error));
  const row = firstRow(data);
  return {
    applicationId: String(row.application_id),
    stateVersion: Number(row.state_version),
    savedAt: String(row.saved_at),
  };
}

export async function submitPostCheckoutApplication(input: {
  orderId: string;
  customerId: string;
  answers: Record<string, string | boolean | number>;
  completionPercentage: number;
  expectedStateVersion: number;
  reviewDueAt: string;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc("skie_submit_post_checkout_application", {
    p_order_id: input.orderId,
    p_customer_id: input.customerId,
    p_answers: input.answers,
    p_completion_percentage: input.completionPercentage,
    p_expected_state_version: input.expectedStateVersion,
    p_review_due_at: input.reviewDueAt,
  });
  if (error) throw new PostCheckoutStoreError(safeCode(error));
  const row = firstRow(data);
  return {
    applicationId: String(row.application_id),
    stateVersion: Number(row.state_version),
    submittedAt: String(row.submitted_at),
  };
}

export async function recordPostCheckoutAuthorization(input: {
  orderId: string;
  checkoutSessionId: string;
  paymentIntentId: string;
  amountCents: number;
  capturableCents: number;
  currency: string;
  captureBefore?: string;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc("skie_record_post_checkout_authorization", {
    p_order_id: input.orderId,
    p_stripe_session_id: input.checkoutSessionId,
    p_payment_intent_id: input.paymentIntentId,
    p_amount_cents: input.amountCents,
    p_capturable_cents: input.capturableCents,
    p_currency: input.currency,
    p_capture_before: input.captureBefore || null,
  });
  if (error) throw new PostCheckoutStoreError(safeCode(error));
  const row = firstRow(data);
  return { applicationId: String(row.application_id), duplicate: Boolean(row.duplicate) };
}

export async function requestPostCheckoutDecision(input: {
  applicationId: string;
  actorId: string;
  decision: PostCheckoutDecision;
  internalReason: string;
  customerMessage?: string;
  idempotencyKey: string;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc("skie_request_post_checkout_decision", {
    p_application_id: input.applicationId,
    p_actor_id: input.actorId,
    p_decision: input.decision,
    p_internal_reason: input.internalReason,
    p_customer_message: input.customerMessage || null,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw new PostCheckoutStoreError(safeCode(error));
  const row = firstRow(data);
  return {
    decisionId: String(row.decision_id),
    actionId: String(row.action_id),
    actionType: String(row.action_type) as "capture" | "cancel",
    paymentIntentId: String(row.payment_intent_id),
  };
}

export async function extendPostCheckoutDeadline(applicationId: string, actorId: string, formDueAt: string) {
  const { data, error } = await createSupabaseAdminClient().rpc("skie_extend_post_checkout_form_deadline", {
    p_application_id: applicationId,
    p_actor_id: actorId,
    p_form_due_at: formDueAt,
  });
  if (error) throw new PostCheckoutStoreError(safeCode(error));
  const row = firstRow(data);
  return {
    applicationId: String(row.application_id),
    formDueAt: String(row.form_due_at),
    stateVersion: Number(row.state_version),
  };
}

export async function markPostCheckoutCaptureConfirmed(paymentIntentId: string, amountCents: number) {
  const { data, error } = await createSupabaseAdminClient().rpc("skie_mark_post_checkout_capture_confirmed", {
    p_payment_intent_id: paymentIntentId,
    p_amount_cents: amountCents,
  });
  if (error) throw new PostCheckoutStoreError(safeCode(error));
  const row = firstRow(data);
  return {
    applicationId: String(row.application_id),
    orderId: String(row.order_id),
    reservationId: String(row.reservation_id),
  };
}

export async function markPostCheckoutCancelled(paymentIntentId: string, reason: string) {
  const { data, error } = await createSupabaseAdminClient().rpc("skie_mark_post_checkout_cancelled", {
    p_payment_intent_id: paymentIntentId,
    p_reason: reason,
  });
  if (error) throw new PostCheckoutStoreError(safeCode(error));
  const row = firstRow(data);
  return {
    applicationId: String(row.application_id),
    orderId: String(row.order_id),
    reservationId: String(row.reservation_id),
  };
}

export async function listAdminPostCheckoutApplications(): Promise<PostCheckoutAdminItem[]> {
  const client = createSupabaseAdminClient();
  const { data, error } = await client
    .from("post_checkout_applications")
    .select(`${APPLICATION_COLUMNS},customer:profiles!post_checkout_applications_customer_id_fkey(first_name,last_name,email,phone,instagram),orders(status,workflow_status,subtotal_cents,discount_cents,total_cents,currency,created_at,order_lines(kind,reference_id,name,quantity,unit_price_cents)),reservation:reservations!post_checkout_applications_reservation_id_fkey(expected_subtotal_cents,expected_discount_cents,expected_total_cents,promo_code_id),decision:post_checkout_decisions!post_checkout_decisions_application_id_fkey(id,decision,internal_reason,customer_message,actor_id,created_at),payment_actions:post_checkout_payment_actions!post_checkout_payment_actions_application_id_fkey(id,action_type,status,attempt_count,safe_error_code,available_at,last_attempt_at,created_at)`)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  const rows = data || [];
  const promoIds = [...new Set(rows.flatMap((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const reservationValue = Array.isArray(row.reservation) ? row.reservation[0] : row.reservation;
    const reservation = objectRecord(reservationValue);
    return reservation.promo_code_id ? [String(reservation.promo_code_id)] : [];
  }))];
  const promosById = new Map<string, Record<string, unknown>>();
  if (promoIds.length) {
    const promoResult = await client.from("promo_codes")
      .select("id,code,internal_name,discount_type")
      .in("id", promoIds);
    if (promoResult.error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
    for (const promo of promoResult.data || []) {
      promosById.set(String(promo.id), promo as unknown as Record<string, unknown>);
    }
  }
  return rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const base = mapApplication(row);
    const profileValue = Array.isArray(row.customer) ? row.customer[0] : row.customer;
    const profile = objectRecord(profileValue);
    const orderValue = Array.isArray(row.orders) ? row.orders[0] : row.orders;
    const order = objectRecord(orderValue);
    const linesValue = order.order_lines;
    const lines = Array.isArray(linesValue) ? linesValue.map((item) => objectRecord(item)) : [];
    const reservationValue = Array.isArray(row.reservation) ? row.reservation[0] : row.reservation;
    const reservation = objectRecord(reservationValue);
    const promoCodeId = optionalText(reservation.promo_code_id);
    const promo = promoCodeId ? promosById.get(promoCodeId) : undefined;
    const subtotalCents = Number(reservation.expected_subtotal_cents ?? order.subtotal_cents ?? order.total_cents ?? 0);
    const discountCents = Number(reservation.expected_discount_cents ?? order.discount_cents ?? 0);
    const totalCents = Number(order.total_cents || 0);
    const expectedTotalCents = Number(reservation.expected_total_cents ?? totalCents);
    const pricingIntegrity = subtotalCents - discountCents === totalCents && expectedTotalCents === totalCents;
    const decisionValue = Array.isArray(row.decision) ? row.decision[0] : row.decision;
    const decision = objectRecord(decisionValue);
    const paymentActions = Array.isArray(row.payment_actions)
      ? row.payment_actions.map((item) => objectRecord(item)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      : [];
    const paymentAction = paymentActions[0] || {};
    return {
      ...base,
      customer: {
        firstName: String(profile.first_name || ""),
        lastName: String(profile.last_name || ""),
        email: String(profile.email || ""),
        phone: String(profile.phone || ""),
        instagram: String(profile.instagram || ""),
      },
      event: { title: String(row.event_id), slug: String(row.event_id) },
      order: {
        status: String(order.status || ""),
        workflowStatus: String(order.workflow_status || ""),
        subtotalCents,
        discountCents,
        totalCents,
        pricingIntegrity,
        currency: String(order.currency || "AUD"),
        createdAt: String(order.created_at || base.createdAt),
        items: lines.map((line) => ({
          kind: String(line.kind), referenceId: String(line.reference_id), name: String(line.name),
          quantity: Number(line.quantity), unitPriceCents: Number(line.unit_price_cents),
        })),
      },
      promo: promo && promoCodeId ? {
        id: promoCodeId,
        code: String(promo.code || ""),
        internalName: String(promo.internal_name || ""),
        discountType: String(promo.discount_type) as "percentage" | "fixed" | "tracking",
        trackingOnly: String(promo.discount_type) === "tracking",
      } : undefined,
      decision: decision.id ? {
        id: String(decision.id),
        decision: String(decision.decision),
        internalReason: String(decision.internal_reason),
        customerMessage: optionalText(decision.customer_message),
        actorId: String(decision.actor_id),
        createdAt: String(decision.created_at),
      } : undefined,
      paymentAction: paymentAction.id ? {
        id: String(paymentAction.id),
        actionType: String(paymentAction.action_type) as "capture" | "cancel" | "reconcile",
        status: String(paymentAction.status),
        attemptCount: Number(paymentAction.attempt_count || 0),
        safeErrorCode: optionalText(paymentAction.safe_error_code),
        availableAt: String(paymentAction.available_at),
        lastAttemptAt: optionalText(paymentAction.last_attempt_at),
      } : undefined,
    };
  });
}

export async function listDuePostCheckoutReminders(limit = 25) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select(`${APPLICATION_COLUMNS},customer:profiles!post_checkout_applications_customer_id_fkey(first_name,email),orders(total_cents,currency)`)
    .in("status", ["awaiting_form", "draft"])
    .eq("payment_status", "authorized")
    .not("next_reminder_at", "is", null)
    .lte("next_reminder_at", new Date().toISOString())
    .order("next_reminder_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 100)));
  if (error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  return data || [];
}

export async function markPostCheckoutReminderQueued(applicationId: string, nextReminderAt?: string) {
  const { error } = await createSupabaseAdminClient().rpc("skie_mark_post_checkout_reminder_queued", {
    p_application_id: applicationId,
    p_next_reminder_at: nextReminderAt || null,
  });
  if (error) throw new PostCheckoutStoreError(safeCode(error));
}

export async function listExpiredIncompletePostCheckoutApplications(limit = 25) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select(APPLICATION_COLUMNS)
    .in("status", ["awaiting_form", "draft"])
    .eq("payment_status", "authorized")
    .lte("form_due_at", new Date().toISOString())
    .order("form_due_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 100)));
  if (error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  return (data || []).map((row) => mapApplication(row as unknown as Record<string, unknown>));
}

export async function listDuePostCheckoutPaymentActions(limit = 25) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_payment_actions")
    .select("id,application_id,order_id,decision_id,stripe_payment_intent_id,action_type,status,idempotency_key,attempt_count,available_at,requested_by")
    .in("status", ["requested", "retry"])
    .lte("available_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 100)));
  if (error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  return data || [];
}

export async function markPostCheckoutPaymentActionProcessing(id: string, workerId: string) {
  const now = new Date();
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_payment_actions")
    .update({
      status: "processing",
      lease_owner: workerId,
      lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
      attempt_count: 1,
      last_attempt_at: now.toISOString(),
    })
    .eq("id", id)
    .in("status", ["requested", "retry"])
    .select("id")
    .maybeSingle();
  if (error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  return Boolean(data);
}

export async function finishPostCheckoutPaymentAction(input: {
  id: string;
  status: "completed" | "retry" | "failed" | "manual_review";
  safeErrorCode?: string;
  retryAt?: string;
}) {
  const { error } = await createSupabaseAdminClient()
    .from("post_checkout_payment_actions")
    .update({
      status: input.status,
      safe_error_code: input.safeErrorCode || null,
      available_at: input.retryAt || new Date().toISOString(),
      lease_owner: null,
      lease_expires_at: null,
      completed_at: input.status === "completed" ? new Date().toISOString() : null,
    })
    .eq("id", input.id);
  if (error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
}

export async function addPostCheckoutAudit(input: {
  applicationId?: string;
  orderId?: string;
  actorId?: string;
  action: string;
  safeMetadata?: Record<string, string | number | boolean | null>;
}) {
  const { error } = await createSupabaseAdminClient().from("post_checkout_audit_events").insert({
    application_id: input.applicationId || null,
    order_id: input.orderId || null,
    actor_id: input.actorId || null,
    action: input.action,
    safe_metadata: input.safeMetadata || {},
  });
  if (error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
}
