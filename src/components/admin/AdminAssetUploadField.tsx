"use client";

import { type ChangeEvent, useId, useState } from "react";

type AdminAssetUploadFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  accept?: string;
  helperText?: string;
  previewType?: "image" | "video" | "auto";
};

type UploadState = "idle" | "uploading" | "uploaded" | "error";

function detectedPreviewType(value: string) {
  const path = value.split(/[?#]/, 1)[0].toLowerCase();
  if (/\.(mp4|webm)$/.test(path)) return "video";
  if (/\.(avif|gif|jpe?g|png|svg|webp)$/.test(path)) return "image";
  return null;
}

export function AdminAssetUploadField({
  label,
  value,
  onChange,
  accept,
  helperText,
  previewType = "auto",
}: AdminAssetUploadFieldProps) {
  const fieldId = useId();
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [status, setStatus] = useState("");
  const resolvedPreviewType = value
    ? previewType === "auto"
      ? detectedPreviewType(value)
      : previewType
    : null;

  function updateUrl(nextValue: string) {
    setUploadState("idle");
    setStatus("");
    onChange(nextValue);
  }

  function clearValue() {
    onChange("");
    setUploadState("idle");
    setStatus("Media removed. Save changes to keep this update.");
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    setUploadState("uploading");
    setStatus("Uploading...");
    const data = new FormData();
    data.append("file", file);

    try {
      const response = await fetch("/api/admin/upload", {
        method: "POST",
        body: data,
      });
      const body = await response.json().catch(() => ({})) as {
        error?: unknown;
        url?: unknown;
      };

      if (!response.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Upload failed.");
      }
      if (typeof body.url !== "string" || !body.url) {
        throw new Error("Upload completed without a usable URL.");
      }

      onChange(body.url);
      setUploadState("uploaded");
      setStatus("Uploaded. Save changes to keep this URL.");
    } catch (error) {
      setUploadState("error");
      setStatus(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      input.value = "";
    }
  }

  return (
    <div className="admin-field admin-asset-upload-field">
      <label htmlFor={`${fieldId}-url`}>{label}</label>
      <div className="admin-asset-upload-controls">
        <input
          id={`${fieldId}-url`}
          type="text"
          value={value}
          disabled={uploadState === "uploading"}
          onChange={(event) => updateUrl(event.target.value)}
          placeholder="Paste a URL or upload a file"
        />
        <label
          className={`upload-button${uploadState === "uploading" ? " is-disabled" : ""}`}
          aria-disabled={uploadState === "uploading"}
        >
          {uploadState === "uploading" ? "Uploading..." : "Upload"}
          <input
            type="file"
            accept={accept}
            disabled={uploadState === "uploading"}
            onChange={upload}
          />
        </label>
        {value && (
          <button
            className="admin-asset-clear"
            type="button"
            disabled={uploadState === "uploading"}
            onClick={clearValue}
          >
            Clear
          </button>
        )}
      </div>
      {helperText && <small className="admin-asset-helper">{helperText}</small>}
      {status && (
        <small
          className={`admin-asset-status is-${uploadState}`}
          role={uploadState === "error" ? "alert" : "status"}
        >
          {status}
        </small>
      )}
      {resolvedPreviewType === "image" && (
        // The URL is user-configurable, so a native preview avoids restricting admin URLs to Next image hosts.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="admin-asset-preview" src={value} alt={`${label} preview`} />
      )}
      {resolvedPreviewType === "video" && (
        <video className="admin-asset-preview" src={value} controls preload="metadata">
          Your browser does not support video previews.
        </video>
      )}
    </div>
  );
}
