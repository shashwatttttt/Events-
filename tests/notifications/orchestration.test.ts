import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ settings: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/notifications/store", () => ({
  getNotificationSettings: mocks.settings,
  enqueueNotification: mocks.enqueue,
  enqueueEmail: vi.fn(),
}));

describe("multi-channel notification orchestration", () => {
  beforeEach(() => {
    mocks.enqueue.mockImplementation(async (input) => ({ item: { id: `notification-${input.channel}` }, duplicate: false }));
    mocks.settings.mockResolvedValue({
      preferences: [
        { channel: "email", enabled: true }, { channel: "sms", enabled: true },
        { channel: "in_app", enabled: true }, { channel: "whatsapp", enabled: true },
      ],
      consents: [{ channel: "sms", accepted: true, createdAt: "2026-07-22T00:00:00.000Z" }],
      globalControls: [
        { channel: "email", enabled: true }, { channel: "sms", enabled: true },
        { channel: "in_app", enabled: true }, { channel: "whatsapp", enabled: true },
      ],
      eventControls: [],
    });
  });

  it("queues enabled consented channels with channel-scoped idempotency", async () => {
    const { enqueueTransactionalNotifications } = await import("@/lib/notifications/service");
    const result = await enqueueTransactionalNotifications({
      templateKey: "application_received", recipientUserId: "customer", recipientEmail: "customer@example.test",
      recipientPhone: "+61412345678", eventId: "event", payload: { variables: {} }, idempotencyKey: "application:one",
    });
    expect(result.queued.map((item) => item.channel)).toEqual(["email", "sms", "in_app"]);
    expect(result.skipped).toContainEqual({ channel: "whatsapp", reason: "feature_flag" });
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ channel: "sms", idempotencyKey: "application:one:sms" }));
  });

  it("honours an event disable and missing consent", async () => {
    mocks.settings.mockResolvedValue({
      preferences: [{ channel: "email", enabled: true }, { channel: "sms", enabled: true }],
      consents: [], globalControls: [{ channel: "email", enabled: true }, { channel: "sms", enabled: true }],
      eventControls: [{ channel: "email", enabled: false }],
    });
    const { enqueueTransactionalNotifications } = await import("@/lib/notifications/service");
    const result = await enqueueTransactionalNotifications({ templateKey: "waitlist", recipientUserId: "customer", recipientEmail: "customer@example.test", recipientPhone: "+61412345678", eventId: "event", idempotencyKey: "waitlist:one" });
    expect(result.queued.map((item) => item.channel)).toEqual(["in_app"]);
    expect(result.skipped).toContainEqual({ channel: "email", reason: "disabled" });
    expect(result.skipped).toContainEqual({ channel: "sms", reason: "consent_or_phone" });
  });
});
