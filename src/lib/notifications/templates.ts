import "server-only";

import QRCode from "qrcode";
import { config } from "@/lib/config";
import { moneyCents } from "@/lib/format";
import type { NotificationTemplateKey, RenderedEmail, RenderedInAppNotification, RenderedTextNotification } from "@/lib/notifications/types";

export type TicketDeliveryModel = {
  customerName: string;
  eventTitle: string;
  eventDate: string;
  eventTime: string;
  eventLocation: string;
  purchaser: string;
  orderReference: string;
  accountUrl: string;
  refundPolicyUrl: string;
  entryPolicyUrl: string;
  tickets: Array<{ id: string; code: string; name: string; holderName: string; verificationUrl: string }>;
  products: Array<{ name: string; quantity: number; unitPriceCents: number }>;
};

function escapeHtml(value: string | number) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function layout(title: string, content: string, text: string): Pick<RenderedEmail, "html" | "text"> {
  const logoUrl = `${config.siteUrl}/email/skie-email-logo.jpeg`;
  return {
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head><body style="margin:0;background:#050505;color:#f7f7fb;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#050505"><tr><td style="padding:24px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;background:#0b0b0f;border:1px solid #292932;border-radius:20px;overflow:hidden"><tr><td style="padding:28px 32px;border-bottom:1px solid #292932"><img src="${escapeHtml(logoUrl)}" width="96" alt="SKIE EVENTS" style="display:block;max-width:96px;height:auto"><p style="margin:16px 0 0;color:#7890ff;font-size:12px;letter-spacing:.2em;font-weight:700">SKIE EVENTS / MELBOURNE</p></td></tr><tr><td style="padding:32px">${content}</td></tr><tr><td style="padding:24px 32px;border-top:1px solid #292932;color:#aaaab3;font-size:12px;line-height:1.6">Questions? Reply to ${escapeHtml(config.emailReplyTo)}.<br>This is an operational message about your SKIE event access.</td></tr></table></td></tr></table></body></html>`,
    text: `SKIE EVENTS / MELBOURNE\n\n${text}\n\nQuestions? Reply to ${config.emailReplyTo}.`,
  };
}

const genericCopy: Record<Exclude<NotificationTemplateKey, "ticket_issued" | "ticket_resend">, {
  subject: (variables: Record<string, string | number>) => string;
  heading: string;
  body: (variables: Record<string, string | number>) => string;
}> = {
  application_received: {
    subject: (v) => `We received your ${v.event_title || "SKIE event"} application`,
    heading: "APPLICATION RECEIVED",
    body: (v) => `Hi ${v.first_name || "there"}, your application for ${v.event_title || "the event"} is now under review.`,
  },
  ticket_unlocked: {
    subject: (v) => `Your ${v.event_title || "SKIE event"} allocation is unlocked`,
    heading: "ACCESS UNLOCKED",
    body: (v) => `Your allocation for ${v.event_title || "the event"} is ready. Purchase up to ${v.max_quantity || 1} ticket(s) before ${v.expires_at || "the displayed deadline"}.`,
  },
  waitlist: {
    subject: (v) => `Update on your ${v.event_title || "SKIE event"} application`,
    heading: "YOU ARE ON THE LIST",
    body: (v) => `Your application for ${v.event_title || "the event"} is currently on the waitlist. We will contact you if an allocation opens.`,
  },
  not_selected: {
    subject: (v) => `Update on your ${v.event_title || "SKIE event"} application`,
    heading: "APPLICATION UPDATE",
    body: (v) => `You were not selected for ${v.event_title || "this release"}. This decision applies only to this event.`,
  },
  payment_confirmed: {
    subject: (v) => `Payment confirmed for ${v.event_title || "your SKIE order"}`,
    heading: "PAYMENT CONFIRMED",
    body: (v) => `Payment for order ${v.order_reference || "your order"} has been verified. Your ticket delivery follows separately.`,
  },
  refund_invalidation: {
    subject: (v) => `Access update for ${v.event_title || "your SKIE event"}`,
    heading: "ACCESS INVALIDATED",
    body: (v) => `A refund or access change was recorded for order ${v.order_reference || "your order"}. Previously issued ticket QR codes for the affected access are no longer valid.`,
  },
  event_update: {
    subject: (v) => `Event update: ${v.event_title || "SKIE EVENTS"}`,
    heading: "EVENT UPDATE",
    body: (v) => String(v.message || "Event details have changed. Open your account for the latest information."),
  },
  event_cancellation: {
    subject: (v) => `${v.event_title || "SKIE event"} cancellation update`,
    heading: "EVENT CANCELLED",
    body: (v) => `${v.event_title || "The event"} has been cancelled. Follow the published refund information and contact support if you need help.`,
  },
  event_reminder: {
    subject: (v) => `Reminder: ${v.event_title || "your SKIE event"}`,
    heading: "EVENT REMINDER",
    body: (v) => `${v.event_title || "Your event"} is coming up. ${v.message || "Open your account for your tickets and the latest entry details."}`,
  },
  payment_reminder: {
    subject: (v) => `Complete your ${v.event_title || "SKIE event"} checkout`,
    heading: "ALLOCATION REMINDER",
    body: (v) => `Your ticket allocation is waiting. Complete checkout before ${v.expires_at || "the displayed deadline"}.`,
  },
  post_checkout_form_required: {
    subject: (v) => `Complete your mandatory ${v.event_title || "SKIE event"} application`,
    heading: "ONE FINAL STEP REQUIRED",
    body: (v) => `Hi ${v.first_name || "there"}, your payment is authorised but no ticket has been issued. Complete the mandatory application before ${v.expires_at || "the displayed deadline"}. Payment is completed only if SKIE approves the application.`,
  },
  post_checkout_form_reminder: {
    subject: (v) => `Your ${v.event_title || "SKIE event"} application is incomplete`,
    heading: "APPLICATION REQUIRED",
    body: (v) => `Your saved application is ${v.completion_percentage || 0}% complete. No ticket will be issued until the form is submitted and your application is approved. Complete it before ${v.expires_at || "the displayed deadline"}.`,
  },
  post_checkout_form_final_reminder: {
    subject: (v) => `Final reminder: complete your ${v.event_title || "SKIE event"} application`,
    heading: "FINAL FORM REMINDER",
    body: (v) => `Your payment authorisation and ticket reservation will be released if the mandatory application is not completed before ${v.expires_at || "the displayed deadline"}.`,
  },
  post_checkout_form_expired: {
    subject: (v) => `Your ${v.event_title || "SKIE event"} application deadline passed`,
    heading: "APPLICATION EXPIRED",
    body: (v) => `The mandatory application was not completed before ${v.expires_at || "the deadline"}. The temporary payment authorisation has been released, the ticket reservation has ended and no ticket was issued.`,
  },
  post_checkout_form_submitted: {
    subject: (v) => `Your ${v.event_title || "SKIE event"} application is under review`,
    heading: "APPLICATION SUBMITTED",
    body: (v) => `Your mandatory application has been received. Your payment remains authorised but has not yet been captured. We will notify you after the review.`,
  },
  post_checkout_approved: {
    subject: (v) => `You are approved for ${v.event_title || "your SKIE event"}`,
    heading: "APPROVED",
    body: (v) => `Your application has been approved and payment for order ${v.order_reference || "your order"} has been completed. Your tickets are being issued to your account.`,
  },
  post_checkout_rejected: {
    subject: (v) => `Update on your ${v.event_title || "SKIE event"} application`,
    heading: "APPLICATION NOT APPROVED",
    body: (v) => `Your application was not approved. The payment authorisation has been released and no ticket was issued. Your bank may take additional time to remove the pending entry.`,
  },
  post_checkout_authorisation_expired: {
    subject: (v) => `Your ${v.event_title || "SKIE event"} payment authorisation expired`,
    heading: "AUTHORISATION EXPIRED",
    body: (v) => `The temporary payment authorisation expired before approval. No ticket was issued and the reservation has been released.`,
  },
  post_checkout_reauthorisation_required: {
    subject: (v) => `Payment authorisation required for ${v.event_title || "your SKIE event"}`,
    heading: "REAUTHORISATION REQUIRED",
    body: (v) => `Your previous payment authorisation can no longer be captured. Open your account to restart checkout before access can be approved.`,
  },
  admin_manual_message: {
    subject: (v) => String(v.subject || `Message about ${v.event_title || "SKIE EVENTS"}`),
    heading: "SKIE EVENTS UPDATE",
    body: (v) => String(v.message || "Open your account for the latest information."),
  },
};

export function renderGenericEmail(
  templateKey: Exclude<NotificationTemplateKey, "ticket_issued" | "ticket_resend">,
  variables: Record<string, string | number>,
): RenderedEmail {
  const copy = genericCopy[templateKey];
  const body = copy.body(variables);
  const accountUrl = typeof variables.account_url === "string" ? variables.account_url : `${config.siteUrl}/account`;
  const content = `<p style="margin:0 0 12px;color:#7890ff;font-size:12px;letter-spacing:.16em;font-weight:700">${escapeHtml(copy.heading)}</p><h1 style="margin:0 0 20px;font-size:34px;line-height:1.05">${escapeHtml(copy.subject(variables))}</h1><p style="margin:0;color:#d7d7dd;font-size:16px;line-height:1.7">${escapeHtml(body)}</p><p style="margin:28px 0 0"><a href="${escapeHtml(accountUrl)}" style="display:inline-block;background:#5170ff;color:#fff;text-decoration:none;padding:13px 18px;border-radius:999px;font-weight:700">Open your SKIE account</a></p>`;
  return { subject: copy.subject(variables), ...layout(copy.heading, content, `${copy.heading}\n\n${body}\n\nAccount: ${accountUrl}`), attachments: [] };
}

export function renderTextNotification(
  templateKey: NotificationTemplateKey,
  variables: Record<string, string | number>,
): RenderedTextNotification {
  if (templateKey === "ticket_issued" || templateKey === "ticket_resend") {
    return { text: `SKIE EVENTS: Your ticket${templateKey === "ticket_resend" ? " resend" : "s"} are ready. Open ${config.siteUrl}/account. Do not share QR codes.` };
  }
  const copy = genericCopy[templateKey];
  return { text: `SKIE EVENTS: ${copy.body(variables)} ${config.siteUrl}/account`.slice(0, 1500) };
}

export function renderInAppNotification(
  templateKey: NotificationTemplateKey,
  variables: Record<string, string | number>,
): RenderedInAppNotification {
  if (templateKey === "ticket_issued" || templateKey === "ticket_resend") {
    return { title: templateKey === "ticket_resend" ? "Tickets resent" : "Tickets issued", body: "Your tickets are ready in your account.", href: "/account" };
  }
  const copy = genericCopy[templateKey];
  return { title: copy.heading, body: copy.body(variables), href: "/account" };
}

export async function renderTicketEmail(
  templateKey: "ticket_issued" | "ticket_resend",
  model: TicketDeliveryModel,
): Promise<RenderedEmail> {
  const attachments = await Promise.all(model.tickets.map(async (ticket, index) => ({
    filename: `skie-ticket-${index + 1}.png`,
    content: await QRCode.toBuffer(ticket.verificationUrl, { type: "png", width: 360, margin: 2, errorCorrectionLevel: "M" }),
    contentType: "image/png",
    contentId: `ticket-qr-${ticket.id}`,
  })));
  const ticketRows = model.tickets.map((ticket, index) => `<section style="margin:22px 0;padding:22px;background:#111117;border:1px solid #292932;border-radius:16px;text-align:center"><p style="margin:0 0 8px;color:#7890ff;font-size:12px;letter-spacing:.14em">TICKET ${index + 1} OF ${model.tickets.length}</p><h2 style="margin:0 0 6px">${escapeHtml(ticket.name)}</h2><p style="margin:0 0 18px;color:#b7b7c0">${escapeHtml(ticket.holderName)} · ${escapeHtml(ticket.code)}</p><img src="cid:${escapeHtml(`ticket-qr-${ticket.id}`)}" width="280" height="280" alt="QR code for ${escapeHtml(ticket.code)}" style="display:block;width:100%;max-width:280px;height:auto;margin:0 auto;background:#fff;border-radius:12px"></section>`).join("");
  const productRows = model.products.length
    ? `<h2 style="margin:30px 0 10px">Purchased add-ons</h2><ul style="margin:0;padding-left:20px;color:#d7d7dd;line-height:1.7">${model.products.map((item) => `<li>${escapeHtml(item.quantity)} × ${escapeHtml(item.name)} (${escapeHtml(moneyCents(item.quantity * item.unitPriceCents))})</li>`).join("")}</ul>`
    : "";
  const heading = templateKey === "ticket_resend" ? "YOUR TICKETS / RESENT" : "YOU ARE IN";
  const subject = `${templateKey === "ticket_resend" ? "Your resent" : "Your"} ${model.eventTitle} ticket${model.tickets.length === 1 ? "" : "s"}`;
  const content = `<p style="margin:0 0 12px;color:#7890ff;font-size:12px;letter-spacing:.16em;font-weight:700">${escapeHtml(heading)}</p><h1 style="margin:0 0 20px;font-size:34px;line-height:1.05">${escapeHtml(model.eventTitle)}</h1><dl style="margin:0;color:#d7d7dd;line-height:1.7"><dt style="color:#888894">Date / time</dt><dd style="margin:0 0 8px">${escapeHtml(model.eventDate)} · ${escapeHtml(model.eventTime)}</dd><dt style="color:#888894">Location</dt><dd style="margin:0 0 8px">${escapeHtml(model.eventLocation)}</dd><dt style="color:#888894">Purchaser / order</dt><dd style="margin:0">${escapeHtml(model.purchaser)} · ${escapeHtml(model.orderReference)}</dd></dl>${ticketRows}${productRows}<p style="margin:28px 0 12px"><a href="${escapeHtml(model.accountUrl)}" style="display:inline-block;background:#5170ff;color:#fff;text-decoration:none;padding:13px 18px;border-radius:999px;font-weight:700">Open tickets in your account</a></p><p style="color:#aaaab3;line-height:1.6">Bring valid photo ID. Each QR admits one ticket and may be used once. Do not share ticket QR codes.</p><p style="font-size:13px"><a style="color:#9eb0ff" href="${escapeHtml(model.entryPolicyUrl)}">Entry policy</a> · <a style="color:#9eb0ff" href="${escapeHtml(model.refundPolicyUrl)}">Refund policy</a></p>`;
  const ticketText = model.tickets.map((ticket, index) => `Ticket ${index + 1}: ${ticket.name} — ${ticket.holderName} — ${ticket.code}`).join("\n");
  const productsText = model.products.length ? `\n\nAdd-ons:\n${model.products.map((item) => `${item.quantity} x ${item.name}`).join("\n")}` : "";
  const text = `${heading}\n\n${model.eventTitle}\n${model.eventDate} · ${model.eventTime}\n${model.eventLocation}\nPurchaser: ${model.purchaser}\nOrder: ${model.orderReference}\n\n${ticketText}${productsText}\n\nOpen tickets: ${model.accountUrl}\nEntry: ${model.entryPolicyUrl}\nRefunds: ${model.refundPolicyUrl}\n\nBring valid photo ID. Do not share QR codes.`;
  return { subject, ...layout(heading, content, text), attachments };
}
