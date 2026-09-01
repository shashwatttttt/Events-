import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";

export type MuxUploadIntent = { uploadId: string; uploadUrl: string; playbackPolicy: "public" | "signed" };

export interface MuxProvider {
  readonly name: "local" | "mux";
  createDirectUpload(input: { mediaItemId: string; playbackPolicy: "public" | "signed" }): Promise<MuxUploadIntent>;
  cancelUpload(uploadId: string): Promise<void>;
  deleteAsset(assetId: string): Promise<void>;
}

function muxAuthorization() {
  const tokenId = process.env.MUX_TOKEN_ID;
  const tokenSecret = process.env.MUX_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) throw new Error("MUX_PROVIDER_CONFIGURATION");
  return `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64")}`;
}

async function muxRequest(path: string, init: RequestInit) {
  try {
    return await fetch(`https://api.mux.com/video/v1/${path}`, {
      ...init,
      headers: { Authorization: muxAuthorization(), "Content-Type": "application/json", ...(init.headers || {}) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "MUX_PROVIDER_CONFIGURATION") throw error;
    throw new Error("MUX_PROVIDER_UNAVAILABLE");
  }
}

export class LocalMuxProvider implements MuxProvider {
  readonly name = "local" as const;
  async createDirectUpload(input: { playbackPolicy: "public" | "signed" }): Promise<MuxUploadIntent> {
    const id = crypto.randomUUID().replaceAll("-", "");
    return { uploadId: `localupload${id}`, uploadUrl: `https://upload.mux.invalid/${id}`, playbackPolicy: input.playbackPolicy };
  }
  async cancelUpload() {}
  async deleteAsset() {}
}

export class LiveMuxProvider implements MuxProvider {
  readonly name = "mux" as const;
  async createDirectUpload(input: { mediaItemId: string; playbackPolicy: "public" | "signed" }): Promise<MuxUploadIntent> {
    const response = await muxRequest("uploads", {
      method: "POST",
      body: JSON.stringify({ cors_origin: config.siteUrl, new_asset_settings: { passthrough: input.mediaItemId, playback_policies: [input.playbackPolicy] } }),
    });
    if (!response.ok) throw new Error(response.status === 429 || response.status >= 500 ? "MUX_PROVIDER_TEMPORARY" : "MUX_PROVIDER_REJECTED");
    const payload = await response.json() as { data?: { id?: string; url?: string } };
    if (!payload.data?.id || !payload.data.url) throw new Error("MUX_PROVIDER_INVALID_RESPONSE");
    return { uploadId: payload.data.id.slice(0, 200), uploadUrl: payload.data.url, playbackPolicy: input.playbackPolicy };
  }
  async cancelUpload(uploadId: string) {
    const response = await muxRequest(`uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error(response.status >= 500 ? "MUX_PROVIDER_TEMPORARY" : "MUX_PROVIDER_REJECTED");
  }
  async deleteAsset(assetId: string) {
    const response = await muxRequest(`assets/${encodeURIComponent(assetId)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error(response.status >= 500 ? "MUX_PROVIDER_TEMPORARY" : "MUX_PROVIDER_REJECTED");
  }
}

export function configuredMuxProvider(): MuxProvider {
  return config.mediaVideoProvider === "mux" ? new LiveMuxProvider() : new LocalMuxProvider();
}

export function muxSignature(payload: string, timestamp: string, secret: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
}

export function verifyMuxSignature(payload: string, header: string | null, secret: string | undefined, nowMs = Date.now()) {
  if (!header || !secret) return false;
  const parts = header.split(",").map((part) => part.trim().split("=", 2) as [string, string]);
  const timestamp = parts.find(([key]) => key === "t")?.[1] || "";
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!/^\d{10}$/.test(timestamp) || !signatures.some((value) => /^[a-f0-9]{64}$/i.test(value))) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > 300) return false;
  const expectedBuffer = Buffer.from(muxSignature(payload, timestamp, secret), "hex");
  return signatures.some((supplied) => {
    if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
    const suppliedBuffer = Buffer.from(supplied, "hex");
    return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
  });
}

export function redactProviderId(value?: string) {
  if (!value) return "-";
  if (value.length <= 10) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}
