import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseJsonRequest } from "@/lib/http";
import { siteFixture } from "../fixtures";

const mocks = vi.hoisted(() => ({
  role: "admin",
  replaceSiteData: vi.fn(),
  listStaffAdministration: vi.fn(),
  manageStaffAssignment: vi.fn(),
  setStaffAccountRole: vi.fn(),
  mutateOperationsData: vi.fn(),
}));

vi.mock("@/lib/security/session", () => ({
  requireUser: vi.fn(async (roles: string[]) => {
    if (!roles.includes(mocks.role)) throw new Error("FORBIDDEN");
    return { id: "usr_actor", firstName: "Local", lastName: "Actor", email: "actor@example.test", role: mocks.role };
  }),
}));
vi.mock("@/lib/data/documents", () => ({
  readSiteDataSnapshot: vi.fn(async () => ({ value: siteFixture(), version: `local:${"a".repeat(64)}` })),
  replaceSiteData: mocks.replaceSiteData,
  mutateOperationsData: mocks.mutateOperationsData,
}));
vi.mock("@/lib/payments", () => ({ expireStripeCheckoutSession: vi.fn() }));
vi.mock("@/lib/payments/transaction-store", () => ({
  expireNormalizedSessionState: vi.fn(),
  listNormalizedActiveEventSessions: vi.fn(async () => []),
}));
vi.mock("@/lib/staff", () => ({
  listStaffAdministration: mocks.listStaffAdministration,
  manageStaffAssignment: mocks.manageStaffAssignment,
  setStaffAccountRole: mocks.setStaffAccountRole,
}));

const version = `local:${"a".repeat(64)}`;

describe("Phase 3 route contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = "admin";
    mocks.replaceSiteData.mockResolvedValue({ value: siteFixture(), version: `local:${"b".repeat(64)}`, closedEventIds: [] });
    mocks.listStaffAdministration.mockResolvedValue({ users: [], assignments: [], audits: [] });
    mocks.mutateOperationsData.mockReset();
  });

  it("passes the caller's expected CMS version and returns the next version", async () => {
    const { PUT } = await import("@/app/api/admin/site/route");
    const response = await PUT(new Request("http://localhost/api/admin/site", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: siteFixture(), expectedVersion: version }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.replaceSiteData).toHaveBeenCalledWith(
      expect.objectContaining({ events: siteFixture().events }),
      version,
      expect.objectContaining({ actorId: "usr_actor" }),
    );
    expect(await response.json()).toMatchObject({ version: `local:${"b".repeat(64)}` });
  });

  it("returns a stable 409 and correlation ID for a stale CMS save", async () => {
    mocks.replaceSiteData.mockRejectedValue(new Error("CMS_STALE_VERSION"));
    const { PUT } = await import("@/app/api/admin/site/route");
    const response = await PUT(new Request("http://localhost/api/admin/site", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: siteFixture(), expectedVersion: version }),
    }));
    expect(response.status).toBe(409);
    expect(response.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.json()).toMatchObject({ code: "CMS_STALE_VERSION" });
  });

  it("rejects oversized CMS bodies before parsing", async () => {
    const { PUT } = await import("@/app/api/admin/site/route");
    const response = await PUT(new Request("http://localhost/api/admin/site", {
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": "2000001" },
      body: "{}",
    }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "REQUEST_TOO_LARGE" });
    expect(mocks.replaceSiteData).not.toHaveBeenCalled();
  });

  it("stops an undeclared oversized JSON stream at the route limit", async () => {
    const request = new Request("http://localhost/api/fixture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(100) }),
    });
    await expect(parseJsonRequest(request, z.object({ value: z.string() }), 32)).rejects.toMatchObject({
      code: "REQUEST_TOO_LARGE",
      status: 413,
    });
  });

  it.each(["customer", "door_staff", "scanner_only"])("denies %s staff administration", async (role) => {
    mocks.role = role;
    const { GET } = await import("@/app/api/admin/staff/route");
    const response = await GET();
    expect(response.status).toBe(403);
    expect(mocks.listStaffAdministration).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized customer administration payloads before mutation", async () => {
    const { PATCH } = await import("@/app/api/admin/customers/route");
    const malformed = await PATCH(new Request("http://localhost/api/admin/customers", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "usr_target", role: "super_admin" }),
    }));
    expect(malformed.status).toBe(422);
    expect(await malformed.json()).toMatchObject({ code: "INVALID_REQUEST" });

    const oversized = await PATCH(new Request("http://localhost/api/admin/customers", {
      method: "PATCH",
      headers: { "content-type": "application/json", "content-length": "8193" },
      body: "{}",
    }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "REQUEST_TOO_LARGE" });
    expect(mocks.mutateOperationsData).not.toHaveBeenCalled();
  });
});
