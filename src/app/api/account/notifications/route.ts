import { z } from "zod";
import { apiError, assertRequestOrigin, noStoreJson, parseJsonRequest } from "@/lib/http";
import { getNotificationSettings, listInAppNotifications, setNotificationPreferences } from "@/lib/notifications/store";
import { sha256 } from "@/lib/security/crypto";
import { requireUser } from "@/lib/security/session";

const schema = z.object({ email: z.boolean(), sms: z.boolean(), in_app: z.boolean(), whatsapp: z.boolean().default(false) }).strict();
const SMS_CONSENT_TEXT = "Send me transactional SMS updates about applications, payments, tickets and event changes. Message rates may apply. I can turn this off in my account.";

function present(settings: Awaited<ReturnType<typeof getNotificationSettings>>) {
  const preferences = Object.fromEntries(settings.preferences.map((item) => [item.channel, item.enabled]));
  return {
    preferences: { email: preferences.email ?? true, sms: preferences.sms ?? false, in_app: preferences.in_app ?? true, whatsapp: preferences.whatsapp ?? false },
    smsConsent: settings.consents.find((item) => item.channel === "sms")?.accepted ?? false,
  };
}

export async function GET() {
  try {
    const user = await requireUser();
    const [settings, notifications] = await Promise.all([getNotificationSettings(user.id), listInAppNotifications(user.id)]);
    return noStoreJson({ ...present(settings), notifications });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    assertRequestOrigin(request);
    const user = await requireUser();
    const input = await parseJsonRequest(request, schema, 4_096);
    const current = await getNotificationSettings(user.id);
    const currentSms = current.consents.find((item) => item.channel === "sms")?.accepted ?? false;
    const settings = await setNotificationPreferences(user.id, input, currentSms === input.sms ? undefined : {
      smsAccepted: input.sms,
      textShown: SMS_CONSENT_TEXT,
      policyVersion: "transactional-sms-v1",
      ipHash: sha256((request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim()),
      userAgent: request.headers.get("user-agent") || undefined,
    });
    return noStoreJson(present(settings));
  } catch (error) { return apiError(error); }
}
