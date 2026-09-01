import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveMuxProvider, muxSignature, verifyMuxSignature } from "@/lib/media/mux";
import { nextVideoStatus } from "@/lib/media/video-store";

describe("Mux security and lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MUX_TOKEN_ID;
    delete process.env.MUX_TOKEN_SECRET;
  });

  it("rejects missing, stale and invalid signatures and accepts rotated valid signatures", () => {
    const payload = JSON.stringify({ id: "event_123456", type: "video.asset.ready", data: {} });
    const secret = "local-webhook-secret";
    const timestamp = "1784692800";
    const valid = muxSignature(payload, timestamp, secret);
    expect(verifyMuxSignature(payload, null, secret, 1_784_692_800_000)).toBe(false);
    expect(verifyMuxSignature(payload, `t=${timestamp},v1=${"a".repeat(64)}`, secret, 1_784_692_800_000)).toBe(false);
    expect(verifyMuxSignature(payload, `t=${timestamp},v1=${valid}`, secret, 1_784_700_000_000)).toBe(false);
    expect(verifyMuxSignature(payload, `t=${timestamp},v1=${"b".repeat(64)},v1=${valid}`, secret, 1_784_692_800_000)).toBe(true);
  });

  it("enforces expected lifecycle transitions and keeps deletion terminal", () => {
    expect(nextVideoStatus("video.upload.asset_created", "pending_upload")).toBe("uploaded");
    expect(nextVideoStatus("video.asset.preparing", "uploaded")).toBe("processing");
    expect(nextVideoStatus("video.asset.ready", "processing")).toBe("ready");
    expect(nextVideoStatus("video.asset.errored", "processing")).toBe("failed");
    expect(nextVideoStatus("video.asset.deleted", "ready")).toBe("deleted");
    expect(nextVideoStatus("video.asset.ready", "deleted")).toBe("deleted");
  });

  it("does not return provider response bodies or credentials in errors", async () => {
    process.env.MUX_TOKEN_ID = "token-id-secret-sentinel";
    process.env.MUX_TOKEN_SECRET = "token-secret-sentinel";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "provider-secret-sentinel" }), { status: 400 })));
    const provider = new LiveMuxProvider();
    await expect(provider.createDirectUpload({ mediaItemId: "media_123456", playbackPolicy: "public" })).rejects.toThrow("MUX_PROVIDER_REJECTED");
    try { await provider.createDirectUpload({ mediaItemId: "media_123456", playbackPolicy: "public" }); }
    catch (error) {
      const text = String(error);
      expect(text).not.toContain("token-id-secret-sentinel");
      expect(text).not.toContain("token-secret-sentinel");
      expect(text).not.toContain("provider-secret-sentinel");
    }
  });

  it("creates the expected direct-upload request without exposing credentials to its result", async () => {
    process.env.MUX_TOKEN_ID = "local-token-id";
    process.env.MUX_TOKEN_SECRET = "local-token-secret";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input; void init;
      return new Response(JSON.stringify({ data: { id: "upload_123456", url: "https://upload.mux.invalid/direct" } }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new LiveMuxProvider().createDirectUpload({ mediaItemId: "media_123456", playbackPolicy: "public" });
    expect(result).toEqual({ uploadId: "upload_123456", uploadUrl: "https://upload.mux.invalid/direct", playbackPolicy: "public" });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ new_asset_settings: { passthrough: "media_123456", playback_policies: ["public"] } });
    expect(JSON.stringify(result)).not.toContain("local-token-secret");
  });
});
