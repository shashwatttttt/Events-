import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: "door_staff",
  checkInTicket: vi.fn(),
  getDoorEntitlements: vi.fn(),
}));

vi.mock("@/lib/security/session", () => ({
  requireUser: vi.fn(async () => ({
    id: `local-${mocks.role}`,
    firstName: "Local",
    lastName: "Staff",
    email: `${mocks.role}@local.invalid`,
    role: mocks.role,
  })),
}));

vi.mock("@/lib/operations", () => ({
  checkInTicket: mocks.checkInTicket,
  getDoorEntitlements: mocks.getDoorEntitlements,
  manualCheckInTicket: vi.fn(),
  searchDoorTickets: vi.fn(),
}));

const ticket = {
  id: "local-ticket",
  orderId: "local-order",
  eventId: "local-event",
  holderName: "Local Customer",
  holderEmail: "customer@local.invalid",
  ticketCode: "LOCAL-CODE",
  status: "valid",
  checkedInAt: null,
};

function checkInRequest(eventId: string) {
  return new Request("http://localhost/api/check-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticketId: ticket.id, token: "local-token", eventId }),
  });
}

describe("check-in response scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = "door_staff";
    mocks.getDoorEntitlements.mockResolvedValue([]);
  });

  it("redacts ticket and entitlement details for a wrong-event scan", async () => {
    mocks.checkInTicket.mockResolvedValue({ result: "wrong_event", ticket, record: null });
    const { POST } = await import("@/app/api/check-in/route");
    const response = await POST(checkInRequest("different-event"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ result: "wrong_event", ticket: null, entitlements: [] });
    expect(JSON.stringify(body)).not.toContain(ticket.holderEmail);
    expect(mocks.getDoorEntitlements).not.toHaveBeenCalled();
  });

  it("does not perform a door-only entitlement read after a scanner check-in", async () => {
    mocks.role = "scanner_only";
    mocks.checkInTicket.mockResolvedValue({
      result: "valid",
      ticket: { ...ticket, status: "checked_in", checkedInAt: "2026-07-22T00:00:00.000Z" },
      record: null,
    });
    const { POST } = await import("@/app/api/check-in/route");
    const response = await POST(checkInRequest(ticket.eventId));
    expect(response.status).toBe(200);
    expect((await response.json()).entitlements).toEqual([]);
    expect(mocks.getDoorEntitlements).not.toHaveBeenCalled();
  });
});
