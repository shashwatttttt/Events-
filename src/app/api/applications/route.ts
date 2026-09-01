import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { getCustomerWorkspace, submitApplication } from "@/lib/operations";
import { requireUser } from "@/lib/security/session";
import { repairAuthenticatedCustomer } from "@/lib/security/auth-service";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";
import { applicationPayloadSchema } from "@/lib/validate";
import { captureAnalyticsSafely } from "@/lib/analytics/store";
import { queueMetaLead } from "@/lib/meta/conversions";
import { readMetaRequestContext } from "@/lib/meta/request-context";
import { verifyRecaptcha } from "@/lib/security/recaptcha";

function stableAnswers(value: Record<string, unknown>) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}

async function recoverIdenticalApplication(options: {
  userId: string;
  eventId: string;
  formId: string;
  answers: Record<string, unknown>;
}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const workspace = await getCustomerWorkspace(options.userId);
    const existing = workspace.applications.find(
      (item) => item.eventId === options.eventId
        && item.formId === options.formId
        && !["rejected", "cancelled"].includes(item.status)
        && stableAnswers(item.answers) === stableAnswers(options.answers),
    );
    if (existing) return existing;
    if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  return null;
}

export async function GET() {
  try { const user = await requireUser(["customer"]); return noStoreJson(await getCustomerWorkspace(user.id)); }
  catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    const authenticatedUser = await requireUser(["customer"]);
    const user = await repairAuthenticatedCustomer() || authenticatedUser;
    await enforceRateLimit(requestKey(request, "applications", user.id), 8, 60000);
    const metaContext = readMetaRequestContext(request);
    const payload = await parseJsonRequest(request, applicationPayloadSchema, 32_768);
    await verifyRecaptcha(payload.recaptchaToken, "application");

    let application;
    try {
      application = await submitApplication(
        user,
        payload,
        { ip: requestKey(request, "application-consent"), userAgent: request.headers.get("user-agent") || undefined },
      );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "You already have an active application for this event.") {
        throw error;
      }
      const existing = await recoverIdenticalApplication({
        userId: user.id,
        eventId: payload.eventId,
        formId: payload.formId,
        answers: payload.answers,
      });
      if (!existing) throw error;
      application = existing;
    }

    await captureAnalyticsSafely({ eventName:"application_completed",source:"server",deduplicationKey:`application_completed:${application.id}`,eventId:application.eventId,customerId:application.userId,occurredAt:application.createdAt });
    await queueMetaLead({
      customerId: application.userId,
      eventId: application.eventId,
      referenceId: application.id,
      method: "pre_checkout",
      context: metaContext,
      occurredAt: application.createdAt,
    }).catch(() => undefined);
    return noStoreJson({ application }, 201);
  } catch (error) { return apiError(error); }
}
