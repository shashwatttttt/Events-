import { EventCard } from "@/components/EventCard";
import { PageHero } from "@/components/PageHero";
import { readPublicSiteData } from "@/lib/platform";
import { getPagesContent } from "@/lib/site-content";

export const dynamic = "force-dynamic";
export const metadata = { title: "Events" };

export default async function EventsPage() {
  const site = await readPublicSiteData();
  const pages = getPagesContent(site.pages);
  const events = site.events.sort((a, b) => a.date.localeCompare(b.date));

  return (
    <>
      <PageHero
        eyebrow={pages.events.eyebrow}
        title={pages.events.title}
        body={pages.events.body}
        cover={pages.events}
      />
      <section className="section">
        <div className="shell">
          <div className="events-grid">
            {events.map((event, index) => (
              <EventCard key={event.id} event={event} priority={index === 1} />
            ))}
          </div>
          {!events.length && <div className="empty-state">{pages.events.emptyState}</div>}
        </div>
      </section>
    </>
  );
}
