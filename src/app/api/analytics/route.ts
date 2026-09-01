import { z } from "zod";
import { captureAnalyticsEvent } from "@/lib/analytics/store";
import { categorizeBrowser, categorizeDevice, sanitizeAnalyticsMetadata } from "@/lib/analytics/privacy";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";
import { sha256 } from "@/lib/security/crypto";
import { getCurrentUser } from "@/lib/security/session";

const schema = z.object({
  eventName: z.enum(["page_view","event_page_view","application_started","checkout_cancelled","promo_rejected","video_impression","video_started","video_completed"]),
  deduplicationKey: z.string().trim().min(6).max(200), anonymousSessionId: z.string().trim().min(16).max(100),
  eventId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,120}$/).optional(), ticketTypeId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,120}$/).optional(),
  utmSource: z.string().trim().max(100).optional(), utmMedium: z.string().trim().max(100).optional(), utmCampaign: z.string().trim().max(100).optional(),
  referrerCategory: z.enum(["direct","search","social","email","partner","internal","other"]).optional(), metadata: z.record(z.string(),z.unknown()).optional(),
}).strict();

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    await enforceRateLimit(requestKey(request,"analytics"),120,60_000);
    const input=await parseJsonRequest(request,schema,16_384); const user=await getCurrentUser(); const userAgent=request.headers.get("user-agent")||"";
    const result=await captureAnalyticsEvent({ eventName:input.eventName,source:"client",occurredAt:new Date().toISOString(),deduplicationKey:sha256(`client:${input.anonymousSessionId}:${input.eventName}:${input.deduplicationKey}`),anonymousSessionHash:sha256(`session:${input.anonymousSessionId}`),customerId:user?.id,eventId:input.eventId,ticketTypeId:input.ticketTypeId,utmSource:input.utmSource,utmMedium:input.utmMedium,utmCampaign:input.utmCampaign,referrerCategory:input.referrerCategory,deviceCategory:categorizeDevice(userAgent),browserFamily:categorizeBrowser(userAgent),safeMetadata:sanitizeAnalyticsMetadata(input.metadata) });
    return noStoreJson(result, result.inserted ? 201 : 200);
  } catch(error) { return apiError(error); }
}
