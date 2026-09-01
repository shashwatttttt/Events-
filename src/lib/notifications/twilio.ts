import { createHmac, timingSafeEqual } from "node:crypto";

export function twilioSignature(url: string, params: Record<string, string>, authToken: string) {
  const payload = Object.keys(params).sort().reduce((value, key) => `${value}${key}${params[key]}`, url);
  return createHmac("sha1", authToken).update(payload).digest("base64");
}

export function verifyTwilioSignature(url: string, params: Record<string, string>, supplied: string | null, authToken: string | undefined) {
  if (!supplied || !authToken) return false;
  const expected = Buffer.from(twilioSignature(url, params, authToken));
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function mapTwilioDeliveryStatus(status: string) {
  if (["delivered", "read"].includes(status)) return "delivered" as const;
  if (["failed", "undelivered"].includes(status)) return "failed" as const;
  if (["queued", "sending", "sent", "accepted", "scheduled"].includes(status)) return "sent" as const;
  return null;
}
