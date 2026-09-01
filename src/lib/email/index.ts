import "server-only";

import { enqueueEmail } from "@/lib/notifications/store";
import { enqueueTransactionalNotifications, getCustomerNotificationContact } from "@/lib/notifications/service";
import type { NotificationTemplateKey } from "@/lib/notifications/types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type TemplateEmailOptions = {
  templateKey: string;
  to: string;
  variables: Record<string, string | number>;
  idempotencyKey: string;
  recipientUserId?: string;
  eventId?: string;
  orderId?: string;
};

const postCheckoutPaymentTemplates = new Set([
  "post_checkout_form_required",
  "post_checkout_form_reminder",
  "post_checkout_form_final_reminder",
  "post_checkout_form_expired",
  "post_checkout_form_submitted",
  "post_checkout_approved",
  "post_checkout_rejected",
  "post_checkout_authorisation_expired",
  "post_checkout_reauthorisation_required",
]);

function variableText(variables: Record<string, string | number>, key: string, fallback: string) {
  const value = variables[key];
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

async function isNoPaymentGuestlistOrder(orderId: string) {
  const client = createSupabaseAdminClient();
  const { data: application, error: applicationError } = await client
    .from("post_checkout_applications")
    .select("payment_status,reservation_id")
    .eq("order_id", orderId)
    .maybeSingle();
  if (applicationError || !application) throw new Error("POST_APPROVAL_NOTIFICATION_CONTEXT_UNAVAILABLE");
  if (String(application.payment_status) === "not_required") return true;

  const [{ data: order, error: orderError }, { data: reservation, error: reservationError }] = await Promise.all([
    client.from("orders").select("total_cents").eq("id", orderId).maybeSingle(),
    client.from("reservations").select("promo_code_id").eq("id", String(application.reservation_id)).maybeSingle(),
  ]);
  if (orderError || reservationError || !order || !reservation?.promo_code_id) {
    throw new Error("POST_APPROVAL_NOTIFICATION_CONTEXT_UNAVAILABLE");
  }
  const { data: promo, error: promoError } = await client
    .from("promo_codes")
    .select("discount_type")
    .eq("id", String(reservation.promo_code_id))
    .maybeSingle();
  if (promoError || !promo) throw new Error("POST_APPROVAL_NOTIFICATION_CONTEXT_UNAVAILABLE");
  return Number(order.total_cents) === 0 && String(promo.discount_type) === "guestlist";
}

function noPaymentGuestlistCopy(
  templateKey: string,
  variables: Record<string, string | number>,
) {
  const eventTitle = variableText(variables, "event_title", "your SKIE event");
  const deadline = variableText(variables, "expires_at", "the displayed deadline");
  const completion = variableText(variables, "completion_percentage", "0");
  switch (templateKey) {
    case "post_checkout_form_required":
      return {
        subject: `Complete your mandatory ${eventTitle} application`,
        message: `No payment is required for this ticket-only guest-list request. Complete the mandatory application before ${deadline}. No ticket or QR code will be issued unless SKIE approves the application.`,
      };
    case "post_checkout_form_reminder":
      return {
        subject: `Your ${eventTitle} guest-list application is incomplete`,
        message: `Your saved application is ${completion}% complete. No payment is required, but no ticket will be issued until the form is submitted and SKIE approves it. Complete it before ${deadline}.`,
      };
    case "post_checkout_form_final_reminder":
      return {
        subject: `Final reminder: complete your ${eventTitle} application`,
        message: `Complete the mandatory guest-list application before ${deadline}. Otherwise the reserved place will be released. No payment has been taken and no ticket has been issued.`,
      };
    case "post_checkout_form_expired":
      return {
        subject: `Your ${eventTitle} application deadline passed`,
        message: `The mandatory guest-list application was not completed before ${deadline}. The reserved place has been released, no payment was taken, and no ticket or QR code was issued.`,
      };
    case "post_checkout_form_submitted":
      return {
        subject: `Your ${eventTitle} application is under review`,
        message: "Your mandatory guest-list application has been received. No payment is required. No ticket or QR code will be issued unless SKIE approves the application.",
      };
    case "post_checkout_approved":
      return {
        subject: `You are approved for ${eventTitle}`,
        message: "Your guest-list application has been approved. No payment was required, and your ticket is being issued to your account.",
      };
    case "post_checkout_rejected":
      return {
        subject: `Update on your ${eventTitle} application`,
        message: "Your guest-list application was not approved. The reserved place has been released, no payment was taken, and no ticket or QR code was issued.",
      };
    default:
      return {
        subject: `Update on your ${eventTitle} application`,
        message: "This ticket-only guest-list application has ended. No payment was taken and no ticket or QR code was issued.",
      };
  }
}

async function normalizeNoPaymentGuestlistNotification(options: TemplateEmailOptions) {
  if (!options.orderId || !postCheckoutPaymentTemplates.has(options.templateKey)) return options;
  if (!(await isNoPaymentGuestlistOrder(options.orderId))) return options;
  const copy = noPaymentGuestlistCopy(options.templateKey, options.variables);
  return {
    ...options,
    templateKey: "admin_manual_message",
    variables: {
      ...options.variables,
      subject: copy.subject,
      message: copy.message,
    },
  };
}

/**
 * Backward-compatible workflow entry point. Delivery is intentionally deferred to
 * the durable notification outbox so a committed application/payment mutation is
 * never reported as failed because an email provider is unavailable.
 */
export async function sendTemplateEmail(rawOptions: TemplateEmailOptions) {
  const options = await normalizeNoPaymentGuestlistNotification(rawOptions);
  if (options.recipientUserId) {
    const contact = await getCustomerNotificationContact(options.recipientUserId);
    const result = await enqueueTransactionalNotifications({
      templateKey: options.templateKey as NotificationTemplateKey,
      recipientUserId: options.recipientUserId,
      recipientEmail: options.to || contact.email,
      recipientPhone: contact.phone,
      eventId: options.eventId,
      orderId: options.orderId,
      payload: { variables: options.variables, orderId: options.orderId, reason: "workflow" },
      idempotencyKey: options.idempotencyKey,
    });
    return { duplicate: result.queued.every((item) => item.duplicate), status: "queued", notificationIds: result.queued.map((item) => item.id) };
  }
  const result = await enqueueEmail({
    templateKey: options.templateKey as NotificationTemplateKey,
    recipientAddress: options.to,
    recipientUserId: options.recipientUserId,
    eventId: options.eventId,
    orderId: options.orderId,
    payload: { variables: options.variables, orderId: options.orderId, reason: "workflow" },
    idempotencyKey: options.idempotencyKey,
  });
  return { duplicate: result.duplicate, status: result.item.status, notificationId: result.item.id };
}
