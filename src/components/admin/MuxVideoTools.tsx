"use client";
/* eslint-disable @next/next/no-img-element -- administrators preview runtime poster URLs */

import { type ChangeEvent, useEffect, useState } from "react";
import { createUpload, type UpChunk } from "@mux/upchunk";
import { AdaptiveVideoPlayer } from "@/components/AdaptiveVideoPlayer";
import { useAccessibleDialog } from "@/components/AccessibleDialog";
import { mergeVideoAsset, muxPlaybackUrl, resolveVideoPoster } from "@/lib/media/video";
import type { MediaItem, MediaVideoAsset, SiteData } from "@/types/site";

type AdminVideoAsset = Omit<MediaVideoAsset, "providerUploadId" | "providerAssetId"> & { providerUploadIdRedacted: string; providerAssetIdRedacted: string; playbackIdRedacted: string };
type VideoResponse = { asset?: AdminVideoAsset; assets?: AdminVideoAsset[]; uploadUrl?: string; allowedInputTypes?: string[]; maxUploadBytes?: number; provider?: string; simulated?: boolean; error?: string };
const defaultTypes = ["video/mp4", "video/quicktime", "video/webm"];
const uid = () => `media_${crypto.randomUUID()}`;

export function MuxVideoTools({ site, setSite }: { site: SiteData; setSite: (site: SiteData) => void }) {
  const dialog = useAccessibleDialog();
  const [assets, setAssets] = useState<AdminVideoAsset[]>([]);
  const [allowedTypes, setAllowedTypes] = useState(defaultTypes);
  const [maxBytes, setMaxBytes] = useState(5 * 1024 * 1024 * 1024);
  const [provider, setProvider] = useState("local");
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [activeUpload, setActiveUpload] = useState<UpChunk | null>(null);

  useEffect(() => {
    let current = true;
    void fetch("/api/admin/media/video", { cache: "no-store" }).then(async (response) => {
      const body = await response.json() as VideoResponse;
      if (!current) return;
      if (!response.ok) { setStatus(body.error || "Video processing status is unavailable."); return; }
      setAssets(body.assets || []);
      setAllowedTypes(body.allowedInputTypes || defaultTypes);
      setMaxBytes(body.maxUploadBytes || 5 * 1024 * 1024 * 1024);
      setProvider(body.provider || "local");
    }).catch(() => { if (current) setStatus("Video processing status is unavailable."); });
    return () => { current = false; };
  }, []);

  function upsertAsset(asset: AdminVideoAsset) {
    setAssets((current) => [asset, ...current.filter((item) => item.id !== asset.id)]);
  }

  function upsertMedia(asset: AdminVideoAsset, title?: string) {
    const existing = site.media.find((item) => item.id === asset.mediaItemId);
    const timestamp = new Date().toISOString();
    const base: MediaItem = existing || { id: asset.mediaItemId, title: title || "Untitled video", eventName: "Unassigned", type: "video", url: "", caption: "", order: site.media.length, visibility: "draft", featured: false, published: false, createdAt: timestamp, updatedAt: timestamp };
    const merged = { ...mergeVideoAsset(base, asset), updatedAt: timestamp };
    setSite({ ...site, media: existing ? site.media.map((item) => item.id === merged.id ? merged : item) : [...site.media, merged] });
  }

  async function request(body: Record<string, unknown>) {
    const response = await fetch("/api/admin/media/video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json() as VideoResponse;
    if (!response.ok || !result.asset) throw new Error(result.error || "Video action failed.");
    upsertAsset(result.asset);
    return result;
  }

  function beginUpload(file: File, uploadUrl: string, simulated: boolean) {
    if (simulated) { setProgress(0); setStatus("Local simulated upload intent created. No provider request was made."); return; }
    const upload = createUpload({ endpoint: uploadUrl, file, dynamicChunkSize: true, maxFileSize: Math.ceil(maxBytes / 1024) });
    setActiveUpload(upload);
    upload.on("progress", (event) => setProgress(Math.round(Number(event.detail || 0))));
    upload.on("success", () => { setActiveUpload(null); setProgress(100); setStatus("Upload complete. Mux processing updates will arrive by verified webhook."); });
    upload.on("error", () => { setActiveUpload(null); setStatus("Direct upload failed. No provider details were exposed."); });
  }

  async function createIntent(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
    if (!file) return;
    if (!allowedTypes.includes(file.type)) { setStatus(`Choose an allowed video type: ${allowedTypes.join(", ")}.`); return; }
    if (file.size > maxBytes) { setStatus(`Video exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB upload limit.`); return; }
    try {
      const mediaItemId = uid();
      const result = await request({ action: "create", mediaItemId, playbackPolicy: "public", mimeType: file.type, sizeBytes: file.size });
      upsertMedia(result.asset!, file.name.replace(/\.[^.]+$/, "").slice(0, 200));
      beginUpload(file, result.uploadUrl || "", Boolean(result.simulated));
    } catch (error) { setStatus(error instanceof Error ? error.message : "Video upload intent failed."); }
  }

  async function retry(asset: AdminVideoAsset, event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
    if (!file) return;
    if (!allowedTypes.includes(file.type) || file.size > maxBytes) { setStatus("The retry file does not meet the configured type or size limit."); return; }
    try {
      const result = await request({ action: "retry", assetId: asset.id, mimeType: file.type, sizeBytes: file.size });
      upsertMedia(result.asset!);
      beginUpload(file, result.uploadUrl || "", Boolean(result.simulated));
    } catch (error) { setStatus(error instanceof Error ? error.message : "Retry failed."); }
  }

  async function savePoster(asset: AdminVideoAsset) {
    try {
      const result = await request({ action: "poster", assetId: asset.id, manualPosterUrl: asset.manualPosterUrl || "", posterTimeSeconds: asset.posterTimeSeconds });
      upsertMedia(result.asset!); setStatus("Poster settings saved and audited.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Poster update failed."); }
  }

  async function saveCaptions(asset: AdminVideoAsset) {
    try {
      const result = await request({ action: "captions", assetId: asset.id, captions: asset.captions || [] });
      upsertMedia(result.asset!); setStatus("Caption metadata saved and audited.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Caption update failed."); }
  }

  async function remove(asset: AdminVideoAsset) {
    if (!await dialog.confirm({ title: "Delete or archive video?", description: "The provider video will be deleted or archived and the public media reference will be unpublished.", confirmLabel: "Delete video", danger: true })) return;
    try {
      const result = await request({ action: "delete", assetId: asset.id });
      upsertMedia(result.asset!); setStatus("Video deleted and action audited. Save the CMS document to persist its unpublished state.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Video deletion failed."); }
  }

  function patchAsset(id: string, patch: Partial<AdminVideoAsset>) {
    setAssets((current) => current.map((asset) => asset.id === id ? { ...asset, ...patch } : asset));
  }

  return <div className="admin-stack" aria-labelledby="mux-video-heading">
    <div className="admin-card">
      <div className="admin-card-head"><div><strong id="mux-video-heading">Adaptive video processing</strong><small>{provider === "mux" ? "Mux configured" : "Local simulation"}</small></div><label className="button button-primary upload-button">Create video upload<input accept={allowedTypes.join(",")} type="file" onChange={(event) => void createIntent(event)} /></label></div>
      <p>Allowed: {allowedTypes.join(", ")}. Maximum guidance: {Math.round(maxBytes / 1024 / 1024)} MB. Provider secrets remain server-only.</p>
      {activeUpload && <div><progress max={100} value={progress}>{progress}%</progress><button className="button button-ghost" type="button" onClick={() => { activeUpload.abort(); setActiveUpload(null); setStatus("Upload cancelled."); }}>Cancel</button></div>}
      {status && <p className="admin-notice" role="status">{status}</p>}
    </div>
    {assets.map((asset) => {
      const linked = site.media.find((item) => item.id === asset.mediaItemId);
      const merged = linked ? mergeVideoAsset(linked, asset) : undefined;
      const poster = merged ? resolveVideoPoster(merged) : asset.manualPosterUrl || asset.generatedPosterUrl || asset.fallbackPosterUrl;
      return <article className="admin-card admin-stack" key={asset.id}>
        <div className="admin-card-head"><div><strong>{linked?.title || asset.mediaItemId}</strong><small>{asset.status} · upload {asset.providerUploadIdRedacted} · asset {asset.providerAssetIdRedacted} · playback {asset.playbackIdRedacted}</small></div><span className={`event-state state-${asset.status === "ready" ? "upcoming" : asset.status === "failed" ? "cancelled" : "draft"}`}>{asset.status.replaceAll("_", " ")}</span></div>
        <div className="admin-media-preview" style={{ aspectRatio: asset.aspectRatio || 16 / 9 }}><AdaptiveVideoPlayer captions={asset.captions} label={`${linked?.title || "Video"} admin preview`} poster={poster} src={muxPlaybackUrl(asset.playbackId)} status={asset.status} /></div>
        <div className="admin-grid-two">
          <label className="admin-field"><span>Manual poster URL</span><input value={asset.manualPosterUrl || ""} onChange={(event) => patchAsset(asset.id, { manualPosterUrl: event.target.value })} /></label>
          <label className="admin-field"><span>Generated poster time (seconds)</span><input min="0" max="86400" step="0.1" type="number" value={asset.posterTimeSeconds} onChange={(event) => patchAsset(asset.id, { posterTimeSeconds: Number(event.target.value) })} /></label>
        </div>
        <div className="admin-grid-two"><div>{asset.manualPosterUrl && <><small>Manual poster preview</small><img alt="" className="admin-poster-preview" src={asset.manualPosterUrl} /></>}</div><div>{asset.generatedPosterUrl && <><small>Generated poster preview</small><img alt="" className="admin-poster-preview" src={asset.generatedPosterUrl} /></>}</div></div>
        <div className="admin-grid-three">
          <label className="admin-field"><span>Caption URL</span><input value={asset.captions[0]?.src || ""} onChange={(event) => patchAsset(asset.id, { captions: event.target.value ? [{ id: asset.captions[0]?.id || `caption_${asset.id}`, kind: "captions", label: asset.captions[0]?.label || "English captions", language: asset.captions[0]?.language || "en", src: event.target.value, default: true }] : [] })} /></label>
          <label className="admin-field"><span>Caption label</span><input value={asset.captions[0]?.label || ""} onChange={(event) => patchAsset(asset.id, { captions: asset.captions.length ? [{ ...asset.captions[0], label: event.target.value }] : [] })} /></label>
          <label className="admin-field"><span>Language</span><input value={asset.captions[0]?.language || ""} onChange={(event) => patchAsset(asset.id, { captions: asset.captions.length ? [{ ...asset.captions[0], language: event.target.value }] : [] })} /></label>
        </div>
        {asset.processingErrorCode && <p role="status">Processing failed ({asset.processingErrorCode}). {asset.processingErrorMessage}</p>}
        <div className="admin-actions"><button type="button" onClick={() => void savePoster(asset)}>Save poster</button><button type="button" onClick={() => void saveCaptions(asset)}>Save captions</button><button type="button" onClick={() => upsertMedia(asset)}>Apply provider state</button>{asset.status === "failed" && <label className="button button-ghost upload-button">Retry with file<input accept={allowedTypes.join(",")} type="file" onChange={(event) => void retry(asset, event)} /></label>}<button className="danger-link" disabled={asset.status === "deleted"} type="button" onClick={() => void remove(asset)}>Delete/archive</button></div>
      </article>;
    })}
  </div>;
}
