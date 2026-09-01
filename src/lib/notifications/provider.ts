import "server-only";

import { Resend } from "resend";
import { config } from "@/lib/config";
import type { EmailProvider, EmailProviderResult, TextProvider, NotificationProviderResult } from "@/lib/notifications/types";

export class LocalEmailProvider implements EmailProvider {
  readonly name = "local" as const;

  async send(): Promise<EmailProviderResult> {
    return { status: "dry_run", providerMessageId: `local_${crypto.randomUUID()}` };
  }
}

export class DisabledEmailProvider implements EmailProvider {
  readonly name = "local" as const;

  async send(): Promise<EmailProviderResult> {
    return { status: "permanent_failure", safeErrorCode: "EMAIL_PROVIDER_CONFIGURATION" };
  }
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend" as const;

  async send(input: Parameters<EmailProvider["send"]>[0]): Promise<EmailProviderResult> {
    const key = process.env.RESEND_API_KEY;
    if (!key) return { status: "permanent_failure", safeErrorCode: "EMAIL_PROVIDER_CONFIGURATION" };
    try {
      const { data, error } = await new Resend(key).emails.send({
        from: input.from,
        replyTo: input.replyTo,
        to: input.to,
        subject: input.message.subject,
        html: input.message.html,
        text: input.message.text,
        attachments: input.message.attachments.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          contentId: attachment.contentId,
          contentType: attachment.contentType,
        })),
      }, {
        idempotencyKey: input.idempotencyKey,
      });
      if (error) {
        const statusCode = "statusCode" in error ? Number(error.statusCode) : 0;
        const errorName = "name" in error ? String(error.name) : "";
        return statusCode === 429 || statusCode >= 500 || errorName === "concurrent_idempotent_requests"
          ? { status: "temporary_failure", safeErrorCode: "EMAIL_PROVIDER_TEMPORARY" }
          : { status: "permanent_failure", safeErrorCode: "EMAIL_PROVIDER_REJECTED" };
      }
      return { status: "accepted", providerMessageId: data?.id };
    } catch {
      return { status: "temporary_failure", safeErrorCode: "EMAIL_PROVIDER_UNAVAILABLE" };
    }
  }
}

export function configuredEmailProvider(): EmailProvider {
  if (config.appMode === "live") {
    return config.emailProvider === "resend"
      ? new ResendEmailProvider()
      : new DisabledEmailProvider();
  }
  return new LocalEmailProvider();
}

export class LocalTextProvider implements TextProvider {
  readonly name = "local" as const;

  async send(): Promise<NotificationProviderResult> {
    return { status: "dry_run", providerMessageId: `local_${crypto.randomUUID()}` };
  }
}

export class DisabledTextProvider implements TextProvider {
  readonly name = "disabled" as const;

  async send(): Promise<NotificationProviderResult> {
    return { status: "permanent_failure", safeErrorCode: "NOTIFICATION_CHANNEL_DISABLED" };
  }
}

export class TwilioTextProvider implements TextProvider {
  readonly name = "twilio" as const;

  async send(input: Parameters<TextProvider["send"]>[0]): Promise<NotificationProviderResult> {
    const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
    const configuredFrom = input.channel === "whatsapp"
      ? process.env.TWILIO_WHATSAPP_FROM?.trim()
      : process.env.TWILIO_FROM_NUMBER?.trim();
    if (!accountSid || !authToken || (!messagingServiceSid && !configuredFrom)) {
      return { status: "permanent_failure", safeErrorCode: "SMS_PROVIDER_CONFIGURATION" };
    }
    const form = new URLSearchParams({ To: input.channel === "whatsapp" ? `whatsapp:${input.to}` : input.to, Body: input.message.text });
    if (messagingServiceSid) form.set("MessagingServiceSid", messagingServiceSid);
    else form.set("From", input.channel === "whatsapp" && configuredFrom && !configuredFrom.startsWith("whatsapp:") ? `whatsapp:${configuredFrom}` : configuredFrom!);
    if (config.twilioStatusCallbackUrl) form.set("StatusCallback", config.twilioStatusCallbackUrl);
    try {
      const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        return response.status === 408 || response.status === 429 || response.status >= 500
          ? { status: "temporary_failure", safeErrorCode: "SMS_PROVIDER_TEMPORARY" }
          : { status: "permanent_failure", safeErrorCode: "SMS_PROVIDER_REJECTED" };
      }
      const body = await response.json() as { sid?: string };
      return body.sid
        ? { status: "accepted", providerMessageId: body.sid.slice(0, 200) }
        : { status: "temporary_failure", safeErrorCode: "SMS_PROVIDER_INVALID_RESPONSE" };
    } catch {
      // Twilio's Messages API does not provide a documented idempotent-send key.
      // A timeout can therefore mean that the message was accepted but the response
      // was lost. Stop automatic retries and require an operator to reconcile it.
      return { status: "permanent_failure", safeErrorCode: "SMS_PROVIDER_OUTCOME_UNKNOWN" };
    }
  }
}

export function configuredTextProvider(channel: "sms" | "whatsapp"): TextProvider {
  if (channel === "whatsapp" && !config.whatsappNotificationsEnabled) return new DisabledTextProvider();
  if (config.appMode === "live") {
    return config.smsProvider === "twilio"
      ? new TwilioTextProvider()
      : new DisabledTextProvider();
  }
  return new LocalTextProvider();
}
