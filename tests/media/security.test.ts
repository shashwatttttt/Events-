import { describe, expect, it } from "vitest";
import { assertSafeUploadName, IMAGE_UPLOAD_LIMIT, inspectMedia } from "@/lib/media/security";

function png(width = 640, height = 360) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}

describe("media signature policy", () => {
  it("accepts PNG and returns image metadata", () => expect(inspectMedia(png(), "image/png")).toMatchObject({ kind: "image", extension: "png", width: 640, height: 360 }));
  it("accepts JPEG, WebP and AVIF signatures", () => {
    expect(inspectMedia(Uint8Array.from([0xff,0xd8,0xff,0xe0,0,2,0xff,0xc0,0,9,8,1,44,2,88,3,1,0]), "image/jpeg")).toMatchObject({ extension: "jpg", width: 600, height: 300 });
    const webp = new Uint8Array(30); webp.set([...Buffer.from("RIFF")], 0); webp.set([...Buffer.from("WEBPVP8X")], 8); webp.set([0x7f,0x02,0,0x67,0x01,0], 24);
    expect(inspectMedia(webp, "image/webp")).toMatchObject({ extension: "webp", width: 640, height: 360 });
    const avif = new Uint8Array(16); avif.set([...Buffer.from("ftypavif")], 4);
    expect(inspectMedia(avif, "image/avif")).toMatchObject({ extension: "avif" });
  });
  it("accepts MP4 and WebM signatures as video", () => {
    const mp4 = new Uint8Array(16); mp4.set([...Buffer.from("ftypisom")], 4);
    expect(inspectMedia(mp4, "video/mp4")).toMatchObject({ kind: "video", extension: "mp4" });
    expect(inspectMedia(Uint8Array.from([0x1a,0x45,0xdf,0xa3]), "video/webm")).toMatchObject({ kind: "video", extension: "webm" });
  });
  it("rejects a declared MIME mismatch", () => expect(() => inspectMedia(png(), "image/jpeg")).toThrowError(expect.objectContaining({ code: "MEDIA_MIME_MISMATCH" })));
  it("rejects SVG by declaration or signature", () => {
    expect(() => inspectMedia(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "image/svg+xml")).toThrowError(expect.objectContaining({ code: "MEDIA_SVG_REJECTED" }));
  });
  it("enforces the separate image size limit", () => {
    const bytes = new Uint8Array(IMAGE_UPLOAD_LIMIT + 1); bytes.set([0xff,0xd8,0xff]);
    expect(() => inspectMedia(bytes, "image/jpeg")).toThrowError(expect.objectContaining({ code: "MEDIA_TOO_LARGE", status: 413 }));
  });
  it.each(["../photo.jpg", "folder/photo.jpg", "folder\\photo.jpg", "bad\0name.jpg", ".."])("rejects unsafe filename %s", (name) => expect(() => assertSafeUploadName(name)).toThrowError(expect.objectContaining({ code: "MEDIA_FILENAME_INVALID" })));
  it("accepts a display-only filename while ignoring its extension for storage", () => expect(() => assertSafeUploadName("Night 01.final.JPG")).not.toThrow());
});
