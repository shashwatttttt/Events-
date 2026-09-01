import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), record: vi.fn() }));
vi.mock("resend", () => ({ Resend: class { webhooks = { verify: mocks.verify }; } }));
vi.mock("@/lib/notifications/store", () => ({ recordProviderCallback: mocks.record }));

function request() {
  return new Request("http://localhost/api/webhooks/resend/status", {
    method: "POST",
    headers: { "content-type": "application/json", "svix-id": "msg_fixture_event", "svix-timestamp": "1784680000", "svix-signature": "v1,fixture" },
    body: JSON.stringify({ type: "email.delivered", data: { email_id: "resend-message-id" } }),
  });
}

describe("Resend status callback", () => {
  beforeEach(() => {
    process.env.RESEND_WEBHOOK_SECRET = "whsec_fixture_not_live";
    mocks.verify.mockReturnValue({ type: "email.delivered", data: { email_id: "resend-message-id" } });
    mocks.record.mockResolvedValue({ matched: true, duplicate: false });
  });

  it("rejects a signature verification failure", async () => {
    mocks.verify.mockImplementation(() => { throw new Error("invalid"); });
    const { POST } = await import("@/app/api/webhooks/resend/status/route");
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("records a verified delivery without retaining webhook payload fields", async () => {
    const { POST } = await import("@/app/api/webhooks/resend/status/route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith({ provider: "resend", providerEventId: "msg_fixture_event", providerMessageId: "resend-message-id", providerStatus: "email.delivered", mappedStatus: "delivered" });
  });
});
