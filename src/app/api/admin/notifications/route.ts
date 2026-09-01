import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "@/lib/config";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest, PublicApiError } from "@/lib/http";
import { enqueueTicketNotificationsForOrder, enqueueTransactionalNotifications, getCustomerNotificationContact, previewTemplate } from "@/lib/notifications/service";
import { auditNotificationAdminAction, enqueueNotification, listNotifications, manageNotification, setNotificationControl } from "@/lib/notifications/store";
import type { NotificationTemplateKey } from "@/lib/notifications/types";
import type { NotificationChannel } from "@/types/site";
import { requireUser } from "@/lib/security/session";

const templateKeys = [
  "application_received", "ticket_unlocked", "waitlist", "not_selected", "payment_confirmed",
  "ticket_issued", "ticket_resend", "refund_invalidation", "event_update", "event_cancellation",
  "event_reminder", "payment_reminder", "admin_manual_message",
] as const;
const channels = ["email", "sms", "in_app", "whatsapp"] as const;

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), templateKey: z.enum(templateKeys), channel: z.enum(channels).default("email") }).strict(),
  z.object({ action: z.literal("test_send"), templateKey: z.enum(templateKeys), channel: z.enum(channels).default("email"), recipient: z.string().trim().min(1).max(254), orderId: z.string().trim().min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal("resend_ticket"), orderId: z.string().trim().min(1).max(100) }).strict(),
  z.object({ action: z.literal("bulk_resend_ticket"), orderIds: z.array(z.string().trim().min(1).max(100)).min(1).max(100) }).strict(),
  z.object({ action: z.literal("retry"), notificationId: z.string().trim().min(1).max(100) }).strict(),
  z.object({ action: z.literal("bulk_retry"), notificationIds: z.array(z.string().trim().min(1).max(100)).min(1).max(100) }).strict(),
  z.object({ action: z.literal("cancel"), notificationId: z.string().trim().min(1).max(100) }).strict(),
  z.object({ action: z.literal("set_control"), channel: z.enum(channels), enabled: z.boolean(), eventId: z.string().trim().min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal("manual_message"), templateKey: z.enum(["event_reminder", "event_update", "event_cancellation", "admin_manual_message"]), customerId: z.string().trim().min(1).max(100), eventId: z.string().trim().min(1).max(100).optional(), subject: z.string().trim().min(2).max(120), message: z.string().trim().min(2).max(1000) }).strict(),
]);

export async function GET(request: Request) {
  try {
    await requireUser(["admin", "super_admin"]);
    const url = new URL(request.url);
    const clean = (name: string) => (url.searchParams.get(name) || "").trim().slice(0, 100) || undefined;
    return noStoreJson(await listNotifications({
      eventId: clean("eventId"), orderId: clean("orderId"), status: clean("status"), customer: clean("customer"), channel: clean("channel") as NotificationChannel | undefined,
    }));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["admin", "super_admin"]);
    const input = await parseJsonRequest(request, actionSchema, 8_192);
    if (input.action === "preview") {
      const preview = await previewTemplate(input.templateKey as NotificationTemplateKey, input.channel);
      return noStoreJson(!preview.channel || preview.channel === "email" ? { ...preview, attachments: preview.attachments.map(({ filename, contentId, contentType }) => ({ filename, contentId, contentType })) } : preview);
    }
    if (input.action === "resend_ticket") {
      const queued = await enqueueTicketNotificationsForOrder(input.orderId, "ticket_resend", actor.id);
      await auditNotificationAdminAction(actor, queued.queued.map((item) => item.id), "ticket_resend");
      return noStoreJson(queued, 201);
    }
    if (input.action === "bulk_resend_ticket") {
      const outboxIds: string[] = [];
      for (const orderId of [...new Set(input.orderIds)]) {
        const queued = await enqueueTicketNotificationsForOrder(orderId, "ticket_resend", actor.id);
        outboxIds.push(...queued.queued.map((item) => item.id));
      }
      await auditNotificationAdminAction(actor, outboxIds, "ticket_resend");
      return noStoreJson({ queued: outboxIds.length, orderCount: new Set(input.orderIds).size }, 201);
    }
    if (input.action === "bulk_retry") {
      const results: Array<{ notificationId: string; ok: boolean }> = [];
      for (const notificationId of [...new Set(input.notificationIds)]) {
        try { await manageNotification(actor, notificationId, "retry"); results.push({ notificationId, ok: true }); }
        catch { results.push({ notificationId, ok: false }); }
      }
      return noStoreJson({ results, completed: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length });
    }
    if (input.action === "retry" || input.action === "cancel") {
      return noStoreJson(await manageNotification(actor, input.notificationId, input.action));
    }
    if (input.action === "set_control") return noStoreJson(await setNotificationControl(actor, input.channel, input.enabled, input.eventId));
    if (input.action === "manual_message") {
      const contact = await getCustomerNotificationContact(input.customerId);
      const queued = await enqueueTransactionalNotifications({
        templateKey: input.templateKey, recipientUserId: contact.userId, recipientEmail: contact.email, recipientPhone: contact.phone,
        eventId: input.eventId, payload: { variables: { subject: input.subject, message: input.message, event_title: "SKIE EVENTS" }, requestedBy: actor.id, reason: "admin_manual" },
        idempotencyKey: `admin_manual:${actor.id}:${randomUUID()}`,
      });
      await auditNotificationAdminAction(actor, queued.queued.map((item) => item.id), "manual_message");
      return noStoreJson(queued, 201);
    }
    if (config.appMode === "live") throw new PublicApiError("LOCAL_TEST_SEND_ONLY", "Test sends are available only in local/test mode.", 409);
    if (input.channel === "whatsapp" && !config.whatsappNotificationsEnabled) throw new PublicApiError("NOTIFICATION_CHANNEL_DISABLED", "WhatsApp notifications are not enabled.", 409);
    if ((input.templateKey === "ticket_issued" || input.templateKey === "ticket_resend")) {
      if (!input.orderId) throw new PublicApiError("ORDER_REQUIRED", "Select a fulfilled order for a ticket test send.", 422);
      const queued = await enqueueTicketNotificationsForOrder(input.orderId, "ticket_resend", actor.id);
      await auditNotificationAdminAction(actor, queued.queued.map((item) => item.id), "test_send");
      return noStoreJson(queued, 201);
    }
    const queued = await enqueueNotification({
      channel: input.channel,
      templateKey: input.templateKey as NotificationTemplateKey,
      recipientAddress: input.channel === "in_app" ? actor.id : input.recipient,
      recipientUserId: input.channel === "in_app" ? actor.id : undefined,
      payload: {
        variables: { first_name: "Local", event_title: "SKIE Local Preview", order_reference: "LOCAL-PREVIEW", account_url: `${config.siteUrl}/account` },
        requestedBy: actor.id, reason: "local_test",
      },
      idempotencyKey: `local_test:${input.templateKey}:${randomUUID()}`,
    });
    await auditNotificationAdminAction(actor, [queued.item.id], "test_send");
    return noStoreJson(queued, 201);
  } catch (error) {
    return apiError(error);
  }
}
