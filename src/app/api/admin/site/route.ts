import { z } from "zod";
import { assertRequestOrigin, apiError, createCorrelationId, noStoreJson, parseJsonRequest } from "@/lib/http";
import { readSiteDataSnapshot, replaceSiteData } from "@/lib/data/documents";
import { config } from "@/lib/config";
import { expireStripeCheckoutSession } from "@/lib/payments";
import { processEventPaymentShutdownBatch } from "@/lib/payments/event-shutdown";
import { expireNormalizedSessionState, listNormalizedActiveEventSessions } from "@/lib/payments/transaction-store";
import { POST_CHECKOUT_MODE } from "@/lib/post-approval/types";
import { requireUser } from "@/lib/security/session";
import type { SiteData } from "@/types/site";
import { assertValidSiteData } from "@/lib/site-validation";
import { normalizeSiteData } from "@/lib/site-content";
import { reconcileMediaReferences } from "@/lib/media/store";

const saveSchema = z.object({
  site: z.unknown(),
  expectedVersion: z.string().regex(/^(local:[0-9a-f]{64}|supabase:\d+)$/),
}).strict();

function validatePostCheckoutModes(site: SiteData) {
  for (const event of site.events) {
    if (String(event.ticketMode) !== POST_CHECKOUT_MODE) continue;
    if (!config.postCheckoutApprovalEnabled) {
      throw new Error(`${event.title} cannot use post-checkout approval until the global feature is enabled.`);
    }
    if (!event.formId || !site.forms.some((form) => form.id === event.formId && form.active)) {
      throw new Error(`${event.title} post-checkout approval requires an active application form.`);
    }
    if (event.ticketTypes.some((ticketType) => ticketType.active && ticketType.priceCents <= 0)) {
      throw new Error(`${event.title} post-checkout approval requires paid active ticket types.`);
    }
    if (!["public", "private_link", "password"].includes(event.visibility)) {
      throw new Error(`${event.title} post-checkout approval requires public, private-link or password visibility.`);
    }
  }
  const compatibilityCopy: SiteData = {
    ...site,
    events: site.events.map((event) => String(event.ticketMode) === POST_CHECKOUT_MODE
      ? { ...event, ticketMode: "direct_purchase" }
      : event),
  };
  assertValidSiteData(compatibilityCopy);
}

async function legacyExpireClosedEventSessions(eventIds: string[], correlationId: string) {
  const expiryFailures: string[] = [];
  let sessions: Awaited<ReturnType<typeof listNormalizedActiveEventSessions>> = [];
  try {
    sessions = await listNormalizedActiveEventSessions(eventIds);
  } catch {
    expiryFailures.push(...eventIds);
    console.error("Emergency-close Session lookup requires recovery.", { correlationId, code: "SESSION_LOOKUP_FAILED", affectedEventCount: eventIds.length });
  }
  for (const session of sessions) {
    try {
      await expireStripeCheckoutSession(session.sessionId);
      await expireNormalizedSessionState(session.sessionId, "expired");
    } catch {
      expiryFailures.push(session.eventId);
    }
  }
  return { processed: sessions.length, failures: expiryFailures };
}

export async function GET() { try { await requireUser(["admin", "super_admin"]); const snapshot = await readSiteDataSnapshot(); return noStoreJson({ site: snapshot.value, version: snapshot.version }); } catch (error) { return apiError(error); } }
export async function PUT(request: Request) {
  const correlationId = createCorrelationId();
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["super_admin", "admin"]);
    const body = await parseJsonRequest(request, saveSchema, 2_000_000);
    const site = normalizeSiteData(body.site as SiteData);
    validatePostCheckoutModes(site);
    const saved = await replaceSiteData(site, body.expectedVersion, { actorId: actor.id, correlationId });
    let mediaRegistrySynchronized = true;
    try {
      await reconcileMediaReferences(saved.value.media);
    } catch {
      mediaRegistrySynchronized = false;
      console.error("Media registry synchronization requires recovery.", { correlationId, code: "MEDIA_REGISTRY_SYNC_FAILED" });
    }

    let shutdownAvailable = config.dataProvider !== "supabase";
    let shutdownProcessed = 0;
    let shutdownFailures: string[] = [];
    let shutdownQueued = 0;
    if (config.dataProvider === "supabase" && saved.closedEventIds.length) {
      try {
        const shutdown = await processEventPaymentShutdownBatch({
          eventIds: saved.closedEventIds,
          batchSize: 25,
          workerId: `admin_event_shutdown_${crypto.randomUUID()}`,
        });
        shutdownAvailable = shutdown.available;
        shutdownProcessed = shutdown.processed;
        shutdownQueued = shutdown.queued.checkoutSessionsQueued + shutdown.queued.paymentIntentsQueued;
        shutdownFailures = shutdown.results.filter((item) => item.status !== "completed").map((item) => item.id);
      } catch {
        shutdownFailures = [...saved.closedEventIds];
      }

      // Backward-compatible rollout: migration 31 may apply moments after the
      // application deploys. Preserve the existing Session expiry path until
      // the durable queue is available.
      if (!shutdownAvailable) {
        const legacy = await legacyExpireClosedEventSessions(saved.closedEventIds, correlationId);
        shutdownProcessed += legacy.processed;
        shutdownFailures.push(...legacy.failures);
      }
    }
    if (shutdownFailures.length) console.error("Some emergency-close payment actions require recovery.", { correlationId, code: "EVENT_PAYMENT_SHUTDOWN_INCOMPLETE", affectedCount: new Set(shutdownFailures).size });

    return noStoreJson({
      ok: true,
      site: saved.value,
      version: saved.version,
      emergencyClose: {
        closedEventCount: saved.closedEventIds.length,
        shutdownAvailable,
        shutdownQueued,
        shutdownProcessed,
        expiryComplete: shutdownFailures.length === 0,
      },
      mediaRegistrySynchronized,
    }, 200, correlationId);
  } catch (error) { return apiError(error, 400, correlationId); }
}
