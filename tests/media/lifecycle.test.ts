import { describe, expect, it } from "vitest";
import { normalizeSiteData } from "@/lib/site-content";
import { referencedUrls, selectOrphanCleanupCandidates } from "@/lib/media/store";
import { siteFixture } from "../fixtures";
import type { MediaItem, MediaStorageObject } from "@/types/site";

const media: MediaItem = { id: "legacy", title: "Legacy image", eventName: "Event", type: "image", url: "/uploads/legacy.jpg", featured: true, published: true };
const object = (overrides: Partial<MediaStorageObject> = {}): MediaStorageObject => ({ id: "object", bucket: "media", objectKey: "images/2026/07/00000000-0000-0000-0000-000000000001.jpg", publicUrl: "/uploads/orphan.jpg", kind: "image", mimeType: "image/jpeg", sizeBytes: 100, status: "orphan", uploadedBy: "admin", createdAt: "2026-07-01T00:00:00Z", orphanedAt: "2026-07-01T00:00:00Z", ...overrides });

describe("media lifecycle", () => {
  it("normalizes legacy media without breaking existing documents", () => expect(normalizeSiteData(siteFixture({ media: [media] })).media[0]).toMatchObject({ altText: "Legacy image", caption: "", order: 0, visibility: "published", aspectRatio: 4 / 3 }));
  it("counts video poster references as protected references", () => expect(referencedUrls([{ ...media, type: "video", posterUrl: "/uploads/poster.jpg" }])).toEqual(new Set(["/uploads/legacy.jpg", "/uploads/poster.jpg"])));
  it("selects only aged, unreferenced orphan objects for cleanup", () => {
    const candidates = selectOrphanCleanupCandidates([object(), object({ id: "new", publicUrl: "/uploads/new.jpg", orphanedAt: "2026-07-22T00:00:00Z" }), object({ id: "used", publicUrl: media.url })], [media], new Date("2026-07-20T00:00:00Z").getTime());
    expect(candidates.map((item) => item.id)).toEqual(["object"]);
  });
});
