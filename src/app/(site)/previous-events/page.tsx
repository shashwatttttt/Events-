import { EventCard } from "@/components/EventCard";
import { PageHero } from "@/components/PageHero";
import { readSiteData } from "@/lib/data/documents";
import { getPagesContent } from "@/lib/site-content";

export const dynamic = "force-dynamic";
export const metadata = { title: "Previous events" };

export default async function PreviousEventsPage() {
  const site = await readSiteData();
  const pages = getPagesContent(site.pages);
  const events = site.events
    .filter((event) => event.lifecycle === "archived" && event.visibility === "archived")
    .sort((a, b) => b.date.localeCompare(a.date));

  return (
    <>
      <PageHero
        eyebrow={pages.previousEvents.eyebrow}
        title={pages.previousEvents.title}
        body={pages.previousEvents.body}
        cover={pages.previousEvents}
      />
      <section className="section">
        <div className="shell">
          <div className="events-grid">
            {events.map((event) => <EventCard key={event.id} event={event} />)}
          </div>
          {!events.length && <div className="empty-state">{pages.previousEvents.emptyState}</div>}
        </div>
      </section>
    </>
  );
}
