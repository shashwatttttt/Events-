import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EventPasswordGate } from "@/components/EventPasswordGate";
import { AnalyticsEventView } from "@/components/AnalyticsPageTracker";
import { PosterVisual } from "@/components/PosterVisual";
import { SponsorRail } from "@/components/SponsorRail";
import { readOperationsData, readSiteData } from "@/lib/data/documents";
import { hasEventPasswordAccess } from "@/lib/event-access";
import { canonicalEventState, canViewEvent, isSalesWindowOpen } from "@/lib/event-state";
import { formatEventDateRange, moneyCents, safeUrl, statusLabel } from "@/lib/format";
import { loginRedirectPath } from "@/lib/security/redirects";
import { getCurrentUser, isAdminRole } from "@/lib/security/session";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const site = await readSiteData();
  const event = site.events.find((item) => item.slug === slug);
  return { title: event?.title || "Event" };
}

export default async function EventPage({ params }: Props) {
  const { slug } = await params;
  const [site, ops, user] = await Promise.all([
    readSiteData(),
    readOperationsData(),
    getCurrentUser(),
  ]);
  const event = site.events.find((item) => item.slug === slug);
  if (!event || !canViewEvent(event, { isAdmin: Boolean(user && isAdminRole(user.role)) })) notFound();
  if (!(await hasEventPasswordAccess(event))) {
    return <EventPasswordGate slug={event.slug} title={event.title} />;
  }

  const sponsors = site.sponsors.filter((sponsor) => event.sponsorIds.includes(sponsor.id) && sponsor.active);
  const products = site.products.filter((product) => event.productIds.includes(product.id) && product.visibleOnEventPage && isSalesWindowOpen(product));
  const application = user
    ? ops.applications.find((item) => item.eventId === event.id && item.userId === user.id)
    : undefined;
  const allocation = user
    ? ops.allocations.find((item) => item.eventId === event.id && item.userId === user.id && !["cancelled", "expired"].includes(item.status))
    : undefined;
  const activeTicket = event.ticketTypes.find((item) => isSalesWindowOpen(item));
  const eventState = canonicalEventState(event);
  const heroImage = safeUrl(event.heroUrl);
  const posterImage = safeUrl(event.posterUrl);

  let action: React.ReactNode;
  if (["archived", "cancelled", "closed", "draft", "preview"].includes(eventState)) {
    action = <span className="button button-disabled">Closed</span>;
  } else if (eventState === "coming_soon") {
    action = <span className="button button-disabled">Coming soon</span>;
  } else if (eventState === "applications_open") {
    if (!user) {
      action = <Link href={loginRedirectPath(`/events/${event.slug}/apply`)} className="button button-primary">Log in to apply <span>↗</span></Link>;
    } else if (allocation) {
      action = <Link href={`/checkout/${allocation.id}`} className="button button-primary">Buy unlocked ticket <span>↗</span></Link>;
    } else if (application) {
      action = <Link href="/account" className="button button-ghost">Application: {statusLabel(application.status)} <span>↗</span></Link>;
    } else {
      action = <Link href={`/events/${event.slug}/apply`} className="button button-primary">Apply for access <span>↗</span></Link>;
    }
  } else if (activeTicket) {
    action = <Link href={`/checkout/event/${event.slug}`} className="button button-primary">{event.ticketMode === "free_rsvp" ? "RSVP now" : "Buy tickets"} <span>↗</span></Link>;
  } else {
    action = <span className="button button-disabled">Sales closed</span>;
  }

  return (
    <>
      <AnalyticsEventView eventId={event.id} />
      <section className={`event-detail-hero${heroImage ? " has-event-cover" : ""}${posterImage ? " has-event-poster" : ""}`}>
        {heroImage && (
          <div
            className="event-detail-cover"
            style={{ backgroundImage: `url(${JSON.stringify(heroImage).slice(1, -1)})` }}
          />
        )}
        <div className="event-detail-cover-overlay" />
        <div className="shell event-detail-grid">
          <div className="event-detail-poster"><PosterVisual event={event} wide={!heroImage && !posterImage} /></div>
          <div className="event-detail-copy">
            <p className="eyebrow"><span />Event / {event.genre}</p>
            <h1>{event.title}</h1>
            <p className="event-lead">{event.teaser}</p>
            <dl>
              <div><dt>Date</dt><dd>{formatEventDateRange(event.date, event.endDate)}</dd></div>
              <div><dt>Time</dt><dd>{event.time}</dd></div>
              <div><dt>Location</dt><dd>{event.venue}<small>{event.location}</small></dd></div>
              <div><dt>Release</dt><dd>{activeTicket ? moneyCents(activeTicket.priceCents) : "TBA"}<small>{event.ageRestriction} · {statusLabel(event.ticketMode)}</small></dd></div>
            </dl>
            {action}
          </div>
        </div>
      </section>

      <section className="event-story">
        <div className="shell event-story-grid">
          <div><p className="eyebrow"><span />The concept</p><h2>{event.description}</h2></div>
        </div>
      </section>

      {products.length > 0 && (
        <section className="section event-products-public">
          <div className="shell">
            <p className="eyebrow"><span />Event extras</p>
            <h2>Build the night before you arrive.</h2>
            <div className="product-public-grid">
              {products.map((product) => {
                const image = safeUrl(product.imageUrl);
                return (
                  <article key={product.id}>
                    {image && (
                      <span
                        className="product-public-image"
                        style={{ backgroundImage: `url(${JSON.stringify(image).slice(1, -1)})` }}
                      />
                    )}
                    <span>{statusLabel(product.type)}</span>
                    <h3>{product.name}</h3>
                    <p>{product.description}</p>
                    <strong>{moneyCents(product.priceCents)}</strong>
                    <small>Available during approved checkout · Max {product.maxPerCustomer}</small>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      )}

      <section className="section event-information">
        <div className="shell event-info-grid">
          <div>
            <p className="eyebrow"><span />Line-up</p>
            <ol>{event.lineup.map((artist, index) => <li key={`${artist}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span>{artist}</li>)}</ol>
          </div>
          <div>
            <p className="eyebrow"><span />Before you enter</p>
            <ul>{event.houseRules.map((rule, index) => <li key={`${rule}-${index}`}>{rule}</li>)}</ul>
          </div>
        </div>
      </section>

      {event.faq.length > 0 && (
        <section className="section faq-section">
          <div className="shell">
            <p className="eyebrow"><span />Questions</p>
            <div className="faq-list">
              {event.faq.map((item) => <details key={item.question}><summary>{item.question}<span>+</span></summary><p>{item.answer}</p></details>)}
            </div>
          </div>
        </section>
      )}

      {sponsors.length > 0 && (
        <section className="partner-section event-partners">
          <div className="shell"><p className="eyebrow"><span />Event partners</p><h2 className="partner-heading">Backed by people who understand the room.</h2></div>
          <SponsorRail sponsors={sponsors} />
        </section>
      )}

      <section className="event-final-ticket">
        <div className="shell">
          <span>{formatEventDateRange(event.date, event.endDate)}</span>
          <h2>{event.lifecycle === "archived" ? "This transmission is closed." : "You know where you need to be."}</h2>
          {action}
        </div>
      </section>
    </>
  );
}
