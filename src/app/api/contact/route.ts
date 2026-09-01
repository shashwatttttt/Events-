import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { mutateOperationsData } from "@/lib/data/documents";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";
import { randomId } from "@/lib/security/crypto";
import { contactSchema } from "@/lib/validate";
import { verifyRecaptcha } from "@/lib/security/recaptcha";

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    await enforceRateLimit(requestKey(request, "contact"), 6, 60_000);
    const value = await parseJsonRequest(request, contactSchema, 8_192);
    await enforceRateLimit(requestKey(request, "contact-account", value.email), 4, 60_000);
    await verifyRecaptcha(value.recaptchaToken, "contact");
    const { recaptchaToken: _, ...contactData } = value;
    void _;
    await mutateOperationsData((ops) => ops.contacts.push({
      id: randomId("contact"),
      ...contactData,
      status: "new",
      createdAt: new Date().toISOString(),
    }));
    return noStoreJson({ ok: true }, 201);
  } catch (error) {
    return apiError(error);
  }
}
