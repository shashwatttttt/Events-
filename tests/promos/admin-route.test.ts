import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), listPromos: vi.fn(), savePromo: vi.fn() }));
vi.mock("@/lib/security/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/promos/service", async (original) => ({ ...(await original<typeof import("@/lib/promos/service")>()), listPromos: mocks.listPromos, savePromo: mocks.savePromo }));

import { GET } from "@/app/api/admin/promos/route";

describe("promo administration authorization", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.listPromos.mockResolvedValue({ promos: [], redemptions: [] }); });
  it.each(["customer", "door_staff", "scanner"])("denies %s", async (role) => {
    mocks.requireUser.mockRejectedValue(new Error(role === "customer" ? "FORBIDDEN" : "FORBIDDEN"));
    expect((await GET()).status).toBe(403);
    expect(mocks.listPromos).not.toHaveBeenCalled();
  });
  it("allows an administrator", async () => {
    mocks.requireUser.mockResolvedValue({ id: "admin", email: "admin@local.invalid", role: "admin" });
    expect((await GET()).status).toBe(200);
    expect(mocks.requireUser).toHaveBeenCalledWith(["admin", "super_admin"]);
  });
});
