import "server-only";

import { config } from "@/lib/config";
import { mutateOperationsData } from "@/lib/data/documents";
import { failNormalizedCheckoutCreation } from "@/lib/payments/transaction-store";
import type { Order } from "@/types/site";

export async function releaseCheckoutBeforeProvider(order: Order) {
  if (!order.checkoutAttemptId) return;

  if (config.dataProvider === "supabase") {
    await failNormalizedCheckoutCreation(order.checkoutAttemptId);
    return;
  }

  await mutateOperationsData((operations) => {
    const attempt = operations.checkoutAttempts.find((item) => item.id === order.checkoutAttemptId);
    const reservation = operations.reservations.find((item) => item.id === order.reservationId);
    const storedOrder = operations.orders.find((item) => item.id === order.id);
    if (!attempt || !reservation || !storedOrder) return;
    if (attempt.status !== "creating_session" || reservation.status !== "reserved") return;

    const timestamp = new Date().toISOString();
    attempt.status = "session_failed";
    attempt.failureCode = "CHECKOUT_PRICE_CHANGED";
    attempt.updatedAt = timestamp;
    reservation.status = "failed";
    reservation.failureCode = "CHECKOUT_PRICE_CHANGED";
    reservation.updatedAt = timestamp;
    storedOrder.status = "failed";
    storedOrder.updatedAt = timestamp;

    const redemption = operations.promoRedemptions.find(
      (item) => item.reservationId === reservation.id && item.status === "reserved",
    );
    if (redemption) {
      redemption.status = "released";
      redemption.releasedAt = timestamp;
      redemption.updatedAt = timestamp;
    }

    const allocation = reservation.allocationId
      ? operations.allocations.find((item) => item.id === reservation.allocationId)
      : undefined;
    if (allocation?.status === "checkout_started") {
      allocation.status = new Date(allocation.expiresAt) <= new Date() ? "expired" : "unlocked";
    }
  });
}
