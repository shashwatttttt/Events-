import "server-only";

import { config } from "@/lib/config";
import { mutateOperationsData, readOperationsData } from "@/lib/data/documents";
import { PublicApiError } from "@/lib/http";
import { muxPosterUrl } from "@/lib/media/video";
import { randomId } from "@/lib/security/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { MediaCaptionTrack, MediaVideoAsset, SessionUser } from "@/types/site";

export type MuxMediaEventInput = {
  providerEventId: string;
  eventType: "video.upload.created" | "video.upload.asset_created" | "video.upload.cancelled" | "video.upload.errored" | "video.asset.created" | "video.asset.preparing" | "video.asset.ready" | "video.asset.errored" | "video.asset.deleted";
  mediaItemId?: string;
  providerUploadId?: string;
  providerAssetId?: string;
  playbackId?: string;
  playbackPolicy?: "public" | "signed";
  durationSeconds?: number;
  aspectRatio?: number;
  maxResolution?: string;
  errorCode?: string;
  errorMessage?: string;
  sanitizedPayload: Record<string, string | number | boolean | null>;
  providerCreatedAt?: string;
};

function mapAsset(row: Record<string, unknown>): MediaVideoAsset {
  return {
    id: String(row.id), mediaItemId: String(row.media_item_id), eventId: row.event_id ? String(row.event_id) : undefined,
    provider: "mux", status: String(row.status) as MediaVideoAsset["status"], providerUploadId: String(row.provider_upload_id),
    providerAssetId: row.provider_asset_id ? String(row.provider_asset_id) : undefined,
    playbackId: row.playback_id ? String(row.playback_id) : undefined,
    playbackPolicy: String(row.playback_policy) as "public" | "signed",
    durationSeconds: row.duration_seconds === null || row.duration_seconds === undefined ? undefined : Number(row.duration_seconds),
    aspectRatio: row.aspect_ratio === null || row.aspect_ratio === undefined ? undefined : Number(row.aspect_ratio),
    maxResolution: row.max_resolution ? String(row.max_resolution) : undefined,
    processingErrorCode: row.processing_error_code ? String(row.processing_error_code) : undefined,
    processingErrorMessage: row.processing_error_message ? String(row.processing_error_message) : undefined,
    sanitizedMetadata: (row.sanitized_metadata || {}) as MediaVideoAsset["sanitizedMetadata"],
    generatedPosterUrl: row.generated_poster_url ? String(row.generated_poster_url) : undefined,
    posterTimeSeconds: Number(row.poster_time_seconds), manualPosterUrl: row.manual_poster_url ? String(row.manual_poster_url) : undefined,
    fallbackPosterUrl: row.fallback_poster_url ? String(row.fallback_poster_url) : undefined,
    captions: (row.captions || []) as MediaCaptionTrack[], createdBy: String(row.created_by), updatedBy: String(row.updated_by),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), uploadedAt: row.uploaded_at ? String(row.uploaded_at) : undefined,
    readyAt: row.ready_at ? String(row.ready_at) : undefined, failedAt: row.failed_at ? String(row.failed_at) : undefined,
    deletedAt: row.deleted_at ? String(row.deleted_at) : undefined,
  };
}

export async function createVideoAssetRecord(actor: SessionUser, input: { mediaItemId: string; eventId?: string; uploadId: string; playbackPolicy: "public" | "signed"; fallbackPosterUrl?: string }) {
  if (config.dataProvider === "supabase") {
    const { data, error } = await createSupabaseAdminClient().rpc("skie_create_media_video_asset", {
      p_actor_id: actor.id, p_media_item_id: input.mediaItemId, p_event_id: input.eventId || null,
      p_provider_upload_id: input.uploadId, p_playback_policy: input.playbackPolicy,
      p_poster_time_seconds: config.muxPosterDefaultTimeSeconds, p_fallback_poster_url: input.fallbackPosterUrl || null,
    });
    if (error || !data) throw new PublicApiError("MEDIA_VIDEO_REGISTRY_FAILED", "The video upload intent could not be registered.", 503);
    return mapAsset((Array.isArray(data) ? data[0] : data) as Record<string, unknown>);
  }
  return mutateOperationsData((operations) => {
    if (operations.mediaVideoAssets.some((item) => item.mediaItemId === input.mediaItemId || item.providerUploadId === input.uploadId)) throw new PublicApiError("MEDIA_VIDEO_CONFLICT", "This video already has an upload intent.", 409);
    const now = new Date().toISOString();
    const item: MediaVideoAsset = {
      id: randomId("media_video"), mediaItemId: input.mediaItemId, eventId: input.eventId, provider: "mux", status: "pending_upload",
      providerUploadId: input.uploadId, playbackPolicy: input.playbackPolicy, sanitizedMetadata: {}, posterTimeSeconds: config.muxPosterDefaultTimeSeconds,
      fallbackPosterUrl: input.fallbackPosterUrl, captions: [], createdBy: actor.id, updatedBy: actor.id, createdAt: now, updatedAt: now,
    };
    operations.mediaVideoAssets.push(item);
    operations.auditLogs.push({ id: randomId("audit"), actorId: actor.id, actorEmail: actor.email, action: "media.video_upload_intent_created", entityType: "media_video", entityId: item.id, metadata: { mediaItemId: item.mediaItemId, eventId: item.eventId || null, playbackPolicy: item.playbackPolicy }, createdAt: now });
    return item;
  });
}

export async function listVideoAssets() {
  if (config.dataProvider === "supabase") {
    const { data, error } = await createSupabaseAdminClient().from("media_video_assets").select("*").order("created_at", { ascending: false }).limit(500);
    if (error) throw new PublicApiError("MEDIA_VIDEO_LIST_FAILED", "Video processing status is temporarily unavailable.", 503);
    return (data || []).map((row) => mapAsset(row));
  }
  return [...(await readOperationsData()).mediaVideoAssets].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function nextVideoStatus(eventType: MuxMediaEventInput["eventType"], current: MediaVideoAsset["status"]) {
  if (current === "deleted") return "deleted";
  if (eventType === "video.upload.asset_created") return "uploaded";
  if (["video.asset.created", "video.asset.preparing"].includes(eventType)) return "processing";
  if (eventType === "video.asset.ready") return "ready";
  if (["video.upload.cancelled", "video.upload.errored", "video.asset.errored"].includes(eventType)) return "failed";
  if (eventType === "video.asset.deleted") return "deleted";
  return current;
}

export async function recordMuxMediaEvent(input: MuxMediaEventInput) {
  const generatedPosterUrl = muxPosterUrl(input.playbackId, config.muxPosterDefaultTimeSeconds);
  if (config.dataProvider === "supabase") {
    const { data, error } = await createSupabaseAdminClient().rpc("skie_record_mux_media_event", {
      p_provider_event_id: input.providerEventId, p_event_type: input.eventType, p_media_item_id: input.mediaItemId || null,
      p_provider_upload_id: input.providerUploadId || null, p_provider_asset_id: input.providerAssetId || null,
      p_playback_id: input.playbackId || null, p_playback_policy: input.playbackPolicy || null,
      p_duration_seconds: input.durationSeconds ?? null, p_aspect_ratio: input.aspectRatio ?? null,
      p_max_resolution: input.maxResolution || null, p_error_code: input.errorCode || null, p_error_message: input.errorMessage || null,
      p_generated_poster_url: generatedPosterUrl || null, p_sanitized_payload: input.sanitizedPayload,
      p_provider_created_at: input.providerCreatedAt || null,
    });
    if (error) throw new PublicApiError("MUX_EVENT_RECORD_FAILED", "The video update could not be recorded.", 503);
    return data as { matched: boolean; duplicate: boolean; assetId?: string; status?: string };
  }
  return mutateOperationsData((operations) => {
    const duplicate = operations.mediaProviderEvents.some((item) => item.provider === "mux" && item.providerEventId === input.providerEventId);
    const asset = operations.mediaVideoAssets.find((item) =>
      (input.providerUploadId && item.providerUploadId === input.providerUploadId)
      || (input.providerAssetId && item.providerAssetId === input.providerAssetId)
      || (input.mediaItemId && item.mediaItemId === input.mediaItemId));
    if (duplicate) return { matched: Boolean(asset), duplicate: true, assetId: asset?.id, status: asset?.status };
    const now = new Date().toISOString();
    operations.mediaProviderEvents.push({ id: randomId("media_provider_event"), provider: "mux", providerEventId: input.providerEventId, eventType: input.eventType, mediaVideoAssetId: asset?.id, providerCreatedAt: input.providerCreatedAt, receivedAt: now });
    if (!asset) return { matched: false, duplicate: false };
    const status = nextVideoStatus(input.eventType, asset.status);
    asset.status = status; asset.updatedAt = now; asset.sanitizedMetadata = input.sanitizedPayload;
    asset.providerAssetId = input.providerAssetId || asset.providerAssetId;
    if (status === "uploaded") asset.uploadedAt = now;
    if (status === "ready") {
      asset.playbackId = input.playbackId; asset.playbackPolicy = input.playbackPolicy || asset.playbackPolicy;
      asset.durationSeconds = input.durationSeconds; asset.aspectRatio = input.aspectRatio; asset.maxResolution = input.maxResolution;
      asset.generatedPosterUrl = muxPosterUrl(input.playbackId, asset.posterTimeSeconds); asset.readyAt = now;
      asset.processingErrorCode = undefined; asset.processingErrorMessage = undefined;
    }
    if (status === "failed") { asset.processingErrorCode = input.errorCode || "MUX_PROCESSING_FAILED"; asset.processingErrorMessage = input.errorMessage || "Video processing failed."; asset.failedAt = now; }
    if (status === "deleted") asset.deletedAt = now;
    return { matched: true, duplicate: false, assetId: asset.id, status };
  });
}

export async function manageVideoAsset(actor: SessionUser, assetId: string, input:
  | { action: "retry"; uploadId: string }
  | { action: "poster"; manualPosterUrl?: string; posterTimeSeconds: number }
  | { action: "captions"; captions: MediaCaptionTrack[] }
  | { action: "delete" }) {
  if (config.dataProvider === "supabase") {
    const current = (await listVideoAssets()).find((item) => item.id === assetId);
    const generated = input.action === "poster" ? muxPosterUrl(current?.playbackId, input.posterTimeSeconds) : "";
    const { data, error } = await createSupabaseAdminClient().rpc("skie_manage_media_video_asset", {
      p_actor_id: actor.id, p_media_video_asset_id: assetId, p_action: input.action,
      p_provider_upload_id: input.action === "retry" ? input.uploadId : null,
      p_manual_poster_url: input.action === "poster" ? input.manualPosterUrl || null : null,
      p_poster_time_seconds: input.action === "poster" ? input.posterTimeSeconds : null,
      p_generated_poster_url: generated || null,
      p_captions: input.action === "captions" ? input.captions : null,
    });
    if (error || !data) throw new PublicApiError("MEDIA_VIDEO_ACTION_FAILED", "The video action could not be recorded.", 409);
    return mapAsset((Array.isArray(data) ? data[0] : data) as Record<string, unknown>);
  }
  return mutateOperationsData((operations) => {
    const item = operations.mediaVideoAssets.find((candidate) => candidate.id === assetId);
    if (!item) throw new PublicApiError("MEDIA_VIDEO_NOT_FOUND", "The video was not found.", 404);
    const now = new Date().toISOString();
    if (input.action === "retry") {
      if (item.status !== "failed") throw new PublicApiError("MEDIA_VIDEO_NOT_RETRYABLE", "Only failed video processing can be retried.", 409);
      Object.assign(item, { status: "pending_upload", providerUploadId: input.uploadId, providerAssetId: undefined, playbackId: undefined, generatedPosterUrl: undefined, processingErrorCode: undefined, processingErrorMessage: undefined, uploadedAt: undefined, readyAt: undefined, failedAt: undefined, deletedAt: undefined });
    } else if (input.action === "poster") {
      item.manualPosterUrl = input.manualPosterUrl; item.posterTimeSeconds = input.posterTimeSeconds; item.generatedPosterUrl = muxPosterUrl(item.playbackId, input.posterTimeSeconds);
    } else if (input.action === "captions") item.captions = input.captions;
    else { item.status = "deleted"; item.deletedAt = now; }
    item.updatedBy = actor.id; item.updatedAt = now;
    operations.auditLogs.push({ id: randomId("audit"), actorId: actor.id, actorEmail: actor.email, action: `media.video_${input.action}`, entityType: "media_video", entityId: item.id, metadata: { mediaItemId: item.mediaItemId, status: item.status }, createdAt: now });
    return item;
  });
}
