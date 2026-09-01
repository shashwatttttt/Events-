import { z } from "zod";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest, PublicApiError } from "@/lib/http";
import { readSiteData } from "@/lib/data/documents";
import { eventPasswordMatches, grantEventPasswordAccess } from "@/lib/event-access";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";

const schema = z.object({ slug: z.string().min(1).max(100), password: z.string().min(1).max(200) }).strict();

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    await enforceRateLimit(requestKey(request, "event-password"), 10, 15 * 60_000);
    const body = await parseJsonRequest(request, schema, 2_048);
    await enforceRateLimit(requestKey(request, "event-password-event", body.slug), 10, 15 * 60_000);
    const site = await readSiteData();
    const event = site.events.find((item) => item.slug === body.slug && item.visibility === "password");
    if (!event || !eventPasswordMatches(event, body.password)) throw new PublicApiError("EVENT_ACCESS_DENIED", "Incorrect event password.", 401);
    await grantEventPasswordAccess(event);
    return noStoreJson({ ok: true, redirect: `/events/${event.slug}` });
  } catch (error) {
    return apiError(error);
  }
}
