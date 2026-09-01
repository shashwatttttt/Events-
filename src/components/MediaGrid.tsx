/* eslint-disable @next/next/no-img-element -- storage URLs are runtime-administered; native dimensions prevent layout shift */
import { AdaptiveVideoPlayer } from "@/components/AdaptiveVideoPlayer";
import type { MediaItem } from "@/types/site";
import { safeUrl } from "@/lib/format";
import { muxPlaybackUrl, resolveVideoPoster, videoIsPubliclyRenderable } from "@/lib/media/video";

export function MediaGrid({ items, limit }: { items: MediaItem[]; limit?: number }) {
  const published = items.filter((item) => item.type === "image" ? item.published : videoIsPubliclyRenderable(item)).sort((left, right) => (left.order || 0) - (right.order || 0));
  const selected = typeof limit === "number" ? published.slice(0, limit) : published;
  return <div className="media-grid">{selected.map((item, index) => {
    const url = safeUrl(item.provider === "mux" ? muxPlaybackUrl(item.playbackId) : item.url); const poster = safeUrl(resolveVideoPoster(item));
    const width = item.width || 1200; const height = item.height || Math.round(width / (item.aspectRatio || 4 / 3));
    return <article className={`media-card media-card-${(index % 5) + 1}`} key={item.id} style={{ aspectRatio: item.aspectRatio || width / height }}>
      {item.type === "video" && url
        ? <AdaptiveVideoPlayer analyticsEventId={item.eventId} analyticsMediaId={item.id} autoPlay={item.featured} captions={item.captions} label={item.title} poster={poster || undefined} src={url} status={item.processingStatus || "ready"} />
        : url
          ? <img alt={item.altText || item.title} decoding="async" height={height} loading="lazy" src={url} width={width} style={{ objectPosition: `${(item.focalX ?? 0.5) * 100}% ${(item.focalY ?? 0.5) * 100}%` }} />
          : <div className="media-image"><div className="media-placeholder"><span>SKIE</span><i>{String(index + 1).padStart(2, "0")}</i></div></div>}
      <div className="media-caption"><span>{item.eventName}</span><strong>{item.title}</strong>{item.caption && <p>{item.caption}</p>}</div>
    </article>;
  })}</div>;
}
