"use client";
/* eslint-disable @next/next/no-img-element -- poster URLs are runtime-administered */

import { useEffect, useRef, useState } from "react";
import type { MediaCaptionTrack, MediaVideoStatus } from "@/types/site";
import { sendAnalytics } from "@/lib/analytics/client";

export function shouldAutoPlayAdaptiveVideo(input: { requested: boolean; reducedMotion: boolean; saveData: boolean; visible: boolean }) {
  return input.requested && !input.reducedMotion && !input.saveData && input.visible;
}

function unavailableMessage(status?: MediaVideoStatus) {
  if (["pending_upload", "uploaded", "processing"].includes(status || "")) return "Video is processing";
  if (status === "deleted") return "Video is no longer available";
  return "Video unavailable";
}

export function AdaptiveVideoPlayer({ src, poster, label, captions = [], autoPlay = false, status = "ready", analyticsMediaId, analyticsEventId }: {
  src?: string;
  poster?: string;
  label: string;
  captions?: MediaCaptionTrack[];
  autoPlay?: boolean;
  status?: MediaVideoStatus;
  analyticsMediaId?: string;
  analyticsEventId?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const completed = useRef(false);
  const available = status === "ready" && Boolean(src);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src || !available) return;
    let destroyed = false;
    let cleanupHls: () => void = () => undefined;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const saveData = Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData);
    const applyPlayback = (visible: boolean) => {
      if (shouldAutoPlayAdaptiveVideo({ requested: autoPlay, reducedMotion: reducedMotion.matches, saveData, visible })) void video.play().catch(() => undefined);
      else video.pause();
    };
    const setupSource = async () => {
      if (video.canPlayType("application/vnd.apple.mpegurl") || !src.includes(".m3u8")) video.src = src;
      else {
        const { default: Hls } = await import("hls.js");
        if (destroyed) return;
        if (!Hls.isSupported()) { setFailed(true); return; }
        const hls = new Hls({ enableWorker: true });
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) setFailed(true); });
        cleanupHls = () => hls.destroy();
      }
    };
    void setupSource().catch(() => setFailed(true));
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => { const visible=Boolean(entries[0]?.isIntersecting);applyPlayback(visible);if(visible&&analyticsMediaId)sendAnalytics("video_impression",{deduplicationKey:`${analyticsMediaId}:impression`,eventId:analyticsEventId,metadata:{mediaId:analyticsMediaId}}); }, { threshold: 0.15 });
    observer?.observe(video);
    applyPlayback(true);
    const motionChanged = () => applyPlayback(video.getBoundingClientRect().bottom > 0 && video.getBoundingClientRect().top < window.innerHeight);
    reducedMotion.addEventListener("change", motionChanged);
    return () => {
      destroyed = true;
      observer?.disconnect();
      reducedMotion.removeEventListener("change", motionChanged);
      video.pause();
      cleanupHls();
    };
  }, [analyticsEventId, analyticsMediaId, autoPlay, available, src]);

  if (!available || failed) return <div className="media-load-fallback" role="status" aria-live="polite">{poster ? <img alt="" src={poster} /> : null}<span>{unavailableMessage(status)}. A text description or caption track may be available with the event details.</span></div>;
  return <video ref={videoRef} aria-label={`${label}. Video player with playback controls${captions.length ? " and captions" : ""}.`} poster={poster} muted={autoPlay} loop={autoPlay} playsInline controls preload="metadata" onError={() => setFailed(true)} onPlay={()=>{if(analyticsMediaId)sendAnalytics("video_started",{deduplicationKey:`${analyticsMediaId}:started`,eventId:analyticsEventId,metadata:{mediaId:analyticsMediaId}});}} onTimeUpdate={(event)=>{const video=event.currentTarget;if(!completed.current&&video.duration>0&&video.currentTime/video.duration>=.9){completed.current=true;if(analyticsMediaId)sendAnalytics("video_completed",{deduplicationKey:`${analyticsMediaId}:completed`,eventId:analyticsEventId,metadata:{mediaId:analyticsMediaId}});}}}>
    {captions.map((track) => <track default={track.default} key={track.id} kind={track.kind} label={track.label} src={track.src} srcLang={track.language} />)}
    Your browser does not support adaptive video.
  </video>;
}
