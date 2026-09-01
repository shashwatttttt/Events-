import { apiError, noStoreJson, PublicApiError } from "@/lib/http";
import { recordProviderCallback } from "@/lib/notifications/store";
import { mapTwilioDeliveryStatus, verifyTwilioSignature } from "@/lib/notifications/twilio";
import { sha256 } from "@/lib/security/crypto";

const TWILIO_CALLBACK_MAX_BYTES = 16_384;

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > TWILIO_CALLBACK_MAX_BYTES) {
      throw new PublicApiError("PAYLOAD_TOO_LARGE", "The callback was rejected.", 413);
    }
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/x-www-form-urlencoded") {
      throw new PublicApiError("UNSUPPORTED_MEDIA_TYPE", "The callback content type was rejected.", 415);
    }
    const payload = Buffer.from(await request.arrayBuffer());
    if (payload.byteLength > TWILIO_CALLBACK_MAX_BYTES) {
      throw new PublicApiError("PAYLOAD_TOO_LARGE", "The callback was rejected.", 413);
    }
    const form = new URLSearchParams(payload.toString("utf8"));
    const params: Record<string, string> = {};
    for (const [key, value] of form.entries()) params[key] = value.slice(0, 1000);
    const signatureUrl = process.env.TWILIO_STATUS_CALLBACK_URL?.trim() || request.url;
    if (!verifyTwilioSignature(signatureUrl, params, request.headers.get("x-twilio-signature"), process.env.TWILIO_AUTH_TOKEN)) {
      throw new PublicApiError("INVALID_PROVIDER_SIGNATURE", "The callback signature was rejected.", 401);
    }
    const messageSid = (params.MessageSid || params.SmsSid || "").trim();
    const providerStatus = (params.MessageStatus || params.SmsStatus || "").trim().toLowerCase();
    const mappedStatus = mapTwilioDeliveryStatus(providerStatus);
    if (!messageSid || !/^SM[a-zA-Z0-9]{20,64}$/.test(messageSid) || !mappedStatus) {
      throw new PublicApiError("INVALID_PROVIDER_CALLBACK", "The callback payload was rejected.", 422);
    }
    const providerEventId = sha256(`${messageSid}:${providerStatus}:${params.SequenceId || "0"}`);
    const result = await recordProviderCallback({ provider: "twilio", providerEventId, providerMessageId: messageSid, providerStatus, mappedStatus });
    return noStoreJson({ received: true, ...result });
  } catch (error) {
    return apiError(error);
  }
}
