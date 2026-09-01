import { safeUrl } from "@/lib/format";
import type { PageCoverSettings } from "@/types/site";

export function PageHero({
  eyebrow,
  title,
  body,
  cover,
}: {
  eyebrow: string;
  title: string;
  body: string;
  cover?: PageCoverSettings;
}) {
  const image = safeUrl(cover?.coverImageUrl || "");
  const alignment = cover?.coverTextAlignment || "left";

  return (
    <section
      className={`page-hero${image ? " has-cover" : ""} is-${alignment}`}
      style={{ ["--page-cover-overlay" as string]: cover?.coverOverlayOpacity ?? 0.55 }}
    >
      {image && (
        <div
          className="page-hero-cover"
          style={{
            backgroundImage: `url(${JSON.stringify(image).slice(1, -1)})`,
            backgroundPosition: cover?.coverFocalPosition || "center",
          }}
        />
      )}
      <div className="page-hero-cover-overlay" />
      {!image && <div className="page-hero-glow" />}
      <div className="shell page-hero-inner">
        <p className="eyebrow"><span />{eyebrow}</p>
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
    </section>
  );
}
