import { z } from "zod";
import { apiError, noStoreJson, PublicApiError } from "@/lib/http";
import { muxPosterUrl } from "@/lib/media/video";
import { verifyMuxSignature } from "@/lib/media/mux";
import { recordMuxMediaEvent, type MuxMediaEventInput } from "@/lib/media/video-store";

const eventTypes = [
  "video.upload.created", "video.upload.asset_created", "video.upload.cancelled", "video.upload.errored",
  "video.asset.created", "video.asset.preparing", "video.asset.ready", "video.asset.errored", "video.asset.deleted",
] as const;
const eventSchema = z.object({
  id: z.string().trim().min(1).max(200),
  type: z.enum(eventTypes),
  created_at: z.union([z.string(), z.number()]).optional(),
  data: z.record(z.string(), z.unknown()),
}).passthrough();

function identifier(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_-]{1,200}$/.test(text) ? text : undefined;
}

function numberValue(value: unknown, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function aspectRatio(value: unknown) {
  if (typeof value === "string" && /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value)) {
    const [width, height] = value.split(":").map(Number);
    return height > 0 ? numberValue(width / height, 0.1, 10) : undefined;
  }
  return numberValue(value, 0.1, 10);
}

function safeErrorCode(value: unknown) {
  const text = typeof value === "string" ? value.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 100) : "";
  return text || undefined;
}

function safeErrorMessage(value: unknown) {
  const source = Array.isArray(value) ? value.join(" ") : typeof value === "string" ? value : "";
  return source.trim() ? "Mux reported a video processing failure." : undefined;
}

function providerCreatedAt(value: string | number | undefined) {
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}

export async function POST(request: Request) {
  try {
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > 262_144) throw new PublicApiError("PAYLOAD_TOO_LARGE", "The callback was rejected.", 413);
    const payload = await request.text();
    if (Buffer.byteLength(payload) > 262_144) throw new PublicApiError("PAYLOAD_TOO_LARGE", "The callback was rejected.", 413);
    if (!verifyMuxSignature(payload, request.headers.get("mux-signature"), process.env.MUX_WEBHOOK_SECRET)) {
      throw new PublicApiError("INVALID_PROVIDER_SIGNATURE", "The callback signature was rejected.", 401);
    }
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(payload); }
    catch { throw new PublicApiError("INVALID_PROVIDER_CALLBACK", "The callback payload was rejected.", 400); }
    const event = eventSchema.parse(parsedJson);
    const data = event.data;
    const isUpload = event.type.startsWith("video.upload.");
    const playback = Array.isArray(data.playback_ids)
      ? data.playback_ids.find((item) => item && typeof item === "object" && "id" in item) as { id?: unknown; policy?: unknown } | undefined
      : undefined;
    const errors = data.errors && typeof data.errors === "object" ? data.errors as { type?: unknown; messages?: unknown } : undefined;
    const providerAssetId = identifier(isUpload ? data.asset_id : data.id);
    const providerUploadId = identifier(isUpload ? data.id : data.upload_id);
    const playbackId = identifier(playback?.id);
    const playbackPolicy = playback?.policy === "signed" ? "signed" as const : playback?.policy === "public" ? "public" as const : undefined;
    const durationSeconds = numberValue(data.duration, 0, 86400);
    const ratio = aspectRatio(data.aspect_ratio);
    const maxResolution = typeof data.max_stored_resolution === "string" && /^[0-9]{3,4}p$/.test(data.max_stored_resolution) ? data.max_stored_resolution : undefined;
    if ((isUpload && !providerUploadId) || (!isUpload && !providerAssetId) || (event.type === "video.asset.ready" && (!playbackId || !playbackPolicy))) {
      throw new PublicApiError("INVALID_PROVIDER_CALLBACK", "The callback payload was rejected.", 400);
    }
    const input: MuxMediaEventInput = {
      providerEventId: event.id, eventType: event.type, mediaItemId: identifier(data.passthrough), providerUploadId, providerAssetId,
      playbackId, playbackPolicy, durationSeconds, aspectRatio: ratio, maxResolution,
      errorCode: safeErrorCode(errors?.type || data.error_type), errorMessage: safeErrorMessage(errors?.messages || data.error_message),
      sanitizedPayload: {
        status: typeof data.status === "string" ? data.status.slice(0, 80) : null,
        durationSeconds: durationSeconds ?? null,
        aspectRatio: ratio ?? null,
        maxResolution: maxResolution || null,
        playbackPolicy: playbackPolicy || null,
        hasPlayback: Boolean(playbackId),
        generatedPosterAvailable: Boolean(muxPosterUrl(playbackId, 1)),
      },
      providerCreatedAt: providerCreatedAt(event.created_at),
    };
    const result = await recordMuxMediaEvent(input);
    return noStoreJson({ received: true, ...result });
  } catch (error) { return apiError(error); }
}
