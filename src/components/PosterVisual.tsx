import type { EventItem } from "@/types/site";
import { formatEventDateRange, safeUrl } from "@/lib/format";
import { PublicImageLayer } from "@/components/PublicImageLayer";

export function PosterVisual({ event, wide = false }: { event: EventItem; wide?: boolean }) {
  const image = safeUrl(wide ? event.heroUrl : event.posterUrl);

  return (
    <div
      className={wide ? "poster-visual poster-wide" : "poster-visual"}
      style={{ ["--event-accent" as string]: event.accent || "#5170FF" }}
    >
      <div className="poster-noise" />
      <div className="poster-arc poster-arc-a" />
      <div className="poster-arc poster-arc-b" />
      <div className="poster-topline"><span>SKIE / {event.genre}</span><span>{event.ageRestriction}</span></div>
      <div className="poster-center"><small>{formatEventDateRange(event.date, event.endDate)}</small><strong>{event.title}</strong><em>{event.venue}</em></div>
      <div className="poster-bottomline"><span>{event.location}</span><span>SKIE-{event.id.slice(-3).toUpperCase()}</span></div>
      {image && (
        <PublicImageLayer
          src={image}
          alt={`${event.title} ${wide ? "hero" : "poster"}`}
          className="poster-uploaded-layer"
          imageClassName="poster-uploaded-image"
          overlayClassName="poster-uploaded-shade"
        />
      )}
    </div>
  );
}
