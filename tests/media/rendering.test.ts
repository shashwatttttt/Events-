import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LoopingMedia, shouldAutoPlayMedia } from "@/components/LoopingMedia";
import { MediaGrid } from "@/components/MediaGrid";
import type { MediaItem } from "@/types/site";

const video: MediaItem = { id: "video", title: "Loop", eventName: "Event", type: "video", url: "/uploads/videos/loop.mp4", posterUrl: "/uploads/images/poster.jpg", caption: "A room in motion", order: 0, aspectRatio: 16 / 9, featured: false, published: true };
const image: MediaItem = { id: "image", title: "Still", eventName: "Event", type: "image", url: "/uploads/images/still.jpg", altText: "Crowd beneath blue lights", width: 1200, height: 800, order: 1, featured: false, published: true };

describe("public looping media", () => {
  it("renders native looping and poster attributes", () => {
    const markup = renderToStaticMarkup(createElement(LoopingMedia, { src: video.url, poster: video.posterUrl, label: video.title }));
    expect(markup).toContain("muted"); expect(markup).toContain("loop"); expect(markup).toContain("playsInline");
    expect(markup).not.toContain("autoPlay"); expect(markup).toContain("controls"); expect(markup).toContain("poster=\"/uploads/images/poster.jpg\"");
  });
  it("pauses for reduced motion, data saving and off-screen media", () => {
    expect(shouldAutoPlayMedia({ reducedMotion: true, saveData: false, visible: true })).toBe(false);
    expect(shouldAutoPlayMedia({ reducedMotion: false, saveData: true, visible: true })).toBe(false);
    expect(shouldAutoPlayMedia({ reducedMotion: false, saveData: false, visible: false })).toBe(false);
    expect(shouldAutoPlayMedia({ reducedMotion: false, saveData: false, visible: true })).toBe(true);
  });
  it("renders dimensions, lazy loading, alt text and bounded responsive markup", () => {
    const markup = renderToStaticMarkup(createElement(MediaGrid, { items: [video, image, { ...image, id: "draft", published: false }] }));
    expect(markup).toContain("width=\"1200\""); expect(markup).toContain("height=\"800\""); expect(markup).toContain("loading=\"lazy\"");
    expect(markup).toContain("alt=\"Crowd beneath blue lights\""); expect(markup).toContain("aspect-ratio"); expect(markup).not.toContain("draft");
  });
  it("contains narrow page heroes instead of hiding horizontal overflow", () => {
    const css = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
    expect(css).toMatch(/html,\s*body\s*\{[^}]*overflow-x:\s*clip/);
    expect(css).toMatch(/\.page-hero-inner\s*>\s*h1,[^{]*\.page-hero-inner\s*>\s*p:last-child\s*\{[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/);
  });
});
