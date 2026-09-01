import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/security/session", () => ({ requireUser: vi.fn(async () => ({ id: "customer", firstName: "Test", lastName: "Customer", email: "customer@example.test", role: "customer" })) }));
vi.mock("@/lib/notifications/store", () => ({ getNotificationSettings: mocks.get, setNotificationPreferences: mocks.set, listInAppNotifications: mocks.list }));

const settings = {
  preferences: [{ channel: "email", enabled: true }, { channel: "sms", enabled: false }, { channel: "in_app", enabled: true }],
  consents: [{ channel: "sms", accepted: false }], globalControls: [], eventControls: [],
};

describe("customer notification preferences route", () => {
  beforeEach(() => {
    mocks.get.mockResolvedValue(settings);
    mocks.set.mockResolvedValue({ ...settings, preferences: [{ channel: "email", enabled: true }, { channel: "sms", enabled: true }, { channel: "in_app", enabled: true }] });
    mocks.list.mockResolvedValue([]);
  });

  it("returns only the authenticated customer's settings and inbox", async () => {
    const { GET } = await import("@/app/api/account/notifications/route");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ preferences: { email: true, sms: false, in_app: true, whatsapp: false }, smsConsent: false, notifications: [] });
    expect(mocks.get).toHaveBeenCalledWith("customer");
  });

  it("appends explicit SMS consent when SMS is enabled", async () => {
    const { PATCH } = await import("@/app/api/account/notifications/route");
    const response = await PATCH(new Request("http://localhost/api/account/notifications", {
      method: "PATCH", headers: { "content-type": "application/json", "user-agent": "fixture-agent" },
      body: JSON.stringify({ email: true, sms: true, in_app: true, whatsapp: false }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith("customer", expect.objectContaining({ sms: true }), expect.objectContaining({ smsAccepted: true, policyVersion: "transactional-sms-v1", ipHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });
});
