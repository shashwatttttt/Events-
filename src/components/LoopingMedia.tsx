"use client";

import { AdaptiveVideoPlayer, shouldAutoPlayAdaptiveVideo } from "@/components/AdaptiveVideoPlayer";

export function shouldAutoPlayMedia(input: { reducedMotion: boolean; saveData: boolean; visible: boolean }) {
  return shouldAutoPlayAdaptiveVideo({ requested: true, ...input });
}

export function LoopingMedia({ src, poster, label }: { src: string; poster?: string; label: string }) {
  return <AdaptiveVideoPlayer autoPlay label={label} poster={poster} src={src} />;
}
