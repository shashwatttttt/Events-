import { z } from "zod";
import { analyticsReport } from "@/lib/analytics/store";
import { config } from "@/lib/config";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest, PublicApiError } from "@/lib/http";
import {
  processMetaConversionBatch,
  queueMetaConversion,
  readMetaDashboard,
} from "@/lib/meta/conversions";
import { requireUser } from "@/lib/security/session";

const actionSchema = z.object({
  action: z.enum(["retry", "test"]),
}).strict();

function melbourneDate(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function dateRange() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 29);
  return { startDate: melbourneDate(start), endDate: melbourneDate(end), since: start.toISOString() };
}

export async function GET() {
  try {
    await requireUser(["admin", "super_admin"]);
    const range = dateRange();
    const [delivery, firstParty] = await Promise.all([
      readMetaDashboard(range.since),
      analyticsReport({ startDate: range.startDate, endDate: range.endDate }),
    ]);
    const count = (name: string) => firstParty.byEventType.find((item) => item.eventName === name)?.count || 0;
    return noStoreJson({
      configuration: {
        pixelId: config.metaPixelId,
        pixelConfigured: Boolean(config.metaPixelId),
        capiRequested: config.metaConversionsApiRequested,
        capiConfigured: config.metaConversionsApiConfigured,
        capiEnabled: config.metaConversionsApiEnabled,
        graphApiVersionConfigured: Boolean(config.metaGraphApiVersion),
        accessTokenConfigured: Boolean(config.metaConversionsApiToken),
        testMode: Boolean(config.metaTestEventCode),
        consentMode: "opt_in",
        consentVersion: config.metaAdsConsentVersion,
      },
      delivery,
      firstPartyEstimate: {
        startDate: range.startDate,
        endDate: range.endDate,
        pageViews: count("page_view"),
        eventViews: count("event_page_view"),
        applications: count("application_completed"),
        checkouts: count("checkout_started"),
        completedPayments: count("payment_completed"),
      },
    });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["admin", "super_admin"]);
    const body = await parseJsonRequest(request, actionSchema, 1_024);
    if (body.action === "retry") {
      return noStoreJson({ result: await processMetaConversionBatch(25) });
    }
    if (!config.metaTestEventCode) {
      throw new PublicApiError(
        "META_TEST_CODE_REQUIRED",
        "Add the temporary Meta Test Event Code in Vercel before sending a test event.",
        409,
      );
    }
    const result = await queueMetaConversion({
      metaEventId: `test:${crypto.randomUUID()}`,
      eventName: "PageView",
      sourceEvent: "admin_test",
      customerId: actor.id,
      eventSourceUrl: config.siteUrl,
      safeMetadata: { test: true },
    });
    return noStoreJson({ result }, 201);
  } catch (error) { return apiError(error); }
}
