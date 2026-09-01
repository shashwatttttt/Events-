import type { NotificationChannel, NotificationOutboxItem } from "@/types/site";

export type NotificationTemplateKey =
  | "application_received"
  | "ticket_unlocked"
  | "waitlist"
  | "not_selected"
  | "payment_confirmed"
  | "ticket_issued"
  | "ticket_resend"
  | "refund_invalidation"
  | "event_update"
  | "event_cancellation"
  | "event_reminder"
  | "payment_reminder"
  | "post_checkout_form_required"
  | "post_checkout_form_reminder"
  | "post_checkout_form_final_reminder"
  | "post_checkout_form_submitted"
  | "post_checkout_form_expired"
  | "post_checkout_approved"
  | "post_checkout_rejected"
  | "post_checkout_authorisation_expired"
  | "post_checkout_reauthorisation_required"
  | "admin_manual_message";

export type NotificationAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
  contentId: string;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
  attachments: NotificationAttachment[];
};

export type RenderedTextNotification = {
  text: string;
};

export type RenderedInAppNotification = {
  title: string;
  body: string;
  href: string;
};

export type NotificationProviderResult =
  | { status: "accepted" | "sent" | "delivered" | "dry_run"; providerMessageId?: string }
  | { status: "temporary_failure" | "permanent_failure"; safeErrorCode: string };

export type EmailProviderResult = NotificationProviderResult;

export interface EmailProvider {
  readonly name: "local" | "resend";
  send(input: {
    from: string;
    replyTo: string;
    to: string;
    message: RenderedEmail;
    idempotencyKey: string;
  }): Promise<EmailProviderResult>;
}

export interface TextProvider {
  readonly name: "local" | "twilio" | "disabled";
  send(input: {
    channel: "sms" | "whatsapp";
    to: string;
    message: RenderedTextNotification;
    idempotencyKey: string;
  }): Promise<NotificationProviderResult>;
}

export type NotificationPreview =
  | ({ channel: "email" } & RenderedEmail)
  | ({ channel: "sms" | "whatsapp" } & RenderedTextNotification)
  | ({ channel: "in_app" } & RenderedInAppNotification);

export const notificationChannels = ["email", "sms", "in_app", "whatsapp"] as const satisfies readonly NotificationChannel[];

export type ClaimedNotification = NotificationOutboxItem;
