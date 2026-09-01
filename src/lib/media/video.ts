import type { MediaCaptionTrack, MediaItem, MediaVideoAsset } from "@/types/site";

const muxIdPattern = /^[A-Za-z0-9]{6,200}$/;

export function muxPlaybackUrl(playbackId?: string) {
  return playbackId && muxIdPattern.test(playbackId) ? `https://stream.mux.com/${playbackId}.m3u8` : "";
}

export function muxPosterUrl(playbackId: string | undefined, timeSeconds: number) {
  if (!playbackId || !muxIdPattern.test(playbackId) || !Number.isFinite(timeSeconds) || timeSeconds < 0) return "";
  return `https://image.mux.com/${playbackId}/thumbnail.webp?time=${Number(timeSeconds.toFixed(3))}&fit_mode=preserve`;
}

export function resolveVideoPoster(input: Pick<MediaItem, "manualPosterUrl" | "posterUrl" | "generatedPosterUrl" | "fallbackPosterUrl">) {
  return input.manualPosterUrl?.trim() || input.generatedPosterUrl?.trim() || input.fallbackPosterUrl?.trim() || input.posterUrl?.trim() || "";
}

export function videoIsPubliclyRenderable(item: Pick<MediaItem, "type" | "published" | "provider" | "processingStatus" | "playbackId" | "playbackPolicy" | "url">) {
  if (item.type !== "video" || !item.published) return false;
  if (item.provider !== "mux") return Boolean(item.url);
  return item.processingStatus === "ready" && item.playbackPolicy === "public" && Boolean(item.playbackId);
}

export function mergeVideoAsset(item: MediaItem, asset: Omit<MediaVideoAsset, "providerUploadId" | "providerAssetId"> & Partial<Pick<MediaVideoAsset, "providerUploadId" | "providerAssetId">>): MediaItem {
  return {
    ...item,
    provider: "mux",
    processingStatus: asset.status,
    playbackId: asset.playbackId,
    playbackPolicy: asset.playbackPolicy,
    durationSeconds: asset.durationSeconds,
    aspectRatio: asset.aspectRatio || item.aspectRatio,
    maxResolution: asset.maxResolution,
    processingErrorCode: asset.processingErrorCode,
    processingErrorMessage: asset.processingErrorMessage,
    generatedPosterUrl: asset.generatedPosterUrl,
    posterTimeSeconds: asset.posterTimeSeconds,
    manualPosterUrl: asset.manualPosterUrl || item.manualPosterUrl || item.posterUrl,
    fallbackPosterUrl: asset.fallbackPosterUrl || item.fallbackPosterUrl,
    captions: asset.captions,
    url: asset.status === "ready" ? muxPlaybackUrl(asset.playbackId) : item.url,
  };
}

export function normalizedCaptionTracks(tracks: MediaCaptionTrack[] | undefined) {
  return (tracks || []).filter((track) => track.id && track.label.trim() && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(track.language) && (track.src.startsWith("/") || /^https:\/\//.test(track.src))).slice(0, 10);
}
