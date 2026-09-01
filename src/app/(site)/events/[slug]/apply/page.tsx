import { notFound, redirect } from "next/navigation";
import { ApplicationFormClient } from "@/components/ApplicationFormClient";
import { PosterVisual } from "@/components/PosterVisual";
import { requirePageUser } from "@/lib/auth";
import { readOperationsData, readSiteData } from "@/lib/data/documents";
import { hasEventPasswordAccess } from "@/lib/event-access";
import { canApplyToEvent } from "@/lib/event-state";

export const dynamic = "force-dynamic";

export default async function ApplyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requirePageUser(`/events/${slug}/apply`, ["customer"]);

  const [site, ops] = await Promise.all([readSiteData(), readOperationsData()]);
  const event = site.events.find(
    (item) => item.slug === slug && canApplyToEvent(item),
  );
  if (!event || !event.formId) notFound();
  if (!(await hasEventPasswordAccess(event))) redirect(`/events/${event.slug}`);

  const existing = ops.applications.find(
    (item) => item.eventId === event.id && item.userId === user.id && !["rejected", "cancelled"].includes(item.status),
  );
  if (existing) redirect("/account");
  const form = site.forms.find((item) => item.id === event.formId && item.active);
  if (!form) notFound();

  return (
    <section className="application-page">
      <div className="shell application-grid">
        <aside>
          <PosterVisual event={event} />
          <div className="application-event-meta">
            <p className="eyebrow"><span />Invite application</p>
            <h1>{event.title}</h1>
            <p>{event.teaser}</p>
          </div>
        </aside>
        <div>
          <p className="eyebrow"><span />Your release</p>
          <h2>Apply for the room.</h2>
          <p>Approval unlocks a ticket allocation. The team can adjust the allowance per customer.</p>
          <ApplicationFormClient eventId={event.id} form={form} />
        </div>
      </div>
    </section>
  );
}
