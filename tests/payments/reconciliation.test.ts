import { describe, expect, it } from "vitest";
import {
  assertStripeReferencesAreUnique,
  reconcilePaidStripeSession,
  reconcileTerminalStripeSession,
} from "@/lib/payments/reconciliation";
import {
  orderFixture,
  paidOrderFixture,
  paymentFixture,
  stripeCheckoutFixture,
} from "../fixtures";

describe("Stripe reconciliation foundation", () => {
  it("accepts a matching paid completion", () => {
    expect(reconcilePaidStripeSession(orderFixture(), stripeCheckoutFixture())).toBe("fulfill");
  });

  it("waits when a completed Session remains unpaid", () => {
    expect(
      reconcilePaidStripeSession(
        orderFixture(),
        stripeCheckoutFixture({ paymentStatus: "unpaid" }),
      ),
    ).toBe("awaiting_payment");
  });

  it("treats an identical paid order as a replay", () => {
    expect(reconcilePaidStripeSession(paidOrderFixture(), stripeCheckoutFixture())).toBe("replay");
  });

  it.each([
    ["amount", { amountTotal: 10_499 }],
    ["currency", { currency: "usd" }],
    ["Session", { sessionId: "cs_wrong" }],
    ["order metadata", { metadataOrderId: "ord_wrong" }],
    ["client reference", { clientReferenceOrderId: "ord_wrong" }],
  ])("rejects a wrong %s", (_label, changes) => {
    expect(() => reconcilePaidStripeSession(orderFixture(), stripeCheckoutFixture(changes))).toThrow();
  });

  it("accepts a matching terminal expiry snapshot", () => {
    expect(() => reconcileTerminalStripeSession(
      orderFixture(),
      stripeCheckoutFixture({
        eventType: "checkout.session.expired",
        paymentStatus: "unpaid",
        paymentIntentId: null,
      }),
    )).not.toThrow();
  });

  it("rejects provider references already bound to another order", () => {
    expect(() => assertStripeReferencesAreUnique(
      orderFixture(),
      stripeCheckoutFixture(),
      [orderFixture(), orderFixture({ id: "ord_other", stripeCheckoutSessionId: "cs_test_fixture" })],
      [paymentFixture({ orderId: "ord_other" })],
    )).toThrow();
  });
});
