import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
  loadOwned: vi.fn(),
  retrieveSession: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  stripeCaptureBefore: vi.fn(),
  recordAuthorization: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: mocks.maybeSingle,
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    return { from: vi.fn(() => query) };
  },
}));

vi.mock("@/lib/payments", () => ({
  retrieveStripeCheckoutSession: mocks.retrieveSession,
  retrieveStripePaymentIntent: mocks.retrievePaymentIntent,
  stripeCaptureBefore: mocks.stripeCaptureBefore,
}));

vi.mock("@/lib/post-approval/service", () => ({
  loadOwnedPostCheckoutApplication: mocks.loadOwned,
}));

vi.mock("@/lib/post-approval/store", () => ({
  recordPostCheckoutAuthorization: mocks.recordAuthorization,
}));

import { getPostCheckoutStatusForStripeSession } from "@/lib/post-approval/status";

const pending = {
  application: { paymentStatus: "authorization_pending" },
  event: { title: "HOUSE ARREST" },
};
const authorized = {
  application: { paymentStatus: "authorized" },
  event: { title: "HOUSE ARREST" },
};

const paymentIntent = {
  id: "pi_live_1",
  status: "requires_capture",
  amount: 1499,
  amount_capturable: 1499,
  currency: "aud",
  latest_charge: null,
};

describe("post-checkout Stripe return reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.maybeSingle.mockResolvedValue({
      data: { order_id: "order-1", orders: { customer_id: "user-1" } },
      error: null,
    });
    mocks.stripeCaptureBefore.mockReturnValue(undefined);
  });

  it("records a completed manual authorization with normalized currency and reloads the application", async () => {
    mocks.loadOwned.mockResolvedValueOnce(pending).mockResolvedValueOnce(authorized);
    mocks.retrieveSession.mockResolvedValue({
      id: "cs_live_1",
      status: "complete",
      client_reference_id: "order-1",
      metadata: { order_id: "order-1", user_id: "user-1" },
      payment_intent: paymentIntent,
    });
    mocks.recordAuthorization.mockResolvedValue({ applicationId: "application-1", duplicate: false });

    const result = await getPostCheckoutStatusForStripeSession("cs_live_1", "user-1");

    expect(mocks.retrieveSession).toHaveBeenCalledWith("cs_live_1");
    expect(mocks.recordAuthorization).toHaveBeenCalledWith({
      orderId: "order-1",
      checkoutSessionId: "cs_live_1",
      paymentIntentId: "pi_live_1",
      amountCents: 1499,
      capturableCents: 1499,
      currency: "AUD",
      captureBefore: undefined,
    });
    expect(result).toBe(authorized);
  });

  it("does not query Stripe for a session that does not belong to the signed-in customer", async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { order_id: "order-1", orders: { customer_id: "another-user" } },
      error: null,
    });

    await expect(getPostCheckoutStatusForStripeSession("cs_live_1", "user-1")).resolves.toBeNull();
    expect(mocks.retrieveSession).not.toHaveBeenCalled();
    expect(mocks.recordAuthorization).not.toHaveBeenCalled();
  });

  it("keeps waiting when Stripe Checkout is still open", async () => {
    mocks.loadOwned.mockResolvedValue(pending);
    mocks.retrieveSession.mockResolvedValue({
      id: "cs_live_1",
      status: "open",
      client_reference_id: "order-1",
      metadata: { order_id: "order-1", user_id: "user-1" },
    });

    const result = await getPostCheckoutStatusForStripeSession("cs_live_1", "user-1");

    expect(mocks.recordAuthorization).not.toHaveBeenCalled();
    expect(result).toBe(pending);
  });
});
