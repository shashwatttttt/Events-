import Link from "next/link";
import { HeroSlider } from "@/components/HeroSlider";
import { SectionHeading } from "@/components/SectionHeading";
import { FestivalProgramExplorer } from "@/components/FestivalProgramExplorer";
import { SponsorRail } from "@/components/SponsorRail";
import { MediaGrid } from "@/components/MediaGrid";
import { ReviewCard } from "@/components/ReviewCard";
import { readPublicSiteData } from "@/lib/platform";
import { getHomepageContent } from "@/lib/site-content";
import { safeUrl } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const site = await readPublicSiteData();
  const homepage = getHomepageContent(site.homepage);
  const upcoming = site.events
    .sort((a, b) => Number(b.featured) - Number(a.featured) || a.date.localeCompare(b.date));
  const media = site.media.filter((item) => item.featured);
  const reviews = site.reviews.filter((item) => item.featured);
  const manifestoHref = safeUrl(homepage.manifestoLinkHref) || "/about";
  const finalCtaHref = safeUrl(homepage.finalCtaButtonHref) || "/events";

  return (
    <>
      <HeroSlider slides={site.heroSlides} />

      {homepage.showUpcomingEvents && (
        <section className="section section-events">
          <div className="shell">
            <SectionHeading
              eyebrow={homepage.upcomingEyebrow}
              title={homepage.upcomingTitle}
              href="/events"
              linkLabel={homepage.upcomingLinkLabel}
            />
            <FestivalProgramExplorer
              events={upcoming}
              emptyStateText={homepage.emptyEventsTitle}
            />
          </div>
        </section>
      )}

      <section className="manifesto-section">
        <div className="manifesto-marquee" aria-hidden="true">
          <span>{homepage.manifestoMarquee} </span>
          <span>{homepage.manifestoMarquee} </span>
        </div>
        <div className="shell manifesto-grid">
          <p className="eyebrow">
            <span />
            {homepage.manifestoEyebrow}
          </p>
          <div>
            <h2>{homepage.manifestoTitle}</h2>
            <p>{homepage.manifestoBody}</p>
            <Link href={manifestoHref} className="text-link">
              {homepage.manifestoLinkLabel} <span>↗</span>
            </Link>
          </div>
        </div>
      </section>

      {homepage.showMedia && <section className="section media-preview">
        <div className="shell">
          <SectionHeading
            eyebrow={homepage.mediaEyebrow}
            title={homepage.mediaTitle}
            href="/media"
            linkLabel={homepage.mediaLinkLabel}
          />
          <MediaGrid items={media.length ? media : site.media} limit={5} />
        </div>
      </section>}

      {homepage.showReviews && <section className="section review-section">
        <div className="shell">
          <SectionHeading
            eyebrow={homepage.reviewsEyebrow}
            title={homepage.reviewsTitle}
            href="/reviews"
            linkLabel={homepage.reviewsLinkLabel}
          />
          <div className="review-grid">
            {(reviews.length ? reviews : site.reviews).slice(0, 3).map((review) => (
              <ReviewCard key={review.id} review={review} />
            ))}
          </div>
        </div>
      </section>}

      {site.settings.featuredSponsorCarousel && (
        <section className="partner-section">
          <div className="shell">
            <p className="eyebrow">
              <span />
              {homepage.partnersEyebrow}
            </p>
            <h2 className="partner-heading">{homepage.partnersTitle}</h2>
          </div>
          <SponsorRail sponsors={site.sponsors} />
        </section>
      )}

      <section className="final-cta">
        <div className="final-cta-glow" />
        <div className="shell">
          <span>{homepage.finalCtaEyebrow}</span>
          <h2>{homepage.finalCtaTitle}</h2>
          <Link href={finalCtaHref} className="button button-light">
            {homepage.finalCtaButtonLabel} <span>↗</span>
          </Link>
        </div>
      </section>
    </>
  );
}
