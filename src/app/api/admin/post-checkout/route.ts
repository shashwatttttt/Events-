import { z } from "zod";
import { config } from "@/lib/config";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { postCheckoutAdminFilters } from "@/lib/post-approval/admin-page-store";
import {
  listPostCheckoutApplicationsForAdminPage,
  sendPostCheckoutFormReminderById,
} from "@/lib/post-approval/admin-service";
import {
  decideGuestlistApplication,
  retryGuestlistFulfilment,
} from "@/lib/post-approval/guestlist-service";
import {
  decidePostCheckoutApplication,
  extendPostCheckoutApplicationDeadline,
  retryPostCheckoutPaymentAction,
} from "@/lib/post-approval/service";
import { processPostCheckoutPaymentActionById } from "@/lib/post-approval/worker";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";
import { requireUser } from "@/lib/security/session";

export const maxDuration = 60;

const listSchema = z.object({
  filter: z.enum(postCheckoutAdminFilters).default("active"),
  search: z.string().trim().max(120).default(""),
  eventId: z.string().trim().max(100).optional(),
  cursor: z.string().trim().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("decision"),
    applicationId: z.string().uuid(),
    decision: z.enum(["approve", "approve_without_form", "reject"]),
    internalReason: z.string().trim().min(3).max(3_000),
    customerMessage: z.string().trim().max(2_000).optional(),
  }).strict(),
  z.object({
    action: z.literal("reminder"),
    applicationId: z.string().uuid(),
    final: z.boolean().optional(),
  }).strict(),
  z.object({
    action: z.literal("extend"),
    applicationId: z.string().uuid(),
    formDueAt: z.string().datetime({ offset: true }),
  }).strict(),
  z.object({
    action: z.literal("retry_payment"),
    applicationId: z.string().uuid(),
  }).strict(),
  z.object({
    action: z.literal("retry_guestlist"),
    orderId: z.string().uuid(),
  }).strict(),
  z.object({
    action: z.literal("process_payment"),
    actionId: z.string().uuid(),
  }).strict(),
]);

const adminActionErrors: Record<string, { message: string; status: number }> = {
  POST_APPROVAL_ALREADY_DECIDED: {
    message: "A decision has already been recorded for this application. Refresh to see its current state.",
    status: 409,
  },
  POST_APPROVAL_OVERRIDE_NOT_ALLOWED: {
    message: "The automatic cancellation has already started or this application can no longer be approved without the form. Refresh before taking another action.",
    status: 409,
  },
  POST_APPROVAL_PAYMENT_NOT_AUTHORIZED: {
    message: "The card authorisation is no longer available for capture. Refresh and review the payment state.",
    status: 409,
  },
  POST_APPROVAL_CAPTURE_DEADLINE_MISSING: {
    message: "Stripe has not supplied a safe capture deadline for this authorisation. Do not approve it manually.",
    status: 409,
  },
  POST_APPROVAL_AUTHORIZATION_TOO_CLOSE_TO_EXPIRY: {
    message: "The card authorisation is too close to expiry to capture safely. Refresh and release or restart the checkout.",
    status: 409,
  },
  POST_APPROVAL_FORM_REQUIRED: {
    message: "The mandatory form has not been submitted. Use Approve without form only for a deliberate administrative exception.",
    status: 409,
  },
  POST_APPROVAL_PAYMENT_ACTION_NOT_RETRYABLE: {
    message: "This payment action is no longer retryable. Refresh to see the latest Stripe state.",
    status: 409,
  },
  GUESTLIST_FULFILMENT_NOT_RETRYABLE: {
    message: "This guest-list application is not in a state that can be fulfilled again. Refresh the application.",
    status: 409,
  },
  GUESTLIST_PAYMENT_STATE_INVALID: {
    message: "This record is not a no-payment guest-list application. Refresh before taking another action.",
    status: 409,
  },
};

function adminPostCheckoutError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : error instanceof Error ? error.message : "";
  const known = adminActionErrors[code];
  return known
    ? noStoreJson({ error: known.message, code }, known.status)
    : apiError(error);
}

export async function GET(request: Request) {
  try {
    await requireUser(["admin", "super_admin"]);
    const url = new URL(request.url);
    const query = listSchema.parse(Object.fromEntries(url.searchParams.entries()));
    const page = await listPostCheckoutApplicationsForAdminPage(query);
    return noStoreJson({
      enabled: true,
      acceptingNew: config.postCheckoutApprovalEnabled,
      applications: page.items,
      nextCursor: page.nextCursor,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["admin", "super_admin"]);
    await enforceRateLimit(requestKey(request, "admin-post-checkout", actor.id), 30, 60_000);
    const body = await parseJsonRequest(request, actionSchema, 16_384);
    if (body.action === "decision") {
      const guestlistDecision = await decideGuestlistApplication({
        applicationId: body.applicationId,
        actor,
        decision: body.decision,
        internalReason: body.internalReason,
        customerMessage: body.customerMessage,
      });
      if (guestlistDecision) {
        return noStoreJson({ decision: guestlistDecision, paymentAction: null });
      }

      const result = await decidePostCheckoutApplication({
        applicationId: body.applicationId,
        actor,
        decision: body.decision,
        internalReason: body.internalReason,
        customerMessage: body.customerMessage,
      });
      const paymentAction = await processPostCheckoutPaymentActionById(result.actionId)
        .catch(() => ({ claimed: false, completed: false }));
      return noStoreJson({ decision: result, paymentAction });
    }
    if (body.action === "reminder") {
      return noStoreJson(await sendPostCheckoutFormReminderById(body.applicationId, actor.id, Boolean(body.final)));
    }
    if (body.action === "retry_payment") {
      const retried = await retryPostCheckoutPaymentAction(body.applicationId, actor.id);
      const paymentAction = await processPostCheckoutPaymentActionById(retried.actionId)
        .catch(() => ({ claimed: false, completed: false }));
      return noStoreJson({ retried, paymentAction });
    }
    if (body.action === "retry_guestlist") {
      return noStoreJson({ fulfilled: await retryGuestlistFulfilment(body.orderId) });
    }
    if (body.action === "process_payment") {
      return noStoreJson({ paymentAction: await processPostCheckoutPaymentActionById(body.actionId) });
    }
    return noStoreJson({
      extended: await extendPostCheckoutApplicationDeadline(body.applicationId, actor.id, body.formDueAt),
    });
  } catch (error) {
    return adminPostCheckoutError(error);
  }
}
