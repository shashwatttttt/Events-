import { registerCustomer } from "@/lib/security/auth-service";
import { customerBookingLandingPath } from "@/lib/security/customer-landing";
import { setLocalSession } from "@/lib/security/session";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { queueMetaConversion } from "@/lib/meta/conversions";
import { readMetaRequestContext } from "@/lib/meta/request-context";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";
import { signupSchema } from "@/lib/validate";
import { setNotificationPreferences } from "@/lib/notifications/store";
import { sha256 } from "@/lib/security/crypto";

const SMS_CONSENT_TEXT = "Send me transactional SMS updates about applications, payments, tickets and event changes. Message rates may apply. I can turn this off in my account.";

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    await enforceRateLimit(requestKey(request, "auth-signup"), 8, 900000);
    const metaContext = readMetaRequestContext(request);
    const body = await parseJsonRequest(request, signupSchema, 8_192);
    await enforceRateLimit(requestKey(request, "auth-signup-account", body.email), 4, 900000);
    const result = await registerCustomer(body);
    await setNotificationPreferences(result.user.id, {
      email: true,
      in_app: true,
      sms: body.transactionalSmsConsent,
      whatsapp: false,
    }, {
      smsAccepted: body.transactionalSmsConsent,
      textShown: SMS_CONSENT_TEXT,
      policyVersion: "transactional-sms-v1",
      ipHash: sha256((request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim()),
      userAgent: request.headers.get("user-agent") || undefined,
    });
    if (metaContext.consentGranted) {
      await queueMetaConversion({
        metaEventId: `registration:${result.user.id}`,
        eventName: "CompleteRegistration",
        sourceEvent: "customer_registered",
        customerId: result.user.id,
        eventSourceUrl: metaContext.eventSourceUrl,
        fbp: metaContext.fbp,
        fbc: metaContext.fbc,
        safeMetadata: { emailConfirmationRequired: result.requiresEmailConfirmation },
      }).catch(() => undefined);
    }
    if (!result.requiresEmailConfirmation) await setLocalSession(result.user);
    return noStoreJson({
      user: result.user,
      requiresEmailConfirmation: result.requiresEmailConfirmation,
      redirect: result.requiresEmailConfirmation
        ? "/login?confirmed=pending"
        : await customerBookingLandingPath(),
    }, 201);
  } catch (error) { return apiError(error); }
}
