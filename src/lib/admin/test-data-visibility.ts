import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { AdminOperationalMetrics } from "@/lib/admin/live-snapshot";
import type { OperationsData } from "@/types/site";

export async function filterRemovedTestData(
  operations: OperationsData,
): Promise<{ operations: OperationsData; metrics: AdminOperationalMetrics }> {
  const client = createSupabaseAdminClient();
  const [profileResult, ticketResult] = await Promise.all([
    client.from("profiles").select("id").not("admin_deleted_at", "is", null).limit(5_000),
    client.from("tickets").select("id").not("admin_deleted_at", "is", null).limit(10_000),
  ]);
  if (profileResult.error || ticketResult.error) throw new Error("ADMIN_TEST_DATA_VISIBILITY_UNAVAILABLE");

  const removedCustomers = new Set((profileResult.data || []).map((row) => String(row.id)));
  const removedTickets = new Set((ticketResult.data || []).map((row) => String(row.id)));
  const visibleUsers = operations.users.filter((item) => !removedCustomers.has(item.id));
  const visibleUserIds = new Set(visibleUsers.map((item) => item.id));
  const visibleOrders = operations.orders.filter((item) => visibleUserIds.has(item.userId));
  const visibleOrderIds = new Set(visibleOrders.map((item) => item.id));
  const visibleTickets = operations.tickets.filter((item) => visibleUserIds.has(item.userId) && !removedTickets.has(item.id));
  const visibleTicketIds = new Set(visibleTickets.map((item) => item.id));
  const visibleEntitlements = operations.entitlements.filter((item) => visibleUserIds.has(item.userId) && visibleOrderIds.has(item.orderId));
  const visibleEntitlementIds = new Set(visibleEntitlements.map((item) => item.id));

  const filtered: OperationsData = {
    ...operations,
    users: visibleUsers,
    applications: operations.applications.filter((item) => visibleUserIds.has(item.userId)),
    consents: operations.consents.filter((item) => visibleUserIds.has(item.userId)),
    allocations: operations.allocations.filter((item) => visibleUserIds.has(item.userId)),
    orders: visibleOrders,
    payments: operations.payments.filter((item) => visibleOrderIds.has(item.orderId)),
    tickets: visibleTickets,
    entitlements: visibleEntitlements,
    entitlementRedemptions: operations.entitlementRedemptions.filter((item) => visibleEntitlementIds.has(item.entitlementId)),
    checkIns: operations.checkIns.filter((item) => visibleTicketIds.has(item.ticketId)),
    reservations: operations.reservations.filter((item) => visibleUserIds.has(item.customerId)),
    checkoutAttempts: operations.checkoutAttempts.filter((item) => visibleOrderIds.has(item.orderId)),
    paymentAdjustments: operations.paymentAdjustments.filter((item) => visibleOrderIds.has(item.orderId)),
    paymentRecoveryActions: operations.paymentRecoveryActions.filter((item) => !item.orderId || visibleOrderIds.has(item.orderId)),
    eventStaffAssignments: operations.eventStaffAssignments.filter((item) => visibleUserIds.has(item.userId)),
    notificationOutbox: operations.notificationOutbox.filter((item) => !item.recipientUserId || visibleUserIds.has(item.recipientUserId)),
    notificationPreferences: operations.notificationPreferences.filter((item) => visibleUserIds.has(item.userId)),
    notificationConsents: operations.notificationConsents.filter((item) => visibleUserIds.has(item.userId)),
    promoRedemptions: operations.promoRedemptions.filter((item) => visibleUserIds.has(item.customerId)),
    analyticsEvents: operations.analyticsEvents.filter((item) => !item.customerId || visibleUserIds.has(item.customerId)),
  };

  const stripePayments = filtered.payments.filter((payment) => payment.provider === "stripe"
    && !["failed", "cancelled"].includes(payment.status));
  const paidOrderIds = new Set(stripePayments
    .filter((payment) => payment.status !== "refunded")
    .map((payment) => payment.orderId));
  const grossRevenueCents = stripePayments.reduce((sum, payment) => sum + payment.amountCents, 0);
  const refundedCents = stripePayments.reduce((sum, payment) => sum + (payment.refundedCents || 0), 0);

  return {
    operations: filtered,
    metrics: {
      source: "normalized",
      grossRevenueCents,
      refundedCents,
      netRevenueCents: Math.max(0, grossRevenueCents - refundedCents),
      paidOrders: paidOrderIds.size,
      issuedTickets: filtered.tickets.length,
      checkedInTickets: filtered.tickets.filter((ticket) => ticket.status === "checked_in").length,
      pendingOrders: filtered.orders.filter((order) => [
        "reserved", "checkout_pending", "payment_received", "fulfilment_pending",
        "paid_unfulfilled", "manual_review", "recovery_failed",
      ].includes(order.status)).length,
      updatedAt: new Date().toISOString(),
    },
  };
}
