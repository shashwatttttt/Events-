import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdaptiveVideoPlayer, shouldAutoPlayAdaptiveVideo } from "@/components/AdaptiveVideoPlayer";
import { MediaGrid } from "@/components/MediaGrid";
import { muxPlaybackUrl, muxPosterUrl, normalizedCaptionTracks, resolveVideoPoster, videoIsPubliclyRenderable } from "@/lib/media/video";
import type { MediaItem } from "@/types/site";

const muxVideo: MediaItem = { id: "mux-video", title: "Adaptive video", eventName: "Event", type: "video", url: "", provider: "mux", processingStatus: "ready", playbackId: "playback123456", playbackPolicy: "public", generatedPosterUrl: "https://image.mux.com/playback123456/generated.webp", fallbackPosterUrl: "/fallback.jpg", captions: [{ id: "captions-en", kind: "captions", label: "English captions", language: "en-AU", src: "/captions/video.vtt", default: true }], order: 0, aspectRatio: 16 / 9, featured: false, published: true };

describe("adaptive Mux rendering", () => {
  it("selects manual, generated and fallback posters in the documented order", () => {
    expect(resolveVideoPoster({ ...muxVideo, manualPosterUrl: "/manual.jpg" })).toBe("/manual.jpg");
    expect(resolveVideoPoster(muxVideo)).toBe(muxVideo.generatedPosterUrl);
    expect(resolveVideoPoster({ ...muxVideo, generatedPosterUrl: "" })).toBe("/fallback.jpg");
    expect(muxPosterUrl("playback123456", 2.34567)).toContain("time=2.346");
  });

  it("renders captions and accessible native controls", () => {
    const markup = renderToStaticMarkup(createElement(AdaptiveVideoPlayer, { label: "Event recap", src: muxPlaybackUrl(muxVideo.playbackId), poster: resolveVideoPoster(muxVideo), captions: muxVideo.captions }));
    expect(markup).toContain("controls");
    expect(markup).toContain('aria-label="Event recap. Video player with playback controls and captions."');
    expect(markup).toContain('kind="captions"');
    expect(markup).toContain('srcLang="en-AU"');
    expect(markup).not.toContain("autoPlay");
  });

  it("uses stable processing and unavailable fallbacks", () => {
    const processing = renderToStaticMarkup(createElement(AdaptiveVideoPlayer, { label: "Processing", status: "processing", poster: "/fallback.jpg" }));
    const failed = renderToStaticMarkup(createElement(AdaptiveVideoPlayer, { label: "Failed", status: "failed" }));
    expect(processing).toContain("Video is processing");
    expect(processing).toContain('role="status"');
    expect(failed).toContain("Video unavailable");
  });

  it("honours reduced motion and only publicly renders ready public Mux media", () => {
    expect(shouldAutoPlayAdaptiveVideo({ requested: true, reducedMotion: true, saveData: false, visible: true })).toBe(false);
    expect(shouldAutoPlayAdaptiveVideo({ requested: true, reducedMotion: false, saveData: false, visible: true })).toBe(true);
    expect(videoIsPubliclyRenderable(muxVideo)).toBe(true);
    expect(videoIsPubliclyRenderable({ ...muxVideo, processingStatus: "processing" })).toBe(false);
    expect(videoIsPubliclyRenderable({ ...muxVideo, playbackPolicy: "signed" })).toBe(false);
    const markup = renderToStaticMarkup(createElement(MediaGrid, { items: [muxVideo, { ...muxVideo, id: "failed", processingStatus: "failed" }] }));
    expect(markup).toContain("Adaptive video");
    expect(markup).not.toContain("failed");
  });

  it("rejects malformed captions while keeping valid metadata", () => {
    expect(normalizedCaptionTracks([...(muxVideo.captions || []), { id: "bad", kind: "captions", label: "Bad", language: "invalid language", src: "javascript:alert(1)" }])).toEqual(muxVideo.captions);
  });
});
