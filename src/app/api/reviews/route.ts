import { z } from "zod";
import { mutateSiteData } from "@/lib/data/documents";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";
import { randomId } from "@/lib/security/crypto";
import { getCurrentUser } from "@/lib/security/session";
import { verifyRecaptcha } from "@/lib/security/recaptcha";

const schema = z.object({
  name: z.string().trim().min(2).max(80),
  rating: z.number().int().min(1).max(5),
  body: z.string().trim().min(10).max(1000),
  eventId: z.string().max(100).optional(),
  recaptchaToken: z.string().max(4096).optional(),
}).strict();

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    const user = await getCurrentUser();
    await enforceRateLimit(requestKey(request, "reviews", user?.id), 6, 60_000);
    const value = await parseJsonRequest(request, schema, 4_096);
    await verifyRecaptcha(value.recaptchaToken, "review");
    const review = await mutateSiteData((site) => {
      const item = {
        id: randomId("review"), userId: user?.id, eventId: value.eventId, name: value.name,
        rating: value.rating, body: value.body, status: "pending" as const, featured: false,
        createdAt: new Date().toISOString(),
      };
      site.reviews.push(item);
      return item;
    });
    return noStoreJson({ review }, 201);
  } catch (error) {
    return apiError(error);
  }
}
