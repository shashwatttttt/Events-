import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/security/session", () => ({ requireUser: mocks.requireUser }));
import { DELETE, POST } from "@/app/api/admin/upload/route";

describe("media administration boundary", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["customer", "door_staff", "scanner"])("denies %s uploads", async () => {
    mocks.requireUser.mockRejectedValue(new Error("FORBIDDEN"));
    const response = await POST(new Request("http://localhost/api/admin/upload", { method: "POST", headers: { "content-length": "1" } }));
    expect(response.status).toBe(403);
  });
  it("rejects oversized requests before parsing multipart data", async () => {
    mocks.requireUser.mockResolvedValue({ id: "admin", role: "admin" });
    const response = await POST(new Request("http://localhost/api/admin/upload", { method: "POST", headers: { "content-length": String(60 * 1024 * 1024) } }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "MEDIA_REQUEST_TOO_LARGE" });
  });
  it("requires admin authorization for deletion and cleanup", async () => {
    mocks.requireUser.mockRejectedValue(new Error("FORBIDDEN"));
    const response = await DELETE(new Request("http://localhost/api/admin/upload", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cleanup", minimumAgeHours: 24 }) }));
    expect(response.status).toBe(403);
  });
});
