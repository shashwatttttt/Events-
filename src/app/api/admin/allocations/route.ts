import { config } from "@/lib/config";
import { z } from "zod";
import { mutateOperationsData, readOperationsData, readSiteData } from "@/lib/data/documents";
import { sendTemplateEmail } from "@/lib/email";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest, PublicApiError } from "@/lib/http";
import { expireStripeCheckoutSession } from "@/lib/payments";
import {
  expireNormalizedSessionState,
  findNormalizedAllocationSession,
  mutateNormalizedAllocation,
} from "@/lib/payments/transaction-store";
import { randomId } from "@/lib/security/crypto";
import { requireUser } from "@/lib/security/session";

const ACTIVE_PAYMENT_STATES = new Set(["payment_received", "fulfilment_pending", "paid_unfulfilled", "fulfilled", "manual_review", "recovery_failed"]);
const allocationMutationSchema = z.object({
  allocationId: z.string().min(1).max(100),
  action: z.enum(["extend", "cancel", "unlock", "remind"]),
  hours: z.number().int().min(1).max(336).optional(),
}).strict();
const bulkAllocationSchema = z.object({
  allocationIds: z.array(z.string().min(1).max(100)).min(1).max(100),
  action: z.literal("extend"),
  hours: z.number().int().min(1).max(336),
}).strict();

export async function PATCH(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["admin", "super_admin"]);
    const body = await parseJsonRequest(request, z.union([allocationMutationSchema, bulkAllocationSchema]), 32_768);

    if ("allocationIds" in body) {
      const ids = [...new Set(body.allocationIds)];
      const before = await readOperationsData();
      const allocations = ids.map((id) => before.allocations.find((item) => item.id === id));
      if (allocations.some((item) => !item)) throw new PublicApiError("ALLOCATION_NOT_FOUND", "One or more allocations were not found.", 404);
      const normalized = config.dataProvider === "supabase" ? await Promise.all(ids.map((id) => findNormalizedAllocationSession(id))) : ids.map(() => null);
      for (let index = 0; index < ids.length; index += 1) {
        const item = allocations[index]!;
        const reservation = before.reservations.filter((candidate) => candidate.allocationId === item.id).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
        const localAttempt = before.checkoutAttempts.find((candidate) => candidate.id === reservation?.checkoutAttemptId);
        const status = normalized[index]?.attemptStatus || localAttempt?.status;
        if (["paid", "ticket_issued"].includes(item.status) || (status && !["session_expired", "session_failed"].includes(status))) {
          throw new PublicApiError("ACTIVE_CHECKOUT_CONFLICT", "Bulk extension stopped because an allocation has payment or active checkout state.", 409);
        }
      }
      const expiresAt = new Date(Date.now() + body.hours * 60 * 60 * 1000).toISOString();
      if (config.dataProvider === "supabase") for (const id of ids) await mutateNormalizedAllocation(id, "extend", expiresAt);
      const updated = await mutateOperationsData((operations) => {
        const now = new Date().toISOString();
        return ids.map((id) => {
          const allocation = operations.allocations.find((item) => item.id === id)!;
          allocation.status = "unlocked"; allocation.expiresAt = expiresAt;
          operations.auditLogs.push({ id: randomId("audit"), actorId: actor.id, actorEmail: actor.email, action: "allocation.bulk_extend", entityType: "allocation", entityId: id, metadata: { hours: body.hours, expiresAt, batchSize: ids.length }, createdAt: now });
          return allocation;
        });
      });
      return noStoreJson({ allocations: updated, completed: updated.length });
    }

    const [site, before] = await Promise.all([readSiteData(), readOperationsData()]);
    const existing = before.allocations.find((item) => item.id === body.allocationId);
    if (!existing) throw new PublicApiError("ALLOCATION_NOT_FOUND", "Allocation was not found.", 404);
    const customer = before.users.find((item) => item.id === existing.userId);
    const event = site.events.find((item) => item.id === existing.eventId);
    if (!customer || !event) throw new PublicApiError("ALLOCATION_INCOMPLETE", "Allocation data is incomplete.", 409);

    const localReservation = before.reservations
      .filter((item) => item.allocationId === existing.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    const localAttempt = before.checkoutAttempts.find((item) => item.id === localReservation?.checkoutAttemptId);
    const normalizedAttempt = config.dataProvider === "supabase"
      ? await findNormalizedAllocationSession(existing.id)
      : null;
    const attemptStatus = normalizedAttempt?.attemptStatus || localAttempt?.status;
    const sessionId = normalizedAttempt?.sessionId || localAttempt?.stripeCheckoutSessionId;

    if (body.action !== "remind" && ACTIVE_PAYMENT_STATES.has(attemptStatus || "")) {
      throw new PublicApiError(
        "ACTIVE_CHECKOUT_CONFLICT",
        "This allocation already has payment activity and must be handled in Payment Recovery.",
        409,
      );
    }
    if (["extend", "unlock"].includes(body.action) && attemptStatus && !["session_expired", "session_failed"].includes(attemptStatus)) {
      throw new PublicApiError(
        "ACTIVE_CHECKOUT_CONFLICT",
        "Expire the active checkout before changing this allocation.",
        409,
      );
    }

    if (body.action === "cancel" && sessionId) {
      await expireStripeCheckoutSession(sessionId);
      if (config.dataProvider === "supabase") await expireNormalizedSessionState(sessionId, "expired");
    }

    const now = new Date();
    const nextExpiry = body.action === "extend"
      ? new Date(now.getTime() + Math.max(1, Math.min(336, Number(body.hours || site.settings.defaultAllocationExpiryHours))) * 60 * 60 * 1000).toISOString()
      : undefined;
    if (config.dataProvider === "supabase" && body.action !== "remind") {
      await mutateNormalizedAllocation(existing.id, body.action, nextExpiry);
    }

    const result = await mutateOperationsData((ops) => {
      const allocation = ops.allocations.find((item) => item.id === existing.id);
      if (!allocation) throw new Error("ALLOCATION_NOT_FOUND");
      if (["paid", "ticket_issued"].includes(allocation.status) && body.action !== "remind") {
        throw new PublicApiError("ALLOCATION_ALREADY_PAID", "Paid or issued allocations cannot be changed here.", 409);
      }
      if (body.action === "extend") {
        allocation.expiresAt = nextExpiry!;
        allocation.status = "unlocked";
      } else if (body.action === "cancel") {
        allocation.status = "cancelled";
        for (const order of ops.orders) {
          if (order.allocationId === allocation.id && ["pending", "checkout_pending"].includes(order.status)) {
            order.status = "cancelled";
            order.updatedAt = now.toISOString();
          }
        }
        if (localReservation && ["reserved", "session_active"].includes(localReservation.status)) {
          const reservation = ops.reservations.find((item) => item.id === localReservation.id);
          if (reservation) { reservation.status = "cancelled"; reservation.updatedAt = now.toISOString(); }
        }
        if (localAttempt && !ACTIVE_PAYMENT_STATES.has(localAttempt.status)) {
          const attempt = ops.checkoutAttempts.find((item) => item.id === localAttempt.id);
          if (attempt) { attempt.status = sessionId ? "session_expired" : "session_failed"; attempt.updatedAt = now.toISOString(); }
        }
      } else if (body.action === "unlock") {
        allocation.status = "unlocked";
      }
      ops.auditLogs.push({
        id: randomId("audit"),
        actorId: actor.id,
        actorEmail: actor.email,
        action: `allocation.${body.action}`,
        entityType: "allocation",
        entityId: allocation.id,
        metadata: { eventId: event.id, customerId: customer.id, expiresAt: allocation.expiresAt, sessionExpired: Boolean(sessionId) },
        createdAt: now.toISOString(),
      });
      return allocation;
    });

    if (body.action === "remind") {
      await sendTemplateEmail({
        templateKey: "payment_reminder",
        to: customer.email,
        recipientUserId: customer.id,
        eventId: event.id,
        variables: {
          first_name: customer.firstName,
          event_title: event.title,
          expires_at: new Date(result.expiresAt).toLocaleString("en-AU", { timeZone: site.settings.timezone }),
          account_url: `${config.siteUrl}/account`,
        },
        idempotencyKey: `payment_reminder:${result.id}:${Date.now()}`,
      });
    }
    return noStoreJson({ allocation: result });
  } catch (error) {
    return apiError(error);
  }
}
