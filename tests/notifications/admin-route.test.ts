import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: "admin", list: vi.fn(), manage: vi.fn(), preview: vi.fn(), enqueue: vi.fn(), enqueueTicket: vi.fn(),
  control: vi.fn(), audit: vi.fn(), contact: vi.fn(), multi: vi.fn(),
}));

vi.mock("@/lib/security/session", () => ({ requireUser: vi.fn(async (roles: string[]) => {
  if (!roles.includes(mocks.role)) throw new Error("FORBIDDEN");
  return { id: "actor", firstName: "Admin", lastName: "Fixture", email: "actor@example.test", role: mocks.role };
}) }));
vi.mock("@/lib/notifications/store", () => ({
  listNotifications: mocks.list, manageNotification: mocks.manage, enqueueNotification: mocks.enqueue,
  setNotificationControl: mocks.control, auditNotificationAdminAction: mocks.audit,
}));
vi.mock("@/lib/notifications/service", () => ({
  previewTemplate: mocks.preview, enqueueTicketNotificationsForOrder: mocks.enqueueTicket,
  getCustomerNotificationContact: mocks.contact, enqueueTransactionalNotifications: mocks.multi,
}));

describe("notification admin route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = "admin";
    mocks.list.mockResolvedValue({ items: [], attempts: [] });
    mocks.preview.mockResolvedValue({ subject: "Preview", html: "<p>Preview</p>", text: "Preview", attachments: [] });
    mocks.enqueue.mockResolvedValue({ item: { id: "notification" }, duplicate: false });
    mocks.enqueueTicket.mockResolvedValue({ queued: [{ id: "notification" }], skipped: [] });
    mocks.control.mockResolvedValue({ channel: "sms", enabled: false });
    mocks.audit.mockResolvedValue(1);
    mocks.contact.mockResolvedValue({ userId: "customer", email: "customer@example.test", phone: "+61412345678" });
    mocks.multi.mockResolvedValue({ queued: [{ id: "notification", channel: "email", duplicate: false }], skipped: [] });
  });

  it.each(["customer", "door_staff", "scanner_only"])("denies %s", async (role) => {
    mocks.role = role;
    const { GET } = await import("@/app/api/admin/notifications/route");
    const response = await GET(new Request("http://localhost/api/admin/notifications"));
    expect(response.status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("returns safe preview metadata without attachment content", async () => {
    const { POST } = await import("@/app/api/admin/notifications/route");
    const response = await POST(new Request("http://localhost/api/admin/notifications", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "preview", templateKey: "ticket_issued" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ subject: "Preview", attachments: [] });
  });

  it("requires a fulfilled order for a ticket test send", async () => {
    const { POST } = await import("@/app/api/admin/notifications/route");
    const response = await POST(new Request("http://localhost/api/admin/notifications", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "test_send", templateKey: "ticket_issued", recipient: "local@example.test" }),
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "ORDER_REQUIRED" });
  });

  it("records an administrator channel-control action", async () => {
    const { POST } = await import("@/app/api/admin/notifications/route");
    const response = await POST(new Request("http://localhost/api/admin/notifications", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set_control", channel: "sms", enabled: false, eventId: "fixture-event" }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.control).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), "sms", false, "fixture-event");
  });

  it("denies a customer admin mutation", async () => {
    mocks.role = "customer";
    const { POST } = await import("@/app/api/admin/notifications/route");
    const response = await POST(new Request("http://localhost/api/admin/notifications", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set_control", channel: "sms", enabled: true }),
    }));
    expect(response.status).toBe(403);
    expect(mocks.control).not.toHaveBeenCalled();
  });

  it("retries a bounded notification selection", async () => {
    mocks.manage.mockResolvedValue({ id: "notification", status: "queued" });
    const { POST } = await import("@/app/api/admin/notifications/route");
    const response = await POST(new Request("http://localhost/api/admin/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "bulk_retry", notificationIds: ["notice-a", "notice-b"] }) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ completed: 2, failed: 0 });
    expect(mocks.manage).toHaveBeenCalledTimes(2);
  });
});
