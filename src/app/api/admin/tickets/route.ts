import { z } from "zod";
import { config } from "@/lib/config";
import { removeNormalizedTestTicket } from "@/lib/admin/test-data-cleanup";
import { setNormalizedAdminTicketStatus } from "@/lib/admin/ticket-status";
import { mutateOperationsData } from "@/lib/data/documents";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest, PublicApiError } from "@/lib/http";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";
import { randomId } from "@/lib/security/crypto";
import { requireUser } from "@/lib/security/session";
import type { TicketStatus } from "@/types/site";

const schema = z.object({
  ticketId: z.string().min(1).max(120),
  status: z.enum(["valid", "cancelled", "entry_refused"]),
}).strict();

const removeSchema = z.object({
  ticketId: z.string().min(1).max(120),
  reason: z.string().trim().min(3).max(500),
  confirmation: z.string().trim().min(1).max(120),
}).strict();

const cleanupMessages: Record<string, string> = {
  SUPER_ADMIN_REQUIRED: "Only a super administrator can remove a test ticket.",
  TICKET_NOT_FOUND: "The ticket was not found.",
  TICKET_CONFIRMATION_MISMATCH: "The confirmation code does not match this ticket.",
  TEST_TICKET_HAS_ATTENDANCE_OR_REFUND: "Checked-in or refunded tickets cannot be removed.",
  TEST_TICKET_HAS_CHECK_IN_HISTORY: "This ticket has scan history and cannot be removed.",
  TEST_TICKET_HAS_PROTECTED_PAYMENT: "This ticket belongs to a live Stripe, refund, dispute or protected payment and cannot be removed.",
  TEST_TICKET_HAS_REDEMPTION_HISTORY: "This ticket's order has add-on redemption history and cannot be removed.",
  TEST_TICKET_HAS_UNRESOLVED_RECOVERY: "Resolve the ticket's payment recovery work before removing it.",
};

function cleanupError(error: unknown): never {
  const code = error instanceof Error ? error.message : "TEST_TICKET_REMOVE_FAILED";
  throw new PublicApiError(
    code,
    cleanupMessages[code] || "The test ticket could not be removed safely.",
    code === "TICKET_NOT_FOUND" ? 404 : code === "SUPER_ADMIN_REQUIRED" ? 403 : 409,
  );
}

export async function PATCH(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["admin", "super_admin"]);
    await enforceRateLimit(requestKey(request, "admin-ticket-status", actor.id), 60, 60_000);
    const body = await parseJsonRequest(request, schema, 4_096);

    if (config.dataProvider === "supabase") {
      const ticket = await setNormalizedAdminTicketStatus({
        actorId: actor.id,
        ticketId: body.ticketId,
        status: body.status,
      });
      return noStoreJson({ ticket });
    }

    const ticket = await mutateOperationsData((ops) => {
      const target = ops.tickets.find((item) => item.id === body.ticketId);
      if (!target) throw new Error("Ticket not found.");
      if (target.status === "refunded") throw new Error("Refunded tickets cannot be restored from this control.");
      if (target.status === "checked_in" && body.status === "valid") {
        throw new PublicApiError("REVERSAL_REASON_REQUIRED", "Use the reason-required check-in reversal control.", 409);
      }
      target.status = body.status as TicketStatus;
      if (body.status === "valid") {
        target.checkedInAt = undefined;
        target.checkedInBy = undefined;
      }
      ops.auditLogs.push({
        id: randomId("audit"),
        actorId: actor.id,
        actorEmail: actor.email,
        action: `ticket.status.${body.status}`,
        entityType: "ticket",
        entityId: target.id,
        metadata: { eventId: target.eventId },
        createdAt: new Date().toISOString(),
      });
      return target;
    });
    return noStoreJson({ ticket });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["super_admin"]);
    await enforceRateLimit(requestKey(request, "admin-test-ticket-remove", actor.id), 20, 60_000);
    const body = await parseJsonRequest(request, removeSchema, 8_192);

    if (config.dataProvider === "supabase") {
      try {
        return noStoreJson({ removed: await removeNormalizedTestTicket({
          actorId: actor.id,
          ticketId: body.ticketId,
          reason: body.reason,
          confirmation: body.confirmation,
        }) });
      } catch (error) {
        cleanupError(error);
      }
    }

    const removed = await mutateOperationsData((ops) => {
      const ticket = ops.tickets.find((item) => item.id === body.ticketId);
      if (!ticket) throw new PublicApiError("TICKET_NOT_FOUND", cleanupMessages.TICKET_NOT_FOUND, 404);
      if (ticket.ticketCode !== body.confirmation) throw new PublicApiError("TICKET_CONFIRMATION_MISMATCH", cleanupMessages.TICKET_CONFIRMATION_MISMATCH, 409);
      if (ticket.status === "checked_in" || ticket.status === "refunded" || ticket.checkedInAt) throw new PublicApiError("TEST_TICKET_HAS_ATTENDANCE_OR_REFUND", cleanupMessages.TEST_TICKET_HAS_ATTENDANCE_OR_REFUND, 409);
      if (ops.checkIns.some((item) => item.ticketId === ticket.id)) throw new PublicApiError("TEST_TICKET_HAS_CHECK_IN_HISTORY", cleanupMessages.TEST_TICKET_HAS_CHECK_IN_HISTORY, 409);
      const payments = ops.payments.filter((item) => item.orderId === ticket.orderId);
      if (payments.some((item) => item.provider === "stripe" || ["refund_pending", "refunded", "partially_refunded", "disputed", "suspended", "manual_review"].includes(item.status))) throw new PublicApiError("TEST_TICKET_HAS_PROTECTED_PAYMENT", cleanupMessages.TEST_TICKET_HAS_PROTECTED_PAYMENT, 409);
      const entitlementIds = new Set(ops.entitlements.filter((item) => item.orderId === ticket.orderId).map((item) => item.id));
      if (ops.entitlementRedemptions.some((item) => entitlementIds.has(item.entitlementId))) throw new PublicApiError("TEST_TICKET_HAS_REDEMPTION_HISTORY", cleanupMessages.TEST_TICKET_HAS_REDEMPTION_HISTORY, 409);
      if (ops.paymentRecoveryActions.some((item) => item.orderId === ticket.orderId && item.status !== "completed")) throw new PublicApiError("TEST_TICKET_HAS_UNRESOLVED_RECOVERY", cleanupMessages.TEST_TICKET_HAS_UNRESOLVED_RECOVERY, 409);
      ops.tickets = ops.tickets.filter((item) => item.id !== ticket.id);
      ops.analyticsEvents = ops.analyticsEvents.filter((item) => item.deduplicationKey !== `ticket_issued:${ticket.id}`);
      const deletedAt = new Date().toISOString();
      ops.auditLogs.push({ id: randomId("audit"), actorId: actor.id, actorEmail: actor.email, action: "test_ticket.removed", entityType: "ticket", entityId: ticket.id, metadata: { eventId: ticket.eventId, orderId: ticket.orderId || "" }, createdAt: deletedAt });
      return { ticketId: ticket.id, deletedAt };
    });
    return noStoreJson({ removed });
  } catch (error) {
    return apiError(error);
  }
}
