import "server-only";

import type Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { readSiteData } from "@/lib/data/documents";
import { sendTemplateEmail } from "@/lib/email";
import { cancelStripePaymentIntent, captureStripePaymentIntent, retrieveStripePaymentIntent } from "@/lib/payments";
import { postCheckoutApplicationEventOpen } from "@/lib/payments/event-shutdown";
import {
  expireGuestlistApplication,
  listDueGuestlistReminders,
  listExpiredGuestlistForms,
  listExpiredGuestlistReviews,
} from "@/lib/post-approval/guestlist-store";
import {
  finishPostCheckoutPaymentAction,
  listDuePostCheckoutReminders,
  listExpiredIncompletePostCheckoutApplications,
  markPostCheckoutCancelled,
  markPostCheckoutReminderQueued,
} from "@/lib/post-approval/store";
import {
  listPostCheckoutCaptureSafetyTimeouts,
  listPostCheckoutReviewTimeouts,
} from "@/lib/post-approval/timeout-store";
import {
  claimPostCheckoutPaymentActionById,
  claimPostCheckoutPaymentActions,
  requestPostCheckoutTimeout,
} from "@/lib/post-approval/worker-store";
import { handlePostCheckoutPaymentCancelled, handlePostCheckoutPaymentSucceeded } from "@/lib/post-approval/service";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { PostCheckoutWorkerResult } from "@/lib/post-approval/types";

function assertWorkerAvailable() {
  if (config.dataProvider !== "supabase") throw new Error("POST_APPROVAL_REQUIRES_SUPABASE");
}

function nestedObject(value: unknown) {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" ? row as Record<string, unknown> : {};
}

function safePaymentActionErrorCode(error: unknown) {
  const candidate = error instanceof Error ? error.message : "";
  return /^[A-Z0-9_]{3,120}$/.test(candidate)
    ? candidate
    : "POST_APPROVAL_PAYMENT_ACTION_FAILED";
}

function appendSafePaymentActionErrorCode(codes: string[], candidate: unknown) {
  const value = typeof candidate === "string" ? candidate : "";
  if (/^[A-Z0-9_]{3,120}$/.test(value) && !codes.includes(value)) codes.push(value);
}

type SiteSnapshot = Awaited<ReturnType<typeof readSiteData>>;

type PaymentActionProcessResult = {
  completed: boolean;
  errorCode?: string;
};

async function queueDueReminder(raw: Record<string, unknown>, site: SiteSnapshot) {
  const profile = nestedObject(raw.customer);
  const event = site.events.find((item) => item.id === String(raw.event_id));
  const reminderCount = Number(raw.reminder_count || 0);
  const final = reminderCount >= 2;
  const templateKey = final ? "post_checkout_form_final_reminder" : "post_checkout_form_reminder";
  const applicationId = String(raw.id);
  const orderId = String(raw.order_id);
  const customerId = String(raw.customer_id);
  const formDueAt = String(raw.form_due_at);
  await sendTemplateEmail({
    templateKey,
    to: String(profile.email || ""),
    recipientUserId: customerId,
    eventId: String(raw.event_id),
    orderId,
    variables: {
      first_name: String(profile.first_name || "there"),
      event_title: event?.title || "your SKIE event",
      completion_percentage: Number(raw.completion_percentage || 0),
      expires_at: new Date(formDueAt).toLocaleString("en-AU", { timeZone: config.timezone }),
      account_url: `${config.siteUrl}/account/applications/${encodeURIComponent(orderId)}`,
    },
    idempotencyKey: `${templateKey}:${applicationId}:${reminderCount + 1}`,
  });
  const dueAt = new Date(formDueAt).getTime();
  const next = final ? undefined : new Date(Math.min(dueAt, Date.now() + (reminderCount === 0 ? 35 : 55) * 60_000)).toISOString();
  await markPostCheckoutReminderQueued(applicationId, next);
  await createSupabaseAdminClient().from("post_checkout_audit_events").insert({
    application_id: applicationId,
    order_id: orderId,
    actor_id: null,
    action: final ? "post_checkout.final_reminder_queued" : "post_checkout.form_reminder_queued",
    safe_metadata: { reminderNumber: reminderCount + 1 },
  });
}

async function cancellationReasonForApplication(applicationId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select("status")
    .eq("id", applicationId)
    .maybeSingle();
  if (error) return "rejected";
  return data?.status === "form_expired"
    ? "form_expired"
    : data?.status === "authorization_expired" ? "authorization_expired" : "rejected";
}

async function finaliseCancelledCapture(paymentIntentId: string, reason: string) {
  try {
    await markPostCheckoutCancelled(paymentIntentId, reason);
  } catch {
    throw new Error("POST_APPROVAL_CANCEL_FINALIZATION_FAILED");
  }
}

async function sendCancellationNotificationBestEffort(
  paymentIntent: Stripe.PaymentIntent,
  reason: string,
) {
  await handlePostCheckoutPaymentCancelled(paymentIntent, reason).catch(() => undefined);
}

async function closeCaptureForClosedEvent(
  action: Awaited<ReturnType<typeof claimPostCheckoutPaymentActions>>[number],
  current: Stripe.PaymentIntent,
) {
  if (current.status === "succeeded") throw new Error("EVENT_SHUTDOWN_PAYMENT_ALREADY_CAPTURED");
  const cancelled = current.status === "canceled"
    ? current
    : await cancelStripePaymentIntent(
      action.paymentIntentId,
      `event-shutdown-capture:${action.id}`,
    );
  if (cancelled.status !== "canceled") {
    throw new Error(`EVENT_SHUTDOWN_CANCEL_${cancelled.status.toUpperCase()}`);
  }
  await finaliseCancelledCapture(cancelled.id, "rejected");
  await sendCancellationNotificationBestEffort(cancelled as Stripe.PaymentIntent, "rejected");
}

async function requeueCancelledManualReviewActions(limit: number) {
  const client = createSupabaseAdminClient();
  const bounded = Math.max(1, Math.min(limit, 25));
  const { data, error } = await client
    .from("post_checkout_payment_actions")
    .select("id,stripe_payment_intent_id")
    .eq("status", "manual_review")
    .in("action_type", ["capture", "cancel", "reconcile"])
    .in("safe_error_code", [
      "POST_APPROVAL_STORE_UNAVAILABLE",
      "POST_APPROVAL_CANCEL_FINALIZATION_FAILED",
    ])
    .order("updated_at", { ascending: true })
    .limit(bounded);
  if (error) return 0;

  let requeued = 0;
  for (const row of data || []) {
    let current: Stripe.PaymentIntent | null = null;
    try {
      current = await retrieveStripePaymentIntent(String(row.stripe_payment_intent_id));
    } catch {
      continue;
    }
    if (!current || current.status !== "canceled") continue;

    const { data: updated, error: updateError } = await client
      .from("post_checkout_payment_actions")
      .update({
        status: "retry",
        available_at: new Date().toISOString(),
        lease_owner: null,
        lease_expires_at: null,
        safe_error_code: "POST_APPROVAL_TERMINAL_RECONCILIATION",
      })
      .eq("id", String(row.id))
      .eq("status", "manual_review")
      .select("id")
      .maybeSingle();
    if (!updateError && updated) requeued += 1;
  }
  return requeued;
}

async function processAction(
  action: Awaited<ReturnType<typeof claimPostCheckoutPaymentActions>>[number],
): Promise<PaymentActionProcessResult> {
  try {
    const current = await retrieveStripePaymentIntent(action.paymentIntentId);
    if (!current) throw new Error("POST_APPROVAL_PAYMENT_INTENT_MISSING");
    if (action.actionType === "capture") {
      const eventOpen = await postCheckoutApplicationEventOpen(action.applicationId);
      if (!eventOpen) {
        await closeCaptureForClosedEvent(action, current as Stripe.PaymentIntent);
      } else if (current.status === "canceled") {
        const reason = await cancellationReasonForApplication(action.applicationId);
        await finaliseCancelledCapture(current.id, reason);
        await sendCancellationNotificationBestEffort(current, reason);
      } else {
        const result = current.status === "requires_capture"
          ? await captureStripePaymentIntent(action.paymentIntentId, action.idempotencyKey)
          : current;
        if (result.status !== "succeeded") throw new Error(`POST_APPROVAL_CAPTURE_${result.status.toUpperCase()}`);
        await handlePostCheckoutPaymentSucceeded(result as Stripe.PaymentIntent, `post_action_${action.id}`);
      }
    } else if (action.actionType === "cancel") {
      const result = current.status === "canceled"
        ? current
        : await cancelStripePaymentIntent(action.paymentIntentId, action.idempotencyKey);
      if (result.status !== "canceled") throw new Error(`POST_APPROVAL_CANCEL_${result.status.toUpperCase()}`);
      const reason = await cancellationReasonForApplication(action.applicationId);
      await finaliseCancelledCapture(result.id, reason);
      await sendCancellationNotificationBestEffort(result as Stripe.PaymentIntent, reason);
    } else {
      if (current.status === "succeeded") {
        await handlePostCheckoutPaymentSucceeded(current, `post_reconcile_${action.id}`);
      } else if (current.status === "canceled") {
        const reason = await cancellationReasonForApplication(action.applicationId);
        await finaliseCancelledCapture(current.id, reason);
        await sendCancellationNotificationBestEffort(current, reason);
      } else {
        throw new Error(`POST_APPROVAL_RECONCILE_${current.status.toUpperCase()}`);
      }
    }
    await finishPostCheckoutPaymentAction({ id: action.id, status: "completed" });
    return { completed: true };
  } catch (error) {
    const errorCode = safePaymentActionErrorCode(error);
    const terminal = action.attemptCount >= 5
      || errorCode === "EVENT_SHUTDOWN_PAYMENT_ALREADY_CAPTURED";
    await finishPostCheckoutPaymentAction({
      id: action.id,
      status: terminal ? "manual_review" : "retry",
      safeErrorCode: errorCode,
      retryAt: new Date(Date.now() + Math.min(30, 2 ** Math.max(1, action.attemptCount)) * 60_000).toISOString(),
    });
    return { completed: false, errorCode };
  }
}

export async function processPostCheckoutPaymentActionById(actionId: string) {
  assertWorkerAvailable();
  const action = await claimPostCheckoutPaymentActionById(
    actionId,
    `post_checkout_immediate_${randomUUID()}`,
  );
  if (!action) return { claimed: false, completed: false };
  const processed = await processAction(action);
  return { claimed: true, ...processed };
}

export async function processPostCheckoutApprovalBatch(batchSize = 25): Promise<PostCheckoutWorkerResult> {
  assertWorkerAvailable();
  const size = Math.max(1, Math.min(batchSize, 25));
  const result = {
    remindersQueued: 0,
    expiriesRequested: 0,
    formExpiriesRequested: 0,
    reviewExpiriesRequested: 0,
    authorizationExpiriesRequested: 0,
    paymentActionsProcessed: 0,
    paymentActionsFailed: 0,
    paymentActionErrorCodes: [] as string[],
  };

  const captureSafetyTimeouts = await listPostCheckoutCaptureSafetyTimeouts(size);
  for (const application of captureSafetyTimeouts) {
    try {
      const action = await requestPostCheckoutTimeout(
        application.id,
        "authorization_expired",
        `post-authorization-timeout:${application.id}`,
        config.postCheckoutCaptureSafetyMinutes,
      );
      if (action) {
        result.authorizationExpiriesRequested += 1;
        result.expiriesRequested += 1;
      }
    } catch {
      // Leave the row eligible for a later run or manual review.
    }
  }

  const expiredForms = await listExpiredIncompletePostCheckoutApplications(size);
  for (const application of expiredForms) {
    try {
      const action = await requestPostCheckoutTimeout(
        application.id,
        "form_expired",
        `post-form-timeout:${application.id}`,
        config.postCheckoutCaptureSafetyMinutes,
      );
      if (action) {
        result.formExpiriesRequested += 1;
        result.expiriesRequested += 1;
      }
    } catch {
      // Leave the row eligible for a later run or manual review.
    }
  }

  const expiredGuestlistForms = await listExpiredGuestlistForms(size);
  for (const application of expiredGuestlistForms) {
    try {
      await expireGuestlistApplication(application.id, "form_expired");
      result.formExpiriesRequested += 1;
      result.expiriesRequested += 1;
    } catch {
      // Leave the row eligible for a later run or manual review.
    }
  }

  const reviewTimeouts = await listPostCheckoutReviewTimeouts(size);
  for (const application of reviewTimeouts) {
    try {
      const action = await requestPostCheckoutTimeout(
        application.id,
        "review_expired",
        `post-review-timeout:${application.id}`,
        config.postCheckoutCaptureSafetyMinutes,
      );
      if (action) {
        result.reviewExpiriesRequested += 1;
        result.expiriesRequested += 1;
      }
    } catch {
      // Leave the row eligible for a later run or manual review.
    }
  }

  const expiredGuestlistReviews = await listExpiredGuestlistReviews(size);
  for (const application of expiredGuestlistReviews) {
    try {
      await expireGuestlistApplication(application.id, "review_expired");
      result.reviewExpiriesRequested += 1;
      result.expiriesRequested += 1;
    } catch {
      // Leave the row eligible for a later run or manual review.
    }
  }

  const [paidReminders, guestlistReminders] = await Promise.all([
    listDuePostCheckoutReminders(size),
    listDueGuestlistReminders(size),
  ]);
  const reminders = [...paidReminders, ...guestlistReminders].slice(0, size);
  const site = reminders.length ? await readSiteData() : null;
  if (site) {
    for (const raw of reminders) {
      try {
        await queueDueReminder(raw as unknown as Record<string, unknown>, site);
        result.remindersQueued += 1;
      } catch {
        // The row remains due; a later run can safely retry with the same idempotency key.
      }
    }
  }

  await requeueCancelledManualReviewActions(size);

  const actions = await claimPostCheckoutPaymentActions(`post_checkout_${randomUUID()}`, size);
  for (const action of actions) {
    const processed = await processAction(action);
    if (processed.completed) {
      result.paymentActionsProcessed += 1;
    } else {
      result.paymentActionsFailed += 1;
      appendSafePaymentActionErrorCode(result.paymentActionErrorCodes, processed.errorCode);
    }
  }

  const { data: unresolvedActions, error: unresolvedActionsError } = await createSupabaseAdminClient()
    .from("post_checkout_payment_actions")
    .select("safe_error_code")
    .in("status", ["failed", "manual_review"])
    .not("safe_error_code", "is", null)
    .order("updated_at", { ascending: false })
    .limit(25);
  if (!unresolvedActionsError) {
    for (const unresolvedAction of unresolvedActions || []) {
      appendSafePaymentActionErrorCode(result.paymentActionErrorCodes, unresolvedAction.safe_error_code);
    }
  }

  return result;
}
