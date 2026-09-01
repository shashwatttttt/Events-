import { captureAnalyticsSafely } from "@/lib/analytics/store";
import { readSiteData } from "@/lib/data/documents";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest, PublicApiError } from "@/lib/http";
import { POST_CHECKOUT_MODE } from "@/lib/post-approval/types";
import { quotePromoCart } from "@/lib/promos/service";
import { requireUser } from "@/lib/security/session";
import { orderPayloadSchema } from "@/lib/validate";

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    const user = await requireUser(["customer"]);
    const payload = await parseJsonRequest(request, orderPayloadSchema, 16_384);
    try {
      const quote = await quotePromoCart(user, payload);
      if (quote.guestlistApplication) {
        const site = await readSiteData();
        const event = site.events.find((item) => item.id === payload.eventId);
        if (!event || String(event.ticketMode) !== POST_CHECKOUT_MODE) {
          throw new PublicApiError(
            "GUESTLIST_APPLICATION_MODE_REQUIRED",
            "This guest-list code is available only through an application-and-approval checkout.",
            422,
          );
        }
      }
      return noStoreJson(quote);
    } catch (error) {
      await captureAnalyticsSafely({
        eventName: "promo_rejected",
        source: "server",
        deduplicationKey: `promo_rejected:${user.id}:${payload.eventId}:${Date.now()}`,
        eventId: payload.eventId,
        ticketTypeId: payload.ticketTypeId,
        customerId: user.id,
        occurredAt: new Date().toISOString(),
      });
      throw error;
    }
  } catch (error) {
    return apiError(error);
  }
}
