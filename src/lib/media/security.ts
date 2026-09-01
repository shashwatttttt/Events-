export const IMAGE_UPLOAD_LIMIT = 10 * 1024 * 1024;
export const VIDEO_UPLOAD_LIMIT = 50 * 1024 * 1024;
export const MEDIA_REQUEST_LIMIT = VIDEO_UPLOAD_LIMIT + 1024 * 1024;

export type InspectedMedia = {
  kind: "image" | "video";
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/avif" | "video/mp4" | "video/webm";
  extension: "jpg" | "png" | "webp" | "avif" | "mp4" | "webm";
  width?: number;
  height?: number;
};

export class MediaSecurityError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) {
    super(message);
    this.name = "MediaSecurityError";
  }
}

export function assertSafeUploadName(name: string) {
  if (!name || name.length > 255 || /[\x00-\x1f\x7f]/.test(name) || /[\\/]/.test(name) || name === "." || name === ".." || name.includes("..")) {
    throw new MediaSecurityError("MEDIA_FILENAME_INVALID", "The file name is not valid.");
  }
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function jpegDimensions(bytes: Uint8Array) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (length < 2) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8] };
    }
    offset += 2 + length;
  }
  return {};
}

function pngDimensions(bytes: Uint8Array) {
  if (bytes.length < 24) return {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function webpDimensions(bytes: Uint8Array) {
  if (bytes.length < 30 || ascii(bytes, 12, 4) !== "VP8X") return {};
  const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
  const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
  return { width, height };
}

export function inspectMedia(bytes: Uint8Array, declaredMime: string): InspectedMedia {
  let result: InspectedMedia | null = null;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    result = { kind: "image", mimeType: "image/jpeg", extension: "jpg", ...jpegDimensions(bytes) };
  } else if (bytes.length >= 24 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((value, index) => bytes[index] === value)) {
    result = { kind: "image", mimeType: "image/png", extension: "png", ...pngDimensions(bytes) };
  } else if (bytes.length >= 16 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    result = { kind: "image", mimeType: "image/webp", extension: "webp", ...webpDimensions(bytes) };
  } else if (bytes.length >= 16 && ascii(bytes, 4, 4) === "ftyp" && ["avif", "avis"].includes(ascii(bytes, 8, 4))) {
    result = { kind: "image", mimeType: "image/avif", extension: "avif" };
  } else if (bytes.length >= 16 && ascii(bytes, 4, 4) === "ftyp" && /^(isom|iso2|mp4[12]|avc1|M4V |dash)$/.test(ascii(bytes, 8, 4))) {
    result = { kind: "video", mimeType: "video/mp4", extension: "mp4" };
  } else if (bytes.length >= 4 && [0x1a,0x45,0xdf,0xa3].every((value, index) => bytes[index] === value)) {
    result = { kind: "video", mimeType: "video/webm", extension: "webm" };
  }
  if (!result) {
    const code = declaredMime === "image/svg+xml" || ascii(bytes, 0, Math.min(bytes.length, 256)).toLowerCase().includes("<svg")
      ? "MEDIA_SVG_REJECTED" : "MEDIA_SIGNATURE_UNSUPPORTED";
    throw new MediaSecurityError(code, code === "MEDIA_SVG_REJECTED" ? "SVG uploads are not accepted." : "The file signature is not supported.");
  }
  if (declaredMime.toLowerCase() !== result.mimeType) {
    throw new MediaSecurityError("MEDIA_MIME_MISMATCH", "The declared file type does not match its contents.");
  }
  const limit = result.kind === "image" ? IMAGE_UPLOAD_LIMIT : VIDEO_UPLOAD_LIMIT;
  if (bytes.byteLength > limit) throw new MediaSecurityError("MEDIA_TOO_LARGE", `${result.kind === "image" ? "Images" : "Videos"} exceed the upload limit.`, 413);
  if (result.width !== undefined && (result.width < 1 || result.height! < 1 || result.width > 20_000 || result.height! > 20_000)) {
    throw new MediaSecurityError("MEDIA_DIMENSIONS_INVALID", "The image dimensions are not valid.");
  }
  return result;
}
