import { describe, expect, it } from "vitest";
import {
  applyLocalDispute,
  applyLocalRefund,
  assertReservationMatchesOrder,
  createReservationRecords,
  linkLocalStripeSession,
  markLocalPaidUnfulfilled,
  markLocalWebhookResult,
  recordLocalPaymentReceived,
  recordLocalStripeWebhook,
} from "@/lib/payments/state";
import {
  entitlementFixture,
  eventFixture,
  operationsFixture,
  orderFixture,
  paymentFixture,
  sessionUserFixture,
  stripeCheckoutFixture,
  ticketFixture,
} from "../fixtures";

function durableOperations() {
  const order = orderFixture({ stripeCheckoutSessionId: undefined, stripePaymentIntentId: undefined });
  const durable = createReservationRecords({
    order,
    event: eventFixture(),
    customer: sessionUserFixture(),
    customerEmail: "customer@example.test",
    ticketLine: {
      kind: "ticket",
      referenceId: "tt_fixture",
      name: "Fixture Admission",
      quantity: 2,
      unitPriceCents: 4_500,
      ticketTypeCapacity: 80,
      eventPublicCapacity: 80,
      customerLimit: 2,
    },
    productLines: [{
      kind: "product",
      referenceId: "prod_fixture",
      name: "Fixture Extra",
      quantity: 1,
      unitPriceCents: 1_500,
      stockQuantity: 20,
      maxPerCustomer: 2,
      unitsPerPurchase: 1,
      redeemable: true,
    }],
  });
  return operationsFixture({
    orders: [durable.order],
    reservations: [durable.reservation],
    checkoutAttempts: [durable.checkoutAttempt],
    payments: [],
  });
}

describe("durable payment transaction state", () => {
  it("links one provider Session idempotently and rejects replacement", () => {
    const ops = durableOperations();
    const attempt = ops.checkoutAttempts[0];
    linkLocalStripeSession(ops, attempt.id, "cs_test_fixture", "2026-07-21T00:59:00.000Z");
    expect(linkLocalStripeSession(ops, attempt.id, "cs_test_fixture", "2026-07-21T00:59:00.000Z").status).toBe("session_active");
    expect(() => linkLocalStripeSession(ops, attempt.id, "cs_different", "2026-07-21T00:59:00.000Z")).toThrow("CHECKOUT_SESSION_ALREADY_LINKED");
  });

  it("records payment proof before fulfilment and preserves immutable pricing", () => {
    const ops = durableOperations();
    const attempt = ops.checkoutAttempts[0];
    linkLocalStripeSession(ops, attempt.id, "cs_test_fixture", "2026-07-21T00:59:00.000Z");
    const order = ops.orders[0];
    recordLocalPaymentReceived(ops, order, stripeCheckoutFixture());
    expect(order.status).toBe("payment_received");
    expect(ops.payments).toHaveLength(1);
    expect(ops.reservations[0].expectedTotalCents).toBe(10_500);
    expect(() => assertReservationMatchesOrder(ops.reservations[0], { ...order, totalCents: 1 })).toThrow("RESERVATION_TOTAL_MISMATCH");
  });

  it("marks paid-but-unfulfilled without removing payment proof", () => {
    const ops = durableOperations();
    linkLocalStripeSession(ops, ops.checkoutAttempts[0].id, "cs_test_fixture", "2026-07-21T00:59:00.000Z");
    recordLocalPaymentReceived(ops, ops.orders[0], stripeCheckoutFixture());
    markLocalPaidUnfulfilled(ops, ops.reservations[0].id, "FULFILMENT_WRITE_FAILED");
    expect(ops.orders[0].status).toBe("paid_unfulfilled");
    expect(ops.payments[0].status).toBe("payment_received");
  });

  it("rejects a paid snapshot with the wrong authoritative amount", () => {
    const ops = durableOperations();
    linkLocalStripeSession(ops, ops.checkoutAttempts[0].id, "cs_test_fixture", "2026-07-21T00:59:00.000Z");
    expect(() => recordLocalPaymentReceived(ops, ops.orders[0], stripeCheckoutFixture({ amountTotal: 1 }))).toThrow("PAYMENT_AMOUNT_MISMATCH");
    expect(ops.reservations[0].status).toBe("manual_review");
  });

  it("stores a webhook once and handles result replay", () => {
    const ops = durableOperations();
    const input = {
      stripeEventId: "evt_fixture",
      eventType: "checkout.session.completed",
      livemode: false,
      checkoutSessionId: "cs_test_fixture",
      correlationId: "corr_fixture",
      providerCreatedAt: "2026-07-21T00:30:00.000Z",
    };
    expect(recordLocalStripeWebhook(ops, input).duplicate).toBe(false);
    expect(recordLocalStripeWebhook(ops, input).duplicate).toBe(true);
    markLocalWebhookResult(ops, input.stripeEventId, "processed");
    expect(ops.stripeWebhookEvents[0]).toMatchObject({ status: "processed", processingAttempts: 1 });
  });

  it("full refund invalidates all tickets and entitlements idempotently", () => {
    const ops = durableOperations();
    ops.orders[0].status = "fulfilled";
    ops.payments = [paymentFixture({ orderId: ops.orders[0].id })];
    ops.tickets = [ticketFixture({ orderId: ops.orders[0].id })];
    ops.entitlements = [entitlementFixture({ orderId: ops.orders[0].id })];
    const input = { providerObjectId: "re_full", paymentIntentId: "pi_fixture", amountCents: 10_500, currency: "AUD", status: "succeeded" as const };
    expect(applyLocalRefund(ops, input).duplicate).toBe(false);
    expect(applyLocalRefund(ops, input).duplicate).toBe(true);
    expect(ops.tickets[0].status).toBe("refunded");
    expect(ops.entitlements[0].status).toBe("refunded");
  });

  it("unattributable partial refund enters manual review", () => {
    const ops = durableOperations();
    ops.orders[0].status = "fulfilled";
    ops.payments = [paymentFixture({ orderId: ops.orders[0].id })];
    applyLocalRefund(ops, { providerObjectId: "re_partial", paymentIntentId: "pi_fixture", amountCents: 1_000, currency: "AUD", status: "succeeded" });
    expect(ops.orders[0].status).toBe("manual_review");
    expect(ops.reservations[0].failureCode).toBe("UNATTRIBUTABLE_PARTIAL_REFUND");
  });

  it("advances the same refund from pending to succeeded", () => {
    const ops = durableOperations();
    ops.orders[0].status = "fulfilled";
    ops.payments = [paymentFixture({ orderId: ops.orders[0].id })];
    const base = { providerObjectId: "re_progress", paymentIntentId: "pi_fixture", amountCents: 10_500, currency: "AUD" };
    applyLocalRefund(ops, { ...base, status: "pending" });
    expect(ops.orders[0].status).toBe("refund_pending");
    applyLocalRefund(ops, { ...base, status: "succeeded" });
    expect(ops.orders[0].status).toBe("refunded");
    expect(ops.paymentAdjustments).toHaveLength(1);
  });

  it("dispute suspends access, a win restores it, and a loss invalidates it", () => {
    const ops = durableOperations();
    ops.orders[0].status = "fulfilled";
    ops.payments = [paymentFixture({ orderId: ops.orders[0].id })];
    ops.tickets = [ticketFixture({ orderId: ops.orders[0].id })];
    ops.entitlements = [entitlementFixture({ orderId: ops.orders[0].id })];
    const base = { providerObjectId: "dp_fixture", paymentIntentId: "pi_fixture", amountCents: 10_500, currency: "AUD" };
    applyLocalDispute(ops, { ...base, status: "needs_response" });
    expect(ops.tickets[0].status).toBe("suspended");
    expect(ops.entitlements[0].status).toBe("suspended");
    applyLocalDispute(ops, { ...base, status: "won" });
    expect(ops.tickets[0].status).toBe("valid");
    expect(ops.entitlements[0].status).toBe("active");
    applyLocalDispute(ops, { ...base, status: "needs_response" });
    applyLocalDispute(ops, { ...base, status: "lost" });
    expect(ops.tickets[0].status).toBe("refunded");
    expect(ops.entitlements[0].status).toBe("refunded");
  });
});
