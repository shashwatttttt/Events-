import "server-only";

import { config } from "@/lib/config";
import { readOperationsData, readSiteData } from "@/lib/data/documents";
import { formatEventDate } from "@/lib/format";
import { renderGenericEmail, renderInAppNotification, renderTextNotification, renderTicketEmail, type TicketDeliveryModel } from "@/lib/notifications/templates";
import type { NotificationPreview, NotificationTemplateKey, RenderedEmail } from "@/lib/notifications/types";
import { enqueueEmail, enqueueNotification, getNotificationSettings } from "@/lib/notifications/store";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createTicketUrl } from "@/lib/tickets/security";
import type { NotificationChannel, NotificationOutboxItem, NotificationPayload } from "@/types/site";

const ticketTemplateKeys = new Set(["ticket_issued", "ticket_resend"]);

export async function getCustomerNotificationContact(userId: string) {
  if (config.dataProvider === "supabase") {
    const { data, error } = await createSupabaseAdminClient().from("profiles").select("id,email,phone").eq("id", userId).maybeSingle();
    if (error || !data?.email) throw new Error("NOTIFICATION_CUSTOMER_UNAVAILABLE");
    return { userId: String(data.id), email: String(data.email), phone: String(data.phone || "") };
  }
  const customer = (await readOperationsData()).users.find((item) => item.id === userId);
  if (!customer) throw new Error("NOTIFICATION_CUSTOMER_UNAVAILABLE");
  return { userId: customer.id, email: customer.email, phone: customer.phone };
}

type TicketDelivery = { model: TicketDeliveryModel; recipient: string; phone: string; userId: string; eventId: string };

async function localTicketDelivery(orderId: string): Promise<TicketDelivery> {
  const [site, operations] = await Promise.all([readSiteData(), readOperationsData()]);
  const order = operations.orders.find((item) => item.id === orderId);
  if (!order || !["paid", "fulfilled", "partially_refunded", "disputed", "suspended"].includes(order.status)) throw new Error("NOTIFICATION_ORDER_NOT_FULFILLED");
  const reservation = operations.reservations.find((item) => item.id === order.reservationId);
  const event = site.events.find((item) => item.id === order.eventId);
  const customer = operations.users.find((item) => item.id === order.userId);
  if (!reservation || !event) throw new Error("NOTIFICATION_ORDER_INCOMPLETE");
  const tickets = operations.tickets.filter((ticket) => ticket.orderId === order.id && ticket.status === "valid");
  if (!tickets.length) throw new Error("NOTIFICATION_NO_VALID_TICKETS");
  return {
    recipient: reservation.customerEmail,
    phone: customer?.phone || "",
    userId: order.userId,
    eventId: order.eventId,
    model: {
      customerName: reservation.customerName,
      eventTitle: event.title,
      eventDate: formatEventDate(event.date),
      eventTime: event.time,
      eventLocation: `${event.venue}, ${event.location}`,
      purchaser: `${customer?.firstName || reservation.customerName} ${customer?.lastName || ""}`.trim(),
      orderReference: order.id,
      accountUrl: `${config.siteUrl}/account`,
      refundPolicyUrl: `${config.siteUrl}/refund-policy`,
      entryPolicyUrl: `${config.siteUrl}/entry-policy`,
      tickets: tickets.map((ticket) => ({
        id: ticket.id,
        code: ticket.ticketCode,
        name: event.ticketTypes.find((type) => type.id === ticket.ticketTypeId)?.name || "Admission",
        holderName: ticket.holderName,
        verificationUrl: createTicketUrl(ticket),
      })),
      products: order.items.filter((item) => item.kind === "product").map((item) => ({
        name: item.name, quantity: item.quantity, unitPriceCents: item.unitPriceCents,
      })),
    },
  };
}

async function normalizedTicketDelivery(orderId: string): Promise<TicketDelivery> {
  const client = createSupabaseAdminClient();
  const [site, orderResult, ticketResult, lineResult] = await Promise.all([
    readSiteData(),
    client.from("orders").select("id,event_id,customer_id,status,reservations(customer_email,customer_name,event_title)").eq("id", orderId).maybeSingle(),
    client.from("tickets").select("id,event_id,customer_id,ticket_type_id,ticket_code,holder_name,status").eq("order_id", orderId).eq("status", "valid").order("created_at"),
    client.from("order_lines").select("kind,reference_id,name,quantity,unit_price_cents").eq("order_id", orderId).order("created_at"),
  ]);
  if (orderResult.error || ticketResult.error || lineResult.error || !orderResult.data) throw new Error("NOTIFICATION_ORDER_UNAVAILABLE");
  const order = orderResult.data;
  if (!["fulfilled", "partially_refunded", "disputed", "suspended"].includes(String(order.status))) throw new Error("NOTIFICATION_ORDER_NOT_FULFILLED");
  const joinedReservation = Array.isArray(order.reservations) ? order.reservations[0] : order.reservations;
  const reservation = joinedReservation as { customer_email?: string; customer_name?: string; event_title?: string } | null;
  const event = site.events.find((item) => item.id === String(order.event_id));
  if (!reservation?.customer_email || !event || !ticketResult.data?.length) throw new Error("NOTIFICATION_NO_VALID_TICKETS");
  const purchaser = String(reservation.customer_name || "Customer");
  const { data: profile } = await client.from("profiles").select("phone").eq("id", String(order.customer_id)).maybeSingle();
  return {
    recipient: reservation.customer_email,
    phone: String(profile?.phone || ""),
    userId: String(order.customer_id),
    eventId: String(order.event_id),
    model: {
      customerName: purchaser,
      eventTitle: event.title,
      eventDate: formatEventDate(event.date),
      eventTime: event.time,
      eventLocation: `${event.venue}, ${event.location}`,
      purchaser,
      orderReference: String(order.id),
      accountUrl: `${config.siteUrl}/account`,
      refundPolicyUrl: `${config.siteUrl}/refund-policy`,
      entryPolicyUrl: `${config.siteUrl}/entry-policy`,
      tickets: ticketResult.data.map((ticket) => ({
        id: String(ticket.id),
        code: String(ticket.ticket_code),
        name: event.ticketTypes.find((type) => type.id === String(ticket.ticket_type_id))?.name || "Admission",
        holderName: String(ticket.holder_name),
        verificationUrl: createTicketUrl({ id: String(ticket.id), eventId: String(ticket.event_id), userId: String(ticket.customer_id) }),
      })),
      products: (lineResult.data || []).filter((line) => line.kind === "product").map((line) => ({
        name: String(line.name), quantity: Number(line.quantity), unitPriceCents: Number(line.unit_price_cents),
      })),
    },
  };
}

export async function getTicketDelivery(orderId: string) {
  return config.dataProvider === "supabase" ? normalizedTicketDelivery(orderId) : localTicketDelivery(orderId);
}

export async function enqueueTicketEmailForOrder(
  orderId: string,
  templateKey: "ticket_issued" | "ticket_resend" = "ticket_issued",
  requestedBy?: string,
) {
  const delivery = await getTicketDelivery(orderId);
  const suffix = templateKey === "ticket_resend" ? `:${crypto.randomUUID()}` : "";
  return enqueueEmail({
    templateKey,
    recipientAddress: delivery.recipient,
    recipientUserId: delivery.userId,
    eventId: delivery.eventId,
    orderId,
    payload: { orderId, requestedBy, reason: templateKey === "ticket_resend" ? "ticket_resend" : "workflow" },
    idempotencyKey: `${templateKey}:${orderId}${suffix}`,
  });
}

export type TransactionalNotificationInput = {
  templateKey: NotificationTemplateKey;
  recipientUserId: string;
  recipientEmail: string;
  recipientPhone?: string;
  eventId?: string;
  orderId?: string;
  payload?: NotificationPayload;
  idempotencyKey: string;
  channels?: NotificationChannel[];
};

export async function enqueueTransactionalNotifications(input: TransactionalNotificationInput) {
  const settings = await getNotificationSettings(input.recipientUserId, input.eventId);
  const preferred = new Map(settings.preferences.map((item) => [item.channel, item.enabled]));
  const globallyEnabled = new Map(settings.globalControls.map((item) => [item.channel, item.enabled]));
  const eventEnabled = new Map(settings.eventControls.map((item) => [item.channel, item.enabled]));
  const latestSmsConsent = settings.consents.find((item) => item.channel === "sms");
  const candidates = input.channels || (["email", "sms", "in_app", "whatsapp"] as NotificationChannel[]);
  const queued: Array<{ channel: NotificationChannel; id: string; duplicate: boolean }> = [];
  const skipped: Array<{ channel: NotificationChannel; reason: string }> = [];
  for (const channel of candidates) {
    const defaultPreference = channel === "email" || channel === "in_app";
    if (!(globallyEnabled.get(channel) ?? (channel !== "whatsapp")) || eventEnabled.get(channel) === false) {
      skipped.push({ channel, reason: "disabled" }); continue;
    }
    if (!(preferred.get(channel) ?? defaultPreference)) { skipped.push({ channel, reason: "preference" }); continue; }
    if ((channel === "sms" || channel === "whatsapp") && (!latestSmsConsent?.accepted || !input.recipientPhone)) {
      skipped.push({ channel, reason: "consent_or_phone" }); continue;
    }
    if (channel === "whatsapp" && !config.whatsappNotificationsEnabled) { skipped.push({ channel, reason: "feature_flag" }); continue; }
    const result = await enqueueNotification({
      channel,
      templateKey: input.templateKey,
      recipientAddress: channel === "email" ? input.recipientEmail : channel === "in_app" ? input.recipientUserId : input.recipientPhone!,
      recipientUserId: input.recipientUserId,
      eventId: input.eventId,
      orderId: input.orderId,
      payload: input.payload || {},
      idempotencyKey: `${input.idempotencyKey}:${channel}`,
    });
    queued.push({ channel, id: result.item.id, duplicate: result.duplicate });
  }
  return { queued, skipped };
}

export async function enqueueTicketNotificationsForOrder(
  orderId: string,
  templateKey: "ticket_issued" | "ticket_resend" = "ticket_issued",
  requestedBy?: string,
) {
  const delivery = await getTicketDelivery(orderId);
  const suffix = templateKey === "ticket_resend" ? `:${crypto.randomUUID()}` : "";
  return enqueueTransactionalNotifications({
    templateKey, recipientUserId: delivery.userId, recipientEmail: delivery.recipient, recipientPhone: delivery.phone,
    eventId: delivery.eventId, orderId,
    payload: { orderId, requestedBy, reason: templateKey === "ticket_resend" ? "ticket_resend" : "workflow" },
    idempotencyKey: `${templateKey}:${orderId}${suffix}`,
  });
}

export async function enqueueOrderFulfilmentNotifications(orderId: string) {
  const delivery = await getTicketDelivery(orderId);
  const common = {
    recipientUserId: delivery.userId,
    recipientEmail: delivery.recipient,
    recipientPhone: delivery.phone,
    eventId: delivery.eventId,
    orderId,
  };
  const [payment, tickets] = await Promise.allSettled([
    enqueueTransactionalNotifications({ ...common, templateKey: "payment_confirmed", payload: { variables: { event_title: delivery.model.eventTitle, order_reference: orderId }, orderId, reason: "workflow" }, idempotencyKey: `payment_confirmed:${orderId}` }),
    enqueueTransactionalNotifications({ ...common, templateKey: "ticket_issued", payload: { orderId, reason: "workflow" }, idempotencyKey: `ticket_issued:${orderId}` }),
  ]);
  if (payment.status === "rejected" || tickets.status === "rejected") throw new Error("NOTIFICATION_ENQUEUE_FAILED");
  return { payment, tickets };
}

export async function renderOutboxEmail(item: NotificationOutboxItem): Promise<RenderedEmail> {
  if (ticketTemplateKeys.has(item.templateKey)) {
    const orderId = item.orderId || item.payload.orderId;
    if (!orderId) throw new Error("NOTIFICATION_ORDER_REQUIRED");
    const delivery = await getTicketDelivery(orderId);
    return renderTicketEmail(item.templateKey as "ticket_issued" | "ticket_resend", delivery.model);
  }
  return renderGenericEmail(item.templateKey as Exclude<NotificationTemplateKey, "ticket_issued" | "ticket_resend">, item.payload.variables || {});
}

export async function renderOutboxNotification(item: NotificationOutboxItem): Promise<NotificationPreview> {
  if (item.channel === "email") return { channel: "email", ...await renderOutboxEmail(item) };
  const variables = item.payload.variables || {};
  if (item.channel === "in_app") return { channel: "in_app", ...renderInAppNotification(item.templateKey as NotificationTemplateKey, variables) };
  return { channel: item.channel, ...renderTextNotification(item.templateKey as NotificationTemplateKey, variables) };
}

export function previewTemplate(templateKey: NotificationTemplateKey, channel: NotificationChannel = "email"): Promise<NotificationPreview> | NotificationPreview {
  if (channel === "sms" || channel === "whatsapp") return { channel, ...renderTextNotification(templateKey, {
    first_name: "Test", event_title: "SKIE Local Preview", max_quantity: 2, expires_at: "31 October 2026, 8:30 PM", message: "Doors now open at 8:30 PM.",
  }) };
  if (channel === "in_app") return { channel, ...renderInAppNotification(templateKey, {
    first_name: "Test", event_title: "SKIE Local Preview", max_quantity: 2, expires_at: "31 October 2026, 8:30 PM", message: "Doors now open at 8:30 PM.",
  }) };
  if (ticketTemplateKeys.has(templateKey)) {
    return renderTicketEmail(templateKey as "ticket_issued" | "ticket_resend", {
      customerName: "Test Customer", eventTitle: "SKIE Local Preview", eventDate: "31 October 2026",
      eventTime: "8:30 PM — LATE", eventLocation: "Private venue, Melbourne VIC", purchaser: "Test Customer",
      orderReference: "LOCAL-PREVIEW", accountUrl: `${config.siteUrl}/account`,
      refundPolicyUrl: `${config.siteUrl}/refund-policy`, entryPolicyUrl: `${config.siteUrl}/entry-policy`,
      tickets: [
        { id: "preview-ticket-1", code: "SKIE-PREVIEW-0001", name: "First Release", holderName: "Test Customer", verificationUrl: `${config.siteUrl}/ticket/verify?ticket=preview&token=local-preview` },
        { id: "preview-ticket-2", code: "SKIE-PREVIEW-0002", name: "First Release", holderName: "Guest", verificationUrl: `${config.siteUrl}/ticket/verify?ticket=preview2&token=local-preview2` },
      ],
      products: [{ name: "3 Drink Pass", quantity: 1, unitPriceCents: 4500 }],
    }).then((message) => ({ channel: "email" as const, ...message }));
  }
  return { channel: "email", ...renderGenericEmail(templateKey as Exclude<NotificationTemplateKey, "ticket_issued" | "ticket_resend">, {
    first_name: "Test", event_title: "SKIE Local Preview", max_quantity: 2,
    expires_at: "31 October 2026, 8:30 PM", order_reference: "LOCAL-PREVIEW",
    account_url: `${config.siteUrl}/account`, message: "Doors now open at 8:30 PM. Check your account for details.",
  }) };
}
