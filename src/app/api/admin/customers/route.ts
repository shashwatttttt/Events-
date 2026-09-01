import { z } from "zod";
import { config } from "@/lib/config";
import { removeNormalizedTestCustomer } from "@/lib/admin/test-data-cleanup";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest, PublicApiError } from "@/lib/http";
import { mutateOperationsData } from "@/lib/data/documents";
import { randomId } from "@/lib/security/crypto";
import { requireUser } from "@/lib/security/session";

const updateCustomerSchema = z.object({
  userId: z.string().min(1).max(100),
  tags: z.array(z.string().max(80)).max(30).optional(),
  internalNotes: z.string().max(3_000).optional(),
}).strict();

const removeCustomerSchema = z.object({
  userId: z.string().min(1).max(120),
  reason: z.string().trim().min(3).max(500),
  confirmation: z.string().trim().min(3).max(254),
}).strict();

const cleanupMessages: Record<string, string> = {
  SUPER_ADMIN_REQUIRED: "Only a super administrator can remove test customer data.",
  CUSTOMER_NOT_FOUND: "The customer record was not found.",
  CUSTOMER_ROLE_PROTECTED: "Staff and administrator accounts cannot be removed from this control.",
  CUSTOMER_CONFIRMATION_MISMATCH: "The confirmation email does not match this customer.",
  CUSTOMER_HAS_STAFF_ACCESS: "Remove this customer's active staff access before deleting the test record.",
  CUSTOMER_OWNS_PROMO_CODE: "This customer owns a promo code and cannot be removed.",
  CUSTOMER_HAS_PROTECTED_PAYMENT: "This customer has a live Stripe, refund, dispute or protected payment record and cannot be removed.",
  CUSTOMER_HAS_CHECK_IN_HISTORY: "This customer has attendance history and cannot be removed.",
  CUSTOMER_HAS_REDEMPTION_HISTORY: "This customer has add-on redemption history and cannot be removed.",
  CUSTOMER_HAS_PROTECTED_AUTHORIZATION: "This customer has a protected card authorisation or post-checkout payment state and cannot be removed.",
  CUSTOMER_HAS_UNRESOLVED_RECOVERY: "Resolve the customer's payment recovery work before removing the record.",
};

function cleanupError(error: unknown): never {
  const code = error instanceof Error ? error.message : "TEST_CUSTOMER_REMOVE_FAILED";
  throw new PublicApiError(
    code,
    cleanupMessages[code] || "The test customer could not be removed safely.",
    code.endsWith("_NOT_FOUND") ? 404 : code === "SUPER_ADMIN_REQUIRED" ? 403 : 409,
  );
}

export async function PATCH(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["admin", "super_admin"]);
    const body = await parseJsonRequest(request, updateCustomerSchema, 8_192);
    const user = await mutateOperationsData((ops) => {
      const target = ops.users.find((item) => item.id === body.userId);
      if (!target) throw new PublicApiError("CUSTOMER_NOT_FOUND", "The customer record was not found.", 404);
      if (body.tags) target.tags = body.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 30);
      if (body.internalNotes !== undefined) target.internalNotes = body.internalNotes.slice(0, 3000);
      target.updatedAt = new Date().toISOString();
      ops.auditLogs.push({ id: randomId("audit"), actorId: actor.id, actorEmail: actor.email, action: "customer.updated", entityType: "user", entityId: target.id, metadata: {}, createdAt: target.updatedAt });
      return target;
    });
    return noStoreJson({ user });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["super_admin"]);
    const body = await parseJsonRequest(request, removeCustomerSchema, 8_192);

    if (config.dataProvider === "supabase") {
      try {
        return noStoreJson({ removed: await removeNormalizedTestCustomer({
          actorId: actor.id,
          customerId: body.userId,
          reason: body.reason,
          confirmation: body.confirmation,
        }) });
      } catch (error) {
        cleanupError(error);
      }
    }

    const removed = await mutateOperationsData((ops) => {
      const customer = ops.users.find((item) => item.id === body.userId);
      if (!customer) throw new PublicApiError("CUSTOMER_NOT_FOUND", cleanupMessages.CUSTOMER_NOT_FOUND, 404);
      if (customer.role !== "customer") throw new PublicApiError("CUSTOMER_ROLE_PROTECTED", cleanupMessages.CUSTOMER_ROLE_PROTECTED, 409);
      if (customer.email.toLowerCase() !== body.confirmation.toLowerCase()) throw new PublicApiError("CUSTOMER_CONFIRMATION_MISMATCH", cleanupMessages.CUSTOMER_CONFIRMATION_MISMATCH, 409);
      if (ops.eventStaffAssignments.some((item) => item.userId === customer.id && item.active)) throw new PublicApiError("CUSTOMER_HAS_STAFF_ACCESS", cleanupMessages.CUSTOMER_HAS_STAFF_ACCESS, 409);
      if (ops.promoCodes.some((item) => item.createdBy === customer.id)) throw new PublicApiError("CUSTOMER_OWNS_PROMO_CODE", cleanupMessages.CUSTOMER_OWNS_PROMO_CODE, 409);

      const orderIds = new Set(ops.orders.filter((item) => item.userId === customer.id).map((item) => item.id));
      const ticketIds = new Set(ops.tickets.filter((item) => item.userId === customer.id).map((item) => item.id));
      const entitlementIds = new Set(ops.entitlements.filter((item) => item.userId === customer.id).map((item) => item.id));
      const reservationIds = new Set(ops.reservations.filter((item) => item.customerId === customer.id).map((item) => item.id));
      const outboxIds = new Set(ops.notificationOutbox.filter((item) => item.recipientUserId === customer.id || (item.orderId && orderIds.has(item.orderId))).map((item) => item.id));
      const protectedPayment = ops.payments.some((item) => orderIds.has(item.orderId) && (item.provider === "stripe" || ["refund_pending", "refunded", "partially_refunded", "disputed", "suspended", "manual_review"].includes(item.status)));
      if (protectedPayment) throw new PublicApiError("CUSTOMER_HAS_PROTECTED_PAYMENT", cleanupMessages.CUSTOMER_HAS_PROTECTED_PAYMENT, 409);
      if (ops.checkIns.some((item) => ticketIds.has(item.ticketId))) throw new PublicApiError("CUSTOMER_HAS_CHECK_IN_HISTORY", cleanupMessages.CUSTOMER_HAS_CHECK_IN_HISTORY, 409);
      if (ops.entitlementRedemptions.some((item) => entitlementIds.has(item.entitlementId))) throw new PublicApiError("CUSTOMER_HAS_REDEMPTION_HISTORY", cleanupMessages.CUSTOMER_HAS_REDEMPTION_HISTORY, 409);
      if (ops.paymentRecoveryActions.some((item) => item.orderId && orderIds.has(item.orderId) && item.status !== "completed")) throw new PublicApiError("CUSTOMER_HAS_UNRESOLVED_RECOVERY", cleanupMessages.CUSTOMER_HAS_UNRESOLVED_RECOVERY, 409);

      ops.users = ops.users.filter((item) => item.id !== customer.id);
      ops.consents = ops.consents.filter((item) => item.userId !== customer.id);
      ops.applications = ops.applications.filter((item) => item.userId !== customer.id);
      ops.allocations = ops.allocations.filter((item) => item.userId !== customer.id);
      ops.orders = ops.orders.filter((item) => !orderIds.has(item.id));
      ops.payments = ops.payments.filter((item) => !orderIds.has(item.orderId));
      ops.tickets = ops.tickets.filter((item) => !ticketIds.has(item.id));
      ops.entitlements = ops.entitlements.filter((item) => !entitlementIds.has(item.id));
      ops.entitlementRedemptions = ops.entitlementRedemptions.filter((item) => !entitlementIds.has(item.entitlementId));
      ops.checkIns = ops.checkIns.filter((item) => !ticketIds.has(item.ticketId));
      ops.reservations = ops.reservations.filter((item) => !reservationIds.has(item.id));
      ops.checkoutAttempts = ops.checkoutAttempts.filter((item) => !orderIds.has(item.orderId));
      ops.paymentAdjustments = ops.paymentAdjustments.filter((item) => !orderIds.has(item.orderId));
      ops.paymentRecoveryActions = ops.paymentRecoveryActions.filter((item) => !item.orderId || !orderIds.has(item.orderId));
      ops.eventStaffAssignments = ops.eventStaffAssignments.filter((item) => item.userId !== customer.id);
      ops.notificationOutbox = ops.notificationOutbox.filter((item) => !outboxIds.has(item.id));
      ops.notificationAttempts = ops.notificationAttempts.filter((item) => !outboxIds.has(item.outboxId));
      ops.notificationPreferences = ops.notificationPreferences.filter((item) => item.userId !== customer.id);
      ops.notificationConsents = ops.notificationConsents.filter((item) => item.userId !== customer.id);
      ops.promoRedemptions = ops.promoRedemptions.filter((item) => item.customerId !== customer.id);
      ops.analyticsEvents = ops.analyticsEvents.filter((item) => item.customerId !== customer.id);
      const removedAt = new Date().toISOString();
      ops.auditLogs.push({ id: randomId("audit"), actorId: actor.id, actorEmail: actor.email, action: "test_customer.removed", entityType: "customer", entityId: customer.id, metadata: { hiddenTickets: ticketIds.size }, createdAt: removedAt });
      return { customerId: customer.id, deletedAt: removedAt, hiddenTickets: ticketIds.size };
    });
    return noStoreJson({ removed });
  } catch (error) { return apiError(error); }
}
