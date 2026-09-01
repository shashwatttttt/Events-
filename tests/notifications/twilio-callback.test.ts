import { beforeEach, describe, expect, it, vi } from "vitest";
import { twilioSignature } from "@/lib/notifications/twilio";

const mocks = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/lib/notifications/store", () => ({ recordProviderCallback: mocks.record }));

describe("Twilio status callback", () => {
  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = "callback-test-token";
    process.env.TWILIO_STATUS_CALLBACK_URL = "https://staging.example.test/api/webhooks/twilio/status";
    mocks.record.mockResolvedValue({ matched: true, duplicate: false });
  });

  it("rejects an invalid signature without recording data", async () => {
    const { POST } = await import("@/app/api/webhooks/twilio/status/route");
    const response = await POST(new Request(process.env.TWILIO_STATUS_CALLBACK_URL!, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "invalid" }, body: "MessageSid=SM12345678901234567890123456789012&MessageStatus=delivered" }));
    expect(response.status).toBe(401);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("records a verified callback using a derived idempotency identifier", async () => {
    const params = { MessageSid: "SM12345678901234567890123456789012", MessageStatus: "delivered", SequenceId: "1" };
    const body = new URLSearchParams(params);
    const signature = twilioSignature(process.env.TWILIO_STATUS_CALLBACK_URL!, params, process.env.TWILIO_AUTH_TOKEN!);
    const { POST } = await import("@/app/api/webhooks/twilio/status/route");
    const response = await POST(new Request(process.env.TWILIO_STATUS_CALLBACK_URL!, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature }, body }));
    expect(response.status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ provider: "twilio", providerMessageId: params.MessageSid, providerStatus: "delivered", mappedStatus: "delivered", providerEventId: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });
});
