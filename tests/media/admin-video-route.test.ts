import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicApiError } from "@/lib/http";

const mocks = vi.hoisted(() => ({ role: "admin", create: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/security/session", () => ({ requireUser: vi.fn(async (roles: string[]) => {
  if (!roles.includes(mocks.role)) throw new PublicApiError("FORBIDDEN", "Forbidden.", 403);
  return { id: "actor_123456", email: "admin@example.test", firstName: "Admin", lastName: "User", role: mocks.role };
}) }));
vi.mock("@/lib/media/video-store", () => ({ listVideoAssets: mocks.list }));
vi.mock("@/lib/media/video-service", () => ({
  createVideoUploadIntent: mocks.create,
  retryVideoUpload: vi.fn(), updateVideoCaptions: vi.fn(), updateVideoPoster: vi.fn(), deleteVideoAsset: vi.fn(),
}));

describe("admin video route", () => {
  beforeEach(() => {
    mocks.role = "admin";
    mocks.list.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ asset: { id: "asset_123456", providerUploadId: "upload_secret_123456", providerAssetId: undefined, playbackId: undefined }, uploadUrl: "https://upload.mux.invalid/direct", simulated: true });
  });

  it("allows an admin to create a server-side direct-upload intent", async () => {
    const { POST } = await import("@/app/api/admin/media/video/route");
    const response = await POST(new Request("http://localhost/api/admin/media/video", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create", mediaItemId: "media_123456", playbackPolicy: "public", mimeType: "video/mp4", sizeBytes: 1024 }) }));
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), expect.objectContaining({ mediaItemId: "media_123456" }));
    const body = await response.json();
    expect(body).toMatchObject({ simulated: true, asset: { providerUploadIdRedacted: "upload...3456" } });
    expect(JSON.stringify(body.asset)).not.toContain("upload_secret_123456");
    expect(body.asset).not.toHaveProperty("providerUploadId");
  });

  it.each(["customer", "door_staff"])("rejects %s upload creation before provider work", async (role) => {
    mocks.role = role;
    const { POST } = await import("@/app/api/admin/media/video/route");
    const response = await POST(new Request("http://localhost/api/admin/media/video", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create", mediaItemId: "media_123456", mimeType: "video/mp4", sizeBytes: 1024 }) }));
    expect(response.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
