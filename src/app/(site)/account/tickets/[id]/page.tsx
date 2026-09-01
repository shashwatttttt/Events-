import { notFound } from "next/navigation";
import { TicketQRCode } from "@/components/TicketQRCode";
import { readSiteData } from "@/lib/data/documents";
import { formatEventDate, statusLabel } from "@/lib/format";
import { getOwnedTicket } from "@/lib/operations";
import { requireUser } from "@/lib/security/session";
import { createTicketUrl } from "@/lib/tickets/security";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ticket details" };

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(["customer"]);
  const [site, owned] = await Promise.all([readSiteData(), getOwnedTicket(id, user.id)]);
  if (!owned) notFound();
  const { ticket, entitlements } = owned;
  const event = site.events.find((item) => item.id === ticket.eventId);
  if (!event) notFound();
  return (
    <section className="ticket-page">
      <div className="shell ticket-page-grid">
        <article className="digital-ticket">
          <div className="digital-ticket-top"><span>SKIE EVENTS</span><span>{statusLabel(ticket.status)}</span></div>
          <div className="digital-ticket-body">
            <p className="eyebrow"><span />Admission</p>
            <h1>{event.title}</h1>
            <dl>
              <div><dt>Holder</dt><dd>{ticket.holderName}</dd></div>
              <div><dt>Date</dt><dd>{formatEventDate(event.date)}</dd></div>
              <div><dt>Time</dt><dd>{event.time}</dd></div>
              <div><dt>Venue</dt><dd>{event.venue}<small>{event.location}</small></dd></div>
              <div><dt>Code</dt><dd>{ticket.ticketCode}</dd></div>
            </dl>
            {entitlements.length > 0 && (
              <div className="ticket-entitlements">
                <span>EVENT EXTRAS</span>
                {entitlements.map((item) => <div key={item.id}><strong>{item.name}</strong><small>{item.quantityRemaining} remaining</small></div>)}
              </div>
            )}
          </div>
          <TicketQRCode value={createTicketUrl(ticket)} label={ticket.ticketCode} />
          <footer>18+ · VALID PHOTO ID REQUIRED · SCREENSHOTS MAY TRIGGER DUPLICATE SCAN WARNINGS</footer>
        </article>
        <aside className="ticket-help">
          <p className="eyebrow"><span />At the door</p>
          <h2>Brightness up. QR ready.</h2>
          <p>The scanner checks this ticket against the live database and marks it used after successful entry.</p>
          <ul><li>Do not share the QR.</li><li>Bring valid photo ID.</li><li>Event extras are attached to your order.</li><li>Contact hello@skieevents.com for transfer support.</li></ul>
        </aside>
      </div>
    </section>
  );
}
