import { z } from "zod";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { mutateOperationsData } from "@/lib/data/documents";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";
import { randomId } from "@/lib/security/crypto";
import { emailSchema } from "@/lib/validate";
import { verifyRecaptcha } from "@/lib/security/recaptcha";

const schema = z.object({
  email: emailSchema,
  recaptchaToken: z.string().max(4096).optional(),
}).strict();

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    await enforceRateLimit(requestKey(request, "newsletter"), 8, 60_000);
    const { email, recaptchaToken } = await parseJsonRequest(request, schema, 2_048);
    await enforceRateLimit(requestKey(request, "newsletter-account", email), 3, 60_000);
    await verifyRecaptcha(recaptchaToken, "newsletter");
    await mutateOperationsData((ops) => {
      if (!ops.newsletter.some((item) => item.email === email)) {
        ops.newsletter.push({ id: randomId("news"), email, createdAt: new Date().toISOString() });
      }
    });
    return noStoreJson({ ok: true }, 201);
  } catch (error) {
    return apiError(error);
  }
}
