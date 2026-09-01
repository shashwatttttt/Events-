import { Resend } from "resend";
import { apiError, noStoreJson, PublicApiError } from "@/lib/http";
import { recordProviderCallback } from "@/lib/notifications/store";

function mapResendStatus(type: string) {
  if (type === "email.delivered") return "delivered" as const;
  if (["email.bounced", "email.complained", "email.failed", "email.suppressed"].includes(type)) return "failed" as const;
  if (["email.sent", "email.scheduled", "email.delivery_delayed", "email.opened", "email.clicked"].includes(type)) return "sent" as const;
  return null;
}

export async function POST(request: Request) {
  try {
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > 65_536) throw new PublicApiError("PAYLOAD_TOO_LARGE", "The callback was rejected.", 413);
    const payload = await request.text();
    if (Buffer.byteLength(payload) > 65_536) throw new PublicApiError("PAYLOAD_TOO_LARGE", "The callback was rejected.", 413);
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    const id = request.headers.get("svix-id") || "";
    const timestamp = request.headers.get("svix-timestamp") || "";
    const signature = request.headers.get("svix-signature") || "";
    if (!secret || !id || !timestamp || !signature) throw new PublicApiError("INVALID_PROVIDER_SIGNATURE", "The callback signature was rejected.", 401);
    let event: ReturnType<Resend["webhooks"]["verify"]>;
    try {
      event = new Resend(process.env.RESEND_API_KEY || "re_webhook_verification_only").webhooks.verify({ payload, headers: { id, timestamp, signature }, webhookSecret: secret });
    } catch {
      throw new PublicApiError("INVALID_PROVIDER_SIGNATURE", "The callback signature was rejected.", 401);
    }
    const mappedStatus = mapResendStatus(event.type);
    const providerMessageId = "data" in event && "email_id" in event.data ? String(event.data.email_id) : "";
    if (!mappedStatus || !providerMessageId) return noStoreJson({ received: true, ignored: true });
    const result = await recordProviderCallback({ provider: "resend", providerEventId: id, providerMessageId, providerStatus: event.type, mappedStatus });
    return noStoreJson({ received: true, ...result });
  } catch (error) { return apiError(error); }
}
