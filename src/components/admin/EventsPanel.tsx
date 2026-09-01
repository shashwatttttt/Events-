"use client";

import { useState } from "react";
import { useAccessibleDialog } from "@/components/AccessibleDialog";
import { AdminAssetUploadField } from "@/components/admin/AdminAssetUploadField";
import type { EventItem, EventTicketType, SiteData } from "@/types/site";
import { dateTimeLocalInputToIso, formatDateTimeLocalInput, slugify } from "@/lib/format";
import { POST_CHECKOUT_MODE } from "@/lib/post-approval/types";

function uid(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function lines(value: string) {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

export function EventsPanel({ site, setSite }: { site: SiteData; setSite: (site: SiteData) => void }) {
  const dialog = useAccessibleDialog();
  const [operationStatus, setOperationStatus] = useState("");
  function patch(id: string, changes: Partial<EventItem>) {
    setSite({ ...site, events: site.events.map((event) => (event.id === id ? { ...event, ...changes } : event)) });
  }

  function add() {
    const id = uid("evt");
    const event: EventItem = {
      id,
      slug: `new-event-${site.events.length + 1}`,
      title: "New Event",
      date: new Date().toISOString().slice(0, 10),
      time: "9:00 PM – LATE",
      venue: "Venue TBA",
      location: "Melbourne, VIC",
      genre: "SKIE EVENT",
      teaser: "A new Skie transmission.",
      description: "Add the event concept here.",
      posterUrl: "",
      heroUrl: "",
      accent: site.brand.accent,
      lineup: [],
      houseRules: ["18+ only.", "Valid photo ID required."],
      faq: [],
      ageRestriction: "18+",
      lifecycle: "draft",
      visibility: "hidden",
      ticketMode: "closed",
      featured: false,
      sponsorIds: [],
      formId: site.forms[0]?.id,
      venueCapacity: 250,
      publicCapacity: 180,
      sponsorAllocation: 20,
      guestlistAllocation: 20,
      teamAllocation: 15,
      safetyBuffer: 15,
      defaultTicketLimit: site.settings.defaultTicketLimit,
      productIds: [],
      ticketTypes: [
        {
          id: uid("tt"),
          name: "First Release",
          description: "Initial ticket release.",
          priceCents: 4500,
          capacity: 180,
          sold: 0,
          defaultMaxPerCustomer: site.settings.defaultTicketLimit,
          active: true,
        },
      ],
    };
    setSite({ ...site, events: [...site.events, event] });
  }

  function addTicketType(event: EventItem) {
    const ticketType: EventTicketType = {
      id: uid("tt"),
      name: "New Release",
      description: "Describe this release.",
      priceCents: 4500,
      capacity: 50,
      sold: 0,
      defaultMaxPerCustomer: event.defaultTicketLimit,
      active: false,
    };
    patch(event.id, { ticketTypes: [...event.ticketTypes, ticketType] });
  }

  async function duplicate(event: EventItem) {
    if (!await dialog.confirm({ title: "Duplicate event as a draft?", description: `Create a hidden draft copy of ${event.title}? Products are intentionally not copied.`, confirmLabel: "Duplicate event" })) return;
    setOperationStatus("Duplicating event...");
    const response = await fetch("/api/admin/operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "duplicate_event", eventId: event.id, operationId: `duplicate_${crypto.randomUUID()}` }) });
    const body = await response.json() as { error?: string };
    if (!response.ok) { setOperationStatus(body.error || "Event duplication failed."); return; }
    setOperationStatus("Draft copy created and audited. Reloading current CMS version...");
    window.location.reload();
  }

  async function removeTicketType(event: EventItem, type: EventTicketType) {
    if (!await dialog.confirm({ title: "Delete ticket release?", description: `Delete ${type.name}? This unsaved change cannot be restored after the CMS document is saved.`, confirmLabel: "Delete release", danger: true })) return;
    patch(event.id, { ticketTypes: event.ticketTypes.filter((item) => item.id !== type.id) });
  }

  async function removeEvent(event: EventItem) {
    if (!await dialog.confirm({ title: "Delete event?", description: `Delete ${event.title}? This also removes its products when the CMS document is saved.`, confirmLabel: "Delete event", danger: true })) return;
    setSite({ ...site, events: site.events.filter((item) => item.id !== event.id), products: site.products.filter((item) => item.eventId !== event.id) });
  }

  function toggleSponsor(event: EventItem, sponsorId: string, checked: boolean) {
    patch(event.id, {
      sponsorIds: checked
        ? [...new Set([...event.sponsorIds, sponsorId])]
        : event.sponsorIds.filter((id) => id !== sponsorId),
    });
  }

  return (
    <section className="admin-section admin-stack">
      <div className="admin-section-title">
        <div>
          <h2>Events</h2>
          <p>Draft, preview, publish and control every event without touching code.</p>
        </div>
        <button className="button button-primary" onClick={add} type="button">Add event</button>
      </div>
      {operationStatus && <p className="admin-notice" role="status">{operationStatus}</p>}

      {site.events.map((event) => (
        <details className="admin-card" key={event.id}>
          <summary>
            <div>
              <span className={`event-state state-${event.lifecycle}`}>{event.lifecycle}</span>
              <strong>{event.title}</strong>
              <small>{event.date} · {String(event.ticketMode).replaceAll("_", " ")}</small>
            </div>
            <span>Edit ↓</span>
          </summary>

          <div className="admin-card-body">
            <div className="admin-publishing-guide">
              <strong>Publishing states</strong>
              <ul>
                <li><b>Draft + hidden</b> - administrator only.</li>
                <li><b>Published + public</b> - live public event.</li>
                <li><b>Published + coming soon</b> - public teaser without ticket sales.</li>
                <li><b>Archived</b> - previous event.</li>
                <li><b>Closed</b> - visible event with ticket sales closed.</li>
              </ul>
              <div className="admin-event-quick-actions">
                <button type="button" onClick={() => void duplicate(event)}>Duplicate as draft</button>
                <button type="button" onClick={() => patch(event.id, { lifecycle: "draft", visibility: "hidden", ticketMode: "closed" })}>Set as Draft</button>
                <button type="button" onClick={() => patch(event.id, { lifecycle: "published", visibility: "coming_soon", ticketMode: "coming_soon" })}>Set as Coming Soon</button>
                <button type="button" onClick={() => patch(event.id, { lifecycle: "published", visibility: "public", ticketMode: event.ticketMode === "closed" || event.ticketMode === "coming_soon" ? "invite_only" : event.ticketMode })}>Publish Public</button>
                <button type="button" onClick={() => patch(event.id, { lifecycle: "archived", visibility: "archived", ticketMode: "closed" })}>Archive Event</button>
              </div>
              <small>These actions create unsaved changes only. Use Save changes in the top bar to publish them.</small>
            </div>

            <div className="admin-grid-two">
              <label className="admin-field"><span>Title</span><input value={event.title} onChange={(e) => patch(event.id, { title: e.target.value, slug: event.slug.startsWith("new-event") ? slugify(e.target.value) : event.slug })} /></label>
              <label className="admin-field"><span>Slug</span><input value={event.slug} onChange={(e) => patch(event.id, { slug: slugify(e.target.value) })} /></label>
              <label className="admin-field"><span>Date</span><input type="date" value={event.date} onChange={(e) => patch(event.id, { date: e.target.value })} /></label>
              <label className="admin-field"><span>End date</span><input type="date" value={event.endDate || ""} onChange={(e) => patch(event.id, { endDate: e.target.value || undefined })} /></label>
              <label className="admin-field"><span>Time</span><input value={event.time} onChange={(e) => patch(event.id, { time: e.target.value })} /></label>
              <label className="admin-field"><span>Genre / label</span><input value={event.genre} onChange={(e) => patch(event.id, { genre: e.target.value })} /></label>
              <label className="admin-field"><span>Venue</span><input value={event.venue} onChange={(e) => patch(event.id, { venue: e.target.value })} /></label>
              <label className="admin-field"><span>Location</span><input value={event.location} onChange={(e) => patch(event.id, { location: e.target.value })} /></label>
              <AdminAssetUploadField label="Event poster" value={event.posterUrl} onChange={(value) => patch(event.id, { posterUrl: value })} accept="image/*" helperText="Recommended vertical image: 1080x1350 or 1440x1800." previewType="image" />
              <AdminAssetUploadField label="Event hero / banner" value={event.heroUrl} onChange={(value) => patch(event.id, { heroUrl: value })} accept="image/*" helperText="Recommended landscape image: 1920x1080 or wider." previewType="image" />
              <label className="admin-field"><span>Lifecycle</span><select value={event.lifecycle} onChange={(e) => patch(event.id, { lifecycle: e.target.value as EventItem["lifecycle"] })}><option>draft</option><option>preview</option><option>published</option><option>archived</option><option>cancelled</option></select></label>
              <label className="admin-field"><span>Visibility</span><select value={event.visibility} onChange={(e) => patch(event.id, { visibility: e.target.value as EventItem["visibility"] })}><option>public</option><option>hidden</option><option>password</option><option>private_link</option><option>coming_soon</option><option>archived</option></select></label>
              <label className="admin-field"><span>Event password</span><input type="password" value={event.password || ""} disabled={event.visibility !== "password"} placeholder={event.visibility === "password" ? "Set private event password" : "Only used for password visibility"} onChange={(e) => patch(event.id, { password: e.target.value })} /></label>
              <label className="admin-field"><span>Ticket mode</span><select value={String(event.ticketMode)} onChange={(e) => patch(event.id, { ticketMode: e.target.value as EventItem["ticketMode"] })}><option>invite_only</option><option>direct_purchase</option><option value={POST_CHECKOUT_MODE}>post_checkout_approval</option><option>coming_soon</option><option>closed</option><option>free_rsvp</option></select><small>Post-checkout approval authorises the card first, then requires the selected application form before admin capture.</small></label>
              <label className="admin-field"><span>Application form</span><select value={event.formId || ""} onChange={(e) => patch(event.id, { formId: e.target.value || undefined })}><option value="">No form</option>{site.forms.map((form) => <option value={form.id} key={form.id}>{form.name}</option>)}</select></label>
              <label className="admin-field"><span>Default max per customer</span><input type="number" min="1" max="20" value={event.defaultTicketLimit} onChange={(e) => patch(event.id, { defaultTicketLimit: Number(e.target.value) })} /></label>
            </div>
            {String(event.ticketMode) === POST_CHECKOUT_MODE && !event.formId && <p className="admin-notice" role="alert">Post-checkout approval cannot be saved without an active application form.</p>}

            <div className="toggle-row">
              <label><input type="checkbox" checked={event.featured} onChange={(e) => patch(event.id, { featured: e.target.checked })} /> Prioritise on homepage</label>
            </div>

            <label className="admin-field"><span>Teaser</span><textarea value={event.teaser} onChange={(e) => patch(event.id, { teaser: e.target.value })} /></label>
            <label className="admin-field"><span>Description</span><textarea value={event.description} onChange={(e) => patch(event.id, { description: e.target.value })} /></label>
            <div className="admin-grid-two">
              <label className="admin-field"><span>Line-up - one per line</span><textarea value={event.lineup.join("\n")} onChange={(e) => patch(event.id, { lineup: lines(e.target.value) })} /></label>
              <label className="admin-field"><span>House rules - one per line</span><textarea value={event.houseRules.join("\n")} onChange={(e) => patch(event.id, { houseRules: lines(e.target.value) })} /></label>
            </div>

            <p className="admin-field-note">
              Public allocation is enforced at checkout. The other capacity buckets are planning
              reservations; all buckets plus the safety buffer must fit within venue capacity.
            </p>
            {(event.publicCapacity + event.sponsorAllocation + event.guestlistAllocation + event.teamAllocation + event.safetyBuffer > event.venueCapacity) && <p className="admin-notice" role="alert">Capacity warning: public, sponsor, guestlist, team and safety allocations exceed venue capacity.</p>}
            <div className="admin-grid-three">
              <label className="admin-field"><span>Venue capacity</span><input type="number" min="1" value={event.venueCapacity} onChange={(e) => patch(event.id, { venueCapacity: Number(e.target.value) })} /></label>
              <label className="admin-field"><span>Public allocation</span><input type="number" min="0" value={event.publicCapacity} onChange={(e) => patch(event.id, { publicCapacity: Number(e.target.value) })} /></label>
              <label className="admin-field"><span>Sponsor allocation</span><input type="number" min="0" value={event.sponsorAllocation} onChange={(e) => patch(event.id, { sponsorAllocation: Number(e.target.value) })} /></label>
              <label className="admin-field"><span>Guestlist allocation</span><input type="number" min="0" value={event.guestlistAllocation} onChange={(e) => patch(event.id, { guestlistAllocation: Number(e.target.value) })} /></label>
              <label className="admin-field"><span>Team allocation</span><input type="number" min="0" value={event.teamAllocation} onChange={(e) => patch(event.id, { teamAllocation: Number(e.target.value) })} /></label>
              <label className="admin-field"><span>Safety buffer</span><input type="number" min="0" value={event.safetyBuffer} onChange={(e) => patch(event.id, { safetyBuffer: Number(e.target.value) })} /></label>
            </div>

            <div className="admin-ticket-types">
              <div className="admin-card-head"><h4>Ticket types</h4><button type="button" className="button button-ghost" onClick={() => addTicketType(event)}>Add ticket type</button></div>
              {event.ticketTypes.map((type) => (
                <div className="ticket-type-editor" key={type.id}>
                  {(type.capacity - type.sold <= Math.max(5, Math.ceil(type.capacity * 0.1))) && <p className="admin-notice" role="status">Stock warning: {Math.max(0, type.capacity - type.sold)} ticket(s) remain for {type.name}.</p>}
                  <div className="admin-grid-three">
                    <label className="admin-field"><span>Name</span><input value={type.name} onChange={(e) => patch(event.id, { ticketTypes: event.ticketTypes.map((item) => item.id === type.id ? { ...item, name: e.target.value } : item) })} /></label>
                    <label className="admin-field"><span>Price AUD</span><input type="number" step="0.01" min="0" value={type.priceCents / 100} onChange={(e) => patch(event.id, { ticketTypes: event.ticketTypes.map((item) => item.id === type.id ? { ...item, priceCents: Math.round(Number(e.target.value) * 100) } : item) })} /></label>
                    <label className="admin-field"><span>Capacity</span><input type="number" min={type.sold} value={type.capacity} onChange={(e) => patch(event.id, { ticketTypes: event.ticketTypes.map((item) => item.id === type.id ? { ...item, capacity: Number(e.target.value) } : item) })} /></label>
                    <label className="admin-field"><span>Max per customer</span><input type="number" min="1" max="20" value={type.defaultMaxPerCustomer} onChange={(e) => patch(event.id, { ticketTypes: event.ticketTypes.map((item) => item.id === type.id ? { ...item, defaultMaxPerCustomer: Number(e.target.value) } : item) })} /></label>
                    <label className="admin-field"><span>Sales start (Melbourne time)</span><input type="datetime-local" value={formatDateTimeLocalInput(type.salesStartAt, site.settings.timezone)} onChange={(e) => patch(event.id, { ticketTypes: event.ticketTypes.map((item) => item.id === type.id ? { ...item, salesStartAt: dateTimeLocalInputToIso(e.target.value, site.settings.timezone) } : item) })} /></label>
                    <label className="admin-field"><span>Sales end (Melbourne time)</span><input type="datetime-local" value={formatDateTimeLocalInput(type.salesEndAt, site.settings.timezone)} onChange={(e) => patch(event.id, { ticketTypes: event.ticketTypes.map((item) => item.id === type.id ? { ...item, salesEndAt: dateTimeLocalInputToIso(e.target.value, site.settings.timezone) } : item) })} /></label>
                  </div>
                  <label className="admin-field"><span>Description</span><input value={type.description} onChange={(e) => patch(event.id, { ticketTypes: event.ticketTypes.map((item) => item.id === type.id ? { ...item, description: e.target.value } : item) })} /></label>
                  <div className="toggle-row">
                    <label><input type="checkbox" checked={type.active} onChange={(e) => patch(event.id, { ticketTypes: event.ticketTypes.map((item) => item.id === type.id ? { ...item, active: e.target.checked } : item) })} /> Active</label>
                    <span>{type.sold} issued</span>
                    <button type="button" className="danger-link" disabled={type.sold > 0 || event.ticketTypes.length === 1} onClick={() => void removeTicketType(event, type)}>Delete release</button>
                  </div>
                </div>
              ))}
            </div>

            <div className="admin-card nested-admin-card">
              <h4>Event sponsors</h4>
              <div className="toggle-row sponsor-assignment-list">
                {site.sponsors.map((sponsor) => (
                  <label key={sponsor.id}><input type="checkbox" checked={event.sponsorIds.includes(sponsor.id)} onChange={(e) => toggleSponsor(event, sponsor.id, e.target.checked)} /> {sponsor.name}</label>
                ))}
                {!site.sponsors.length && <span>No sponsors created.</span>}
              </div>
            </div>

            <button className="danger-button" type="button" onClick={() => void removeEvent(event)}>Delete event</button>
          </div>
        </details>
      ))}
    </section>
  );
}
