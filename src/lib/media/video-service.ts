import "server-only";

import { config } from "@/lib/config";
import { readSiteData } from "@/lib/data/documents";
import { PublicApiError } from "@/lib/http";
import { configuredMuxProvider } from "@/lib/media/mux";
import { createVideoAssetRecord, listVideoAssets, manageVideoAsset } from "@/lib/media/video-store";
import { normalizedCaptionTracks } from "@/lib/media/video";
import type { MediaCaptionTrack, SessionUser } from "@/types/site";

function validOptionalUrl(value?: string) {
  if (!value) return undefined;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && !(config.appMode !== "live" && url.protocol === "http:")) throw new Error();
    return value;
  } catch { throw new PublicApiError("MEDIA_URL_INVALID", "The media URL is invalid.", 422); }
}

async function assertMediaLink(mediaItemId: string, eventId?: string) {
  const site = await readSiteData();
  if (eventId && !site.events.some((event) => event.id === eventId)) throw new PublicApiError("MEDIA_EVENT_INVALID", "The selected event does not exist.", 422);
  const existing = site.media.find((item) => item.id === mediaItemId);
  if (existing && existing.type !== "video") throw new PublicApiError("MEDIA_ITEM_TYPE_CONFLICT", "That media ID belongs to an image.", 409);
  if (existing?.eventId && eventId && existing.eventId !== eventId) throw new PublicApiError("MEDIA_EVENT_CONFLICT", "The video is linked to a different event.", 409);
}

function assertUploadFile(mimeType: string, sizeBytes: number) {
  if (!config.mediaVideoAllowedInputTypes.includes(mimeType.toLowerCase())) throw new PublicApiError("MEDIA_VIDEO_TYPE_NOT_ALLOWED", "That video type is not allowed.", 422);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > config.mediaVideoMaxUploadBytes) throw new PublicApiError("MEDIA_VIDEO_SIZE_INVALID", "That video does not meet the configured size limit.", 413);
}

export async function createVideoUploadIntent(actor: SessionUser, input: { mediaItemId: string; eventId?: string; fallbackPosterUrl?: string; playbackPolicy?: "public" | "signed"; mimeType: string; sizeBytes: number }) {
  assertUploadFile(input.mimeType, input.sizeBytes);
  await assertMediaLink(input.mediaItemId, input.eventId);
  const fallbackPosterUrl = validOptionalUrl(input.fallbackPosterUrl);
  const playbackPolicy = input.playbackPolicy || config.muxDefaultPlaybackPolicy;
  const provider = configuredMuxProvider();
  const intent = await provider.createDirectUpload({ mediaItemId: input.mediaItemId, playbackPolicy });
  try {
    const asset = await createVideoAssetRecord(actor, { mediaItemId: input.mediaItemId, eventId: input.eventId, uploadId: intent.uploadId, playbackPolicy, fallbackPosterUrl });
    return { asset, uploadUrl: intent.uploadUrl, allowedInputTypes: config.mediaVideoAllowedInputTypes, maxUploadBytes: config.mediaVideoMaxUploadBytes, simulated: provider.name === "local" };
  } catch (error) {
    await provider.cancelUpload(intent.uploadId).catch(() => undefined);
    throw error;
  }
}

export async function retryVideoUpload(actor: SessionUser, assetId: string, file: { mimeType: string; sizeBytes: number }) {
  assertUploadFile(file.mimeType, file.sizeBytes);
  const current = (await listVideoAssets()).find((item) => item.id === assetId);
  if (!current) throw new PublicApiError("MEDIA_VIDEO_NOT_FOUND", "The video was not found.", 404);
  if (current.status !== "failed") throw new PublicApiError("MEDIA_VIDEO_NOT_RETRYABLE", "Only failed processing can be retried.", 409);
  const provider = configuredMuxProvider();
  const intent = await provider.createDirectUpload({ mediaItemId: current.mediaItemId, playbackPolicy: current.playbackPolicy });
  try {
    const asset = await manageVideoAsset(actor, assetId, { action: "retry", uploadId: intent.uploadId });
    return { asset, uploadUrl: intent.uploadUrl, allowedInputTypes: config.mediaVideoAllowedInputTypes, maxUploadBytes: config.mediaVideoMaxUploadBytes, simulated: provider.name === "local" };
  } catch (error) {
    await provider.cancelUpload(intent.uploadId).catch(() => undefined);
    throw error;
  }
}

export async function updateVideoPoster(actor: SessionUser, assetId: string, input: { manualPosterUrl?: string; posterTimeSeconds: number }) {
  return manageVideoAsset(actor, assetId, { action: "poster", manualPosterUrl: validOptionalUrl(input.manualPosterUrl), posterTimeSeconds: input.posterTimeSeconds });
}

export async function updateVideoCaptions(actor: SessionUser, assetId: string, captions: MediaCaptionTrack[]) {
  const normalized = normalizedCaptionTracks(captions);
  if (normalized.length !== captions.length) throw new PublicApiError("MEDIA_CAPTIONS_INVALID", "One or more caption tracks are invalid.", 422);
  if (normalized.filter((track) => track.default).length > 1) throw new PublicApiError("MEDIA_CAPTIONS_INVALID", "Only one caption track can be the default.", 422);
  return manageVideoAsset(actor, assetId, { action: "captions", captions: normalized });
}

export async function deleteVideoAsset(actor: SessionUser, assetId: string) {
  const current = (await listVideoAssets()).find((item) => item.id === assetId);
  if (!current) throw new PublicApiError("MEDIA_VIDEO_NOT_FOUND", "The video was not found.", 404);
  const provider = configuredMuxProvider();
  if (current.providerAssetId) await provider.deleteAsset(current.providerAssetId);
  else await provider.cancelUpload(current.providerUploadId);
  return manageVideoAsset(actor, assetId, { action: "delete" });
}
