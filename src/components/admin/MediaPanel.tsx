"use client";
/* eslint-disable @next/next/no-img-element -- administrators preview runtime storage URLs */

import { type ChangeEvent, useRef, useState } from "react";
import { useAccessibleDialog } from "@/components/AccessibleDialog";
import { MuxVideoTools } from "@/components/admin/MuxVideoTools";
import type { MediaItem, SiteData } from "@/types/site";

type UploadResult = { url: string; kind: "image" | "video"; mimeType: string; sizeBytes: number; width?: number; height?: number };
type RetryUpload = { file: File; purpose: "media" | "poster"; itemId?: string };
const acceptedImages = "image/jpeg,image/png,image/webp,image/avif";
const acceptedMedia = `${acceptedImages},video/mp4,video/webm`;
const uid = () => `media_${crypto.randomUUID()}`;

export function MediaPanel({ site, setSite }: { site: SiteData; setSite: (site: SiteData) => void }) {
  const dialog = useAccessibleDialog();
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [lastUpload, setLastUpload] = useState<RetryUpload | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  function patchItem(id: string, patch: Partial<MediaItem>) {
    setSite({ ...site, media: site.media.map((item) => item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item) });
  }

  function move(id: string, direction: -1 | 1) {
    const ordered = [...site.media].sort((left, right) => (left.order || 0) - (right.order || 0));
    const index = ordered.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    setSite({ ...site, media: ordered.map((item, order) => ({ ...item, order, updatedAt: new Date().toISOString() })) });
  }

  function uploadFile({ file, purpose, itemId }: RetryUpload) {
    setLastUpload({ file, purpose, itemId });
    setUploading(true); setProgress(0); setStatus("Uploading...");
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    const data = new FormData(); data.append("file", file); data.append("purpose", purpose);
    xhr.open("POST", "/api/admin/upload");
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) setProgress(Math.round((event.loaded / event.total) * 100)); };
    xhr.onerror = () => { setUploading(false); setStatus("Upload failed. Retry when the connection is available."); };
    xhr.onabort = () => { setUploading(false); setStatus("Upload cancelled."); };
    xhr.onload = () => {
      setUploading(false); xhrRef.current = null;
      let body: UploadResult & { error?: string };
      try { body = JSON.parse(xhr.responseText); } catch { setStatus("Upload returned an invalid response."); return; }
      if (xhr.status < 200 || xhr.status >= 300) { setStatus(body.error || "Upload failed."); return; }
      const timestamp = new Date().toISOString();
      if (purpose === "poster" && itemId) {
        patchItem(itemId, { posterUrl: body.url });
        setStatus("Poster uploaded. Save changes to attach it.");
        return;
      }
      if (itemId) {
        patchItem(itemId, { url: body.url, type: body.kind === "video" ? "video" : "image", mimeType: body.mimeType, sizeBytes: body.sizeBytes, width: body.width, height: body.height, aspectRatio: body.width && body.height ? body.width / body.height : undefined });
        setStatus("Replacement uploaded. Save changes to update the reference.");
        return;
      }
      const title = file.name.replace(/\.[^.]+$/, "").slice(0, 200) || "Untitled media";
      const item: MediaItem = { id: uid(), title, eventName: "Unassigned", type: body.kind === "video" ? "video" : "image", url: body.url,
        caption: "", altText: body.kind === "image" ? title : "", posterUrl: "", order: site.media.length, visibility: "draft",
        mimeType: body.mimeType, sizeBytes: body.sizeBytes, width: body.width, height: body.height,
        aspectRatio: body.width && body.height ? body.width / body.height : 4 / 3, featured: false, published: false, createdAt: timestamp, updatedAt: timestamp };
      setSite({ ...site, media: [...site.media, item] });
      setStatus("Uploaded. Add metadata and save changes before publishing.");
    };
    xhr.send(data);
  }

  function selectUpload(event: ChangeEvent<HTMLInputElement>, purpose: "media" | "poster", itemId?: string) {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
    if (file) uploadFile({ file, purpose, itemId });
  }

  async function cleanup() {
    if (!await dialog.confirm({ title: "Clean old orphaned uploads?", description: "Delete eligible unreferenced uploads older than 24 hours? Referenced media is preserved.", confirmLabel: "Clean old orphans", danger: true })) return;
    const response = await fetch("/api/admin/upload", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cleanup", minimumAgeHours: 24 }) });
    const body = await response.json();
    setStatus(response.ok ? `Orphan cleanup inspected ${body.inspected} and deleted ${body.deleted}.` : body.error || "Orphan cleanup failed.");
  }

  async function removeReference(item: MediaItem) {
    if (!await dialog.confirm({ title: "Remove media reference?", description: `Remove ${item.title} from the CMS document? The underlying upload is not deleted until a separately confirmed orphan cleanup.`, confirmLabel: "Remove reference", danger: true })) return;
    setSite({ ...site, media: site.media.filter((media) => media.id !== item.id).map((media, order) => ({ ...media, order })) });
    setStatus("Reference removed. Save before running orphan cleanup.");
  }

  const imageChoices = site.media.filter((item) => item.type === "image" && item.url);
  return <section className="admin-section admin-stack">
    <div className="admin-section-title"><div><h2>Media</h2><p>Signature-verified images and looping video. New files stay unpublished until this versioned CMS document is saved.</p></div><div className="admin-actions"><label className={`button button-primary upload-button${uploading ? " is-disabled" : ""}`}>Upload image/video<input disabled={uploading} type="file" accept={acceptedMedia} onChange={(event) => selectUpload(event, "media")} /></label><button className="button button-ghost" disabled={uploading} onClick={() => void cleanup()} type="button">Clean old orphans</button></div></div>
    {uploading && <div className="admin-card"><progress max={100} value={progress}>{progress}%</progress><span>{progress}%</span><button className="button button-ghost" onClick={() => xhrRef.current?.abort()} type="button">Cancel upload</button></div>}
    {!uploading && lastUpload && status.toLowerCase().includes("fail") && <button className="button button-ghost" onClick={() => uploadFile(lastUpload)} type="button">Retry upload</button>}
    {status && <p className="admin-notice" role="status">{status}</p>}
    <MuxVideoTools site={site} setSite={setSite} />
    <div className="admin-product-grid">{[...site.media].sort((left, right) => (left.order || 0) - (right.order || 0)).map((item, index) => <article className="admin-card admin-stack" key={item.id}>
      <div className="admin-card-head"><strong>{item.title}</strong><span>{item.type} · {item.published ? "published" : "draft"}</span></div>
      <div className="admin-media-preview" style={{ aspectRatio: item.aspectRatio || 4 / 3 }}>{item.type === "video" ? <video controls muted playsInline poster={item.posterUrl || undefined} preload="metadata" src={item.url} /> : <img alt={item.altText || ""} src={item.url} />}</div>
      <div className="admin-actions"><button disabled={index === 0} onClick={() => move(item.id, -1)} type="button">Move up</button><button disabled={index === site.media.length - 1} onClick={() => move(item.id, 1)} type="button">Move down</button><label className="button button-ghost upload-button">Replace<input type="file" accept={acceptedMedia} onChange={(event) => selectUpload(event, "media", item.id)} /></label><button className="danger-link" onClick={() => void removeReference(item)} type="button">Remove reference</button></div>
      <div className="admin-grid-two"><label className="admin-field"><span>Title</span><input value={item.title} onChange={(event) => patchItem(item.id, { title: event.target.value })} /></label><label className="admin-field"><span>Event</span><select value={item.eventId || ""} onChange={(event) => { const selected = site.events.find((candidate) => candidate.id === event.target.value); patchItem(item.id, { eventId: selected?.id, eventName: selected?.title || "Unassigned" }); }}><option value="">Unassigned</option>{site.events.map((event) => <option key={event.id} value={event.id}>{event.title}</option>)}</select></label></div>
      <label className="admin-field"><span>Caption</span><textarea value={item.caption || ""} onChange={(event) => patchItem(item.id, { caption: event.target.value })} /></label>
      {item.type === "image" && <label className="admin-field"><span>Alt text</span><input value={item.altText || ""} onChange={(event) => patchItem(item.id, { altText: event.target.value })} /></label>}
      {item.type === "video" && <><label className="admin-field"><span>Poster image</span><select value={item.posterUrl || ""} onChange={(event) => patchItem(item.id, { posterUrl: event.target.value })}><option value="">No poster selected</option>{imageChoices.map((image) => <option key={image.id} value={image.url}>{image.title}</option>)}</select></label><label className="button button-ghost upload-button">Upload poster<input type="file" accept={acceptedImages} onChange={(event) => selectUpload(event, "poster", item.id)} /></label></>}
      <label className="admin-field"><span>Asset URL (server assigned)</span><input readOnly value={item.url} /></label>
      <div className="admin-grid-two"><label className="admin-field"><span>Focal X (0–1)</span><input min="0" max="1" step="0.01" type="number" value={item.focalX ?? 0.5} onChange={(event) => patchItem(item.id, { focalX: Number(event.target.value) })} /></label><label className="admin-field"><span>Focal Y (0–1)</span><input min="0" max="1" step="0.01" type="number" value={item.focalY ?? 0.5} onChange={(event) => patchItem(item.id, { focalY: Number(event.target.value) })} /></label></div>
      <div className="toggle-row"><label><input checked={item.published} type="checkbox" onChange={(event) => patchItem(item.id, { published: event.target.checked, visibility: event.target.checked ? "published" : "draft" })} /> Published</label><label><input checked={item.featured} type="checkbox" onChange={(event) => patchItem(item.id, { featured: event.target.checked })} /> Featured</label></div>
    </article>)}</div>
  </section>;
}
