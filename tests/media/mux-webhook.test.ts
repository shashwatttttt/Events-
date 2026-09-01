import { beforeEach, describe, expect, it, vi } from "vitest";
import { muxSignature } from "@/lib/media/mux";

const mocks = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/lib/media/video-store", () => ({ recordMuxMediaEvent: mocks.record }));

const secret = "local-mux-webhook-secret";
const nowSeconds = Math.floor(Date.now() / 1000).toString();
function request(payload: Record<string, unknown>, signature?: string) {
  const body = JSON.stringify(payload);
  return new Request("http://localhost/api/webhooks/mux", { method: "POST", headers: { "content-type": "application/json", ...(signature === undefined ? {} : { "mux-signature": signature }) }, body });
}
function signed(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  return request(payload, `t=${nowSeconds},v1=${muxSignature(body, nowSeconds, secret)}`);
}

describe("Mux webhook route", () => {
  beforeEach(() => {
    process.env.MUX_WEBHOOK_SECRET = secret;
    mocks.record.mockResolvedValue({ matched: true, duplicate: false, assetId: "asset-local", status: "ready" });
  });

  it("rejects unsigned and invalid callbacks before persistence", async () => {
    const { POST } = await import("@/app/api/webhooks/mux/route");
    const payload = { id: "event_123456", type: "video.asset.ready", data: { id: "asset_123456", playback_ids: [{ id: "playback123456", policy: "public" }] } };
    expect((await POST(request(payload))).status).toBe(401);
    expect((await POST(request(payload, `t=${nowSeconds},v1=${"0".repeat(64)}`))).status).toBe(401);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("validates and records a ready transition with sanitized metadata", async () => {
    const { POST } = await import("@/app/api/webhooks/mux/route");
    const payload = { id: "event_ready_123456", type: "video.asset.ready", created_at: Number(nowSeconds), data: { id: "asset_123456", upload_id: "upload_123456", passthrough: "media_123456", status: "ready", duration: 42.5, aspect_ratio: "16:9", max_stored_resolution: "1080p", playback_ids: [{ id: "playback123456", policy: "public" }], ignored_secret: "must-not-persist" } };
    const response = await POST(signed(payload));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, matched: true, duplicate: false, status: "ready" });
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ providerEventId: "event_ready_123456", eventType: "video.asset.ready", providerAssetId: "asset_123456", providerUploadId: "upload_123456", playbackId: "playback123456", playbackPolicy: "public", durationSeconds: 42.5, maxResolution: "1080p" }));
    expect(JSON.stringify(mocks.record.mock.calls[0][0])).not.toContain("must-not-persist");
  });

  it("returns the persistence layer's duplicate result without repeating work", async () => {
    mocks.record.mockResolvedValue({ matched: true, duplicate: true, assetId: "asset-local", status: "ready" });
    const { POST } = await import("@/app/api/webhooks/mux/route");
    const payload = { id: "event_duplicate_123456", type: "video.asset.deleted", data: { id: "asset_123456" } };
    const response = await POST(signed(payload));
    expect(await response.json()).toMatchObject({ received: true, duplicate: true, status: "ready" });
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });

  it("rejects a ready callback without public or signed playback metadata", async () => {
    const { POST } = await import("@/app/api/webhooks/mux/route");
    const response = await POST(signed({ id: "event_invalid_123456", type: "video.asset.ready", data: { id: "asset_123456" } }));
    expect(response.status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("redacts provider error detail before recording an errored transition", async () => {
    const { POST } = await import("@/app/api/webhooks/mux/route");
    const payload = { id: "event_error_123456", type: "video.asset.errored", data: { id: "asset_123456", errors: { type: "invalid input", messages: ["secret=https://example.test/token"] } } };
    const response = await POST(signed(payload));
    expect(response.status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "INVALID_INPUT", errorMessage: "Mux reported a video processing failure." }));
    expect(JSON.stringify(mocks.record.mock.calls[0][0])).not.toContain("example.test/token");
  });
});
