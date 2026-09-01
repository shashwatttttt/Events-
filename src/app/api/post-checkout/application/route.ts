import { z } from "zod";
import {
  assertRequestOrigin,
  apiError,
  noStoreJson,
  parseJsonRequest,
  PublicApiError,
} from "@/lib/http";
import { queueMetaLead } from "@/lib/meta/conversions";
import { readMetaRequestContext } from "@/lib/meta/request-context";
import {
  loadOwnedPostCheckoutApplication,
  saveOwnedPostCheckoutDraft,
  submitOwnedPostCheckoutApplication,
} from "@/lib/post-approval/service";
import { getPostCheckoutStatusForStripeSession } from "@/lib/post-approval/status";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";
import { requireUser } from "@/lib/security/session";

const answerSchema = z.record(z.string().min(1).max(100), z.union([
  z.string().max(5_000),
  z.boolean(),
  z.number().finite(),
]));

const writeSchema = z.object({
  action: z.enum(["save", "submit"]),
  orderId: z.string().uuid(),
  expectedStateVersion: z.number().int().positive(),
  answers: answerSchema,
}).strict();

type Answers = z.infer<typeof answerSchema>;

function isStaleVersionError(error: unknown) {
  return error instanceof Error && error.message.includes("POST_APPROVAL_STALE_VERSION");
}

function stableAnswers(value: Answers | undefined) {
  if (!value) return "";
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function answersMatch(left: Answers | undefined, right: Answers) {
  return stableAnswers(left) === stableAnswers(right);
}

async function saveWithConflictRecovery(input: {
  orderId: string;
  userId: string;
  answers: Answers;
  expectedStateVersion: number;
}) {
  try {
    return await saveOwnedPostCheckoutDraft(input);
  } catch (error) {
    if (!isStaleVersionError(error)) throw error;
    const latest = await loadOwnedPostCheckoutApplication(input.orderId, input.userId);
    const application = latest?.application;
    if (!application
      || !["awaiting_form", "draft"].includes(application.status)
      || !["authorized", "not_required"].includes(application.paymentStatus)) {
      throw new PublicApiError(
        "POST_APPROVAL_FORM_CHANGED",
        "This application changed in another request. Reload the page before saving again.",
        409,
      );
    }
    try {
      return await saveOwnedPostCheckoutDraft({
        ...input,
        expectedStateVersion: application.stateVersion,
      });
    } catch (retryError) {
      if (!isStaleVersionError(retryError)) throw retryError;
      throw new PublicApiError(
        "POST_APPROVAL_FORM_CHANGED",
        "This application is being updated elsewhere. Reload the page and try once more.",
        409,
      );
    }
  }
}

async function submitWithConflictRecovery(input: {
  orderId: string;
  user: Awaited<ReturnType<typeof requireUser>>;
  answers: Answers;
  expectedStateVersion: number;
}) {
  try {
    return await submitOwnedPostCheckoutApplication(input);
  } catch (error) {
    if (!isStaleVersionError(error)) throw error;
    const latest = await loadOwnedPostCheckoutApplication(input.orderId, input.user.id);
    const application = latest?.application;
    if (application
      && ["submitted", "under_review"].includes(application.status)
      && answersMatch(application.submittedAnswers, input.answers)) {
      return {
        applicationId: application.id,
        stateVersion: application.stateVersion,
        submittedAt: application.submittedAt || new Date().toISOString(),
      };
    }
    if (!application
      || !["awaiting_form", "draft"].includes(application.status)
      || !["authorized", "not_required"].includes(application.paymentStatus)) {
      throw new PublicApiError(
        "POST_APPROVAL_FORM_CHANGED",
        "This application changed before submission. Reload the page and review its current status.",
        409,
      );
    }
    try {
      return await submitOwnedPostCheckoutApplication({
        ...input,
        expectedStateVersion: application.stateVersion,
      });
    } catch (retryError) {
      if (!isStaleVersionError(retryError)) throw retryError;
      throw new PublicApiError(
        "POST_APPROVAL_FORM_CHANGED",
        "This application is being updated elsewhere. Reload the page and submit once more.",
        409,
      );
    }
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(["customer"]);
    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId");
    const sessionId = url.searchParams.get("sessionId");
    if (!orderId && !sessionId) throw new Error("Application reference is required.");
    const result = sessionId
      ? await getPostCheckoutStatusForStripeSession(sessionId, user.id)
      : await loadOwnedPostCheckoutApplication(String(orderId), user.id);
    if (!result) return noStoreJson({ error: "Application not found." }, 404);
    return noStoreJson(result);
  } catch (error) { return apiError(error); }
}

export async function PATCH(request: Request) {
  try {
    assertRequestOrigin(request);
    const user = await requireUser(["customer"]);
    await enforceRateLimit(requestKey(request, "post-checkout-form", user.id), 60, 60_000);
    const metaContext = readMetaRequestContext(request);
    const body = await parseJsonRequest(request, writeSchema, 64_000);
    if (body.action === "save") {
      const saved = await saveWithConflictRecovery({
        orderId: body.orderId,
        userId: user.id,
        answers: body.answers,
        expectedStateVersion: body.expectedStateVersion,
      });
      return noStoreJson({ saved });
    }
    const submitted = await submitWithConflictRecovery({
      orderId: body.orderId,
      user,
      answers: body.answers,
      expectedStateVersion: body.expectedStateVersion,
    });
    const owned = await loadOwnedPostCheckoutApplication(body.orderId, user.id);
    if (owned?.application) {
      await queueMetaLead({
        customerId: user.id,
        eventId: owned.application.eventId,
        referenceId: owned.application.id,
        method: "post_checkout",
        context: metaContext,
        orderId: body.orderId,
        occurredAt: owned.application.submittedAt || new Date().toISOString(),
      }).catch(() => undefined);
    }
    return noStoreJson({ submitted });
  } catch (error) { return apiError(error); }
}
