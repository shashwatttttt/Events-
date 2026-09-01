import { beforeEach, describe, expect, it, vi } from "vitest";

const constructStripeEvent = vi.fn();
const recordStripeWebhookInbox = vi.fn();
const markStripeWebhookInboxResult = vi.fn();

vi.mock("@/lib/payments", () => ({
  constructStripeEvent,
  stripeCheckoutSnapshot: vi.fn(),
}));
vi.mock("@/lib/operations", () => ({
  applyStripeDisputeUpdate: vi.fn(),
  applyStripeRefundUpdate: vi.fn(),
  fulfillStripeOrder: vi.fn(),
  markStripeWebhookInboxResult,
  recordStripeCheckoutTerminalEvent: vi.fn(),
  recordStripePaymentIntentTerminal: vi.fn(),
  recordStripeWebhookInbox,
}));

describe("Stripe webhook boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a missing signature before reading provider data", async () => {
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(new Request("http://localhost/api/stripe/webhook", { method: "POST", body: "{}" }));
    expect(response.status).toBe(400);
    expect(constructStripeEvent).not.toHaveBeenCalled();
    expect(recordStripeWebhookInbox).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature without writing the inbox", async () => {
    constructStripeEvent.mockImplementation(() => { throw new Error("invalid"); });
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "fixture-invalid" },
      body: "{}",
    }));
    expect(response.status).toBe(400);
    expect(recordStripeWebhookInbox).not.toHaveBeenCalled();
  });

  it("acknowledges an already processed live event without processing it again", async () => {
    constructStripeEvent.mockReturnValue({
      id: "evt_fixture", type: "unhandled.fixture", livemode: true, created: 1_774_224_600,
      data: { object: { id: "obj_fixture" } },
    });
    recordStripeWebhookInbox.mockResolvedValue({ inserted: false, status: "processed" });
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const response = await POST(new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "fixture-valid" },
      body: "{}",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, handled: true, duplicate: true });
    expect(markStripeWebhookInboxResult).not.toHaveBeenCalled();
  });
});
