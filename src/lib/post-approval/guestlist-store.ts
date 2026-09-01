import "server-only";

import { config } from "@/lib/config";
import { readSiteData } from "@/lib/data/documents";
import { sendTemplateEmail } from "@/lib/email";
import type { PostCheckoutDecision, PostCheckoutDecisionResult } from "@/lib/post-approval/types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function firstRow(value: unknown) {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") throw new Error("GUESTLIST_APPLICATION_INVALID_RESPONSE");
  return row as Record<string, unknown>;
}

function nestedRecord(value: unknown) {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" ? row as Record<string, unknown> : {};
}

export async function activateGuestlistApplication(orderId: string) {
  const { data, error } = await createSupabaseAdminClient().rpc(
    "skie_activate_guestlist_application",
    { p_order_id: orderId },
  );
  if (error) throw new Error(String(error.message || "GUESTLIST_APPLICATION_ACTIVATION_FAILED"));
  const row = firstRow(data);
  return {
    applicationId: String(row.application_id),
    duplicate: Boolean(row.duplicate),
  };
}

export async function guestlistApplicationContext(applicationId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select("id,order_id,event_id,customer_id,status,payment_status")
    .eq("id", applicationId)
    .maybeSingle();
  if (error) throw new Error("POST_APPROVAL_STORE_UNAVAILABLE");
  if (!data) throw new Error("POST_APPROVAL_APPLICATION_NOT_FOUND");
  return {
    id: String(data.id),
    orderId: String(data.order_id),
    eventId: String(data.event_id),
    customerId: String(data.customer_id),
    status: String(data.status),
    paymentStatus: String(data.payment_status),
    guestlistApplication: String(data.payment_status) === "not_required",
  };
}

export async function guestlistOrderContext(orderId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select("id,order_id,event_id,customer_id,status,payment_status")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw new Error("POST_APPROVAL_STORE_UNAVAILABLE");
  if (!data) throw new Error("POST_APPROVAL_APPLICATION_NOT_FOUND");
  return {
    id: String(data.id),
    orderId: String(data.order_id),
    eventId: String(data.event_id),
    customerId: String(data.customer_id),
    status: String(data.status),
    paymentStatus: String(data.payment_status),
    guestlistApplication: String(data.payment_status) === "not_required",
  };
}

export async function requestGuestlistDecision(input: {
  applicationId: string;
  actorId: string;
  decision: PostCheckoutDecision;
  internalReason: string;
  customerMessage?: string;
}): Promise<PostCheckoutDecisionResult> {
  const { data, error } = await createSupabaseAdminClient().rpc(
    "skie_request_guestlist_decision",
    {
      p_application_id: input.applicationId,
      p_actor_id: input.actorId,
      p_decision: input.decision,
      p_internal_reason: input.internalReason,
      p_customer_message: input.customerMessage || null,
    },
  );
  if (error) throw new Error(String(error.message || "GUESTLIST_DECISION_FAILED"));
  const row = firstRow(data);
  return {
    decisionId: String(row.decision_id),
    actionType: String(row.action_type) as "fulfil" | "release",
    guestlistApplication: true,
  };
}

export async function markGuestlistManualReview(orderId: string, failureCode: string) {
  const { error } = await createSupabaseAdminClient().rpc(
    "skie_mark_guestlist_manual_review",
    {
      p_order_id: orderId,
      p_failure_code: failureCode.slice(0, 120),
    },
  );
  if (error) throw new Error("GUESTLIST_MANUAL_REVIEW_MARK_FAILED");
}

export async function markGuestlistFulfilled(orderId: string) {
  const { data, error } = await createSupabaseAdminClient().rpc(
    "skie_mark_post_checkout_fulfilled",
    { p_order_id: orderId },
  );
  if (error) throw new Error(String(error.message || "POST_APPROVAL_FULFILMENT_STATUS_FAILED"));
  const row = firstRow(data);
  return {
    applicationId: String(row.application_id),
    orderId: String(row.order_id),
    duplicate: Boolean(row.duplicate),
  };
}

async function queueGuestlistExpiryNotification(
  applicationId: string,
  orderId: string,
  reason: "form_expired" | "review_expired",
) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select("customer_id,event_id,form_due_at,customer:profiles!post_checkout_applications_customer_id_fkey(first_name,email)")
    .eq("id", applicationId)
    .maybeSingle();
  if (error || !data) throw new Error("POST_APPROVAL_NOTIFICATION_CONTEXT_UNAVAILABLE");
  const customer = nestedRecord(data.customer);
  const site = await readSiteData();
  const event = site.events.find((item) => item.id === String(data.event_id));
  const templateKey = reason === "form_expired"
    ? "post_checkout_form_expired"
    : "post_checkout_rejected";
  await sendTemplateEmail({
    templateKey,
    to: String(customer.email || ""),
    recipientUserId: String(data.customer_id),
    eventId: String(data.event_id),
    orderId,
    variables: {
      first_name: String(customer.first_name || "there"),
      event_title: event?.title || "your SKIE event",
      expires_at: new Date(String(data.form_due_at)).toLocaleString("en-AU", {
        timeZone: config.timezone,
      }),
      account_url: `${config.siteUrl}/account`,
    },
    idempotencyKey: `guestlist_${reason}:${applicationId}`,
  });
}

export async function expireGuestlistApplication(applicationId: string, reason: "form_expired" | "review_expired") {
  const { data, error } = await createSupabaseAdminClient().rpc(
    "skie_expire_guestlist_application",
    {
      p_application_id: applicationId,
      p_reason: reason,
    },
  );
  if (error) throw new Error(String(error.message || "GUESTLIST_APPLICATION_EXPIRY_FAILED"));
  const row = firstRow(data);
  const result = {
    applicationId: String(row.application_id),
    orderId: String(row.order_id),
    duplicate: Boolean(row.duplicate),
  };
  await queueGuestlistExpiryNotification(
    result.applicationId,
    result.orderId,
    reason,
  ).catch(() => undefined);
  return result;
}

export async function listDueGuestlistReminders(limit = 25) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select("id,order_id,customer_id,event_id,payment_status,form_due_at,reminder_count,completion_percentage,customer:profiles!post_checkout_applications_customer_id_fkey(first_name,email)")
    .in("status", ["awaiting_form", "draft"])
    .eq("payment_status", "not_required")
    .not("next_reminder_at", "is", null)
    .lte("next_reminder_at", new Date().toISOString())
    .order("next_reminder_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 25)));
  if (error) throw new Error("POST_APPROVAL_STORE_UNAVAILABLE");
  return data || [];
}

export async function listExpiredGuestlistForms(limit = 25) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select("id")
    .in("status", ["awaiting_form", "draft"])
    .eq("payment_status", "not_required")
    .lte("form_due_at", new Date().toISOString())
    .order("form_due_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 25)));
  if (error) throw new Error("POST_APPROVAL_STORE_UNAVAILABLE");
  return (data || []).map((row) => ({ id: String(row.id), paymentStatus: "not_required" as const }));
}

export async function listExpiredGuestlistReviews(limit = 25) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select("id")
    .in("status", ["submitted", "under_review"])
    .eq("payment_status", "not_required")
    .not("review_due_at", "is", null)
    .lte("review_due_at", new Date().toISOString())
    .order("review_due_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 25)));
  if (error) throw new Error("POST_APPROVAL_STORE_UNAVAILABLE");
  return (data || []).map((row) => ({ id: String(row.id), paymentStatus: "not_required" as const }));
}
