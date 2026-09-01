"use client";

import { AdminAssetUploadField } from "@/components/admin/AdminAssetUploadField";
import { useAccessibleDialog } from "@/components/AccessibleDialog";
import type { SiteData, Sponsor } from "@/types/site";

function uid() {
  return `sp_${crypto.randomUUID()}`;
}

export function SponsorsPanel({ site, setSite }: { site: SiteData; setSite: (site: SiteData) => void }) {
  const dialog = useAccessibleDialog();
  function patch(id: string, changes: Partial<Sponsor>) {
    setSite({ ...site, sponsors: site.sponsors.map((item) => item.id === id ? { ...item, ...changes } : item) });
  }

  function add() {
    setSite({
      ...site,
      sponsors: [...site.sponsors, {
        id: uid(),
        name: "NEW PARTNER",
        tagline: "Event partner",
        description: "Add partner description.",
        logoUrl: "",
        bannerUrl: "",
        websiteUrl: "",
        instagramUrl: "",
        active: true,
      }],
    });
  }

  async function remove(sponsor: Sponsor) {
    if (!await dialog.confirm({ title: "Delete sponsor?", description: `Delete ${sponsor.name} and remove it from all events?`, confirmLabel: "Delete sponsor", danger: true })) return;
    setSite({
      ...site,
      sponsors: site.sponsors.filter((item) => item.id !== sponsor.id),
      events: site.events.map((event) => ({ ...event, sponsorIds: event.sponsorIds.filter((id) => id !== sponsor.id) })),
    });
  }

  function toggleEvent(sponsorId: string, eventId: string, checked: boolean) {
    setSite({
      ...site,
      events: site.events.map((event) => event.id === eventId
        ? { ...event, sponsorIds: checked ? [...new Set([...event.sponsorIds, sponsorId])] : event.sponsorIds.filter((id) => id !== sponsorId) }
        : event),
    });
  }

  return (
    <section className="admin-section admin-stack">
      <div className="admin-section-title">
        <div><h2>Sponsors</h2><p>Large banner-led partner stories with event-specific visibility.</p></div>
        <button className="button button-primary" onClick={add} type="button">Add sponsor</button>
      </div>
      <div className="admin-product-grid">
        {site.sponsors.map((sponsor) => (
          <article className="admin-card" key={sponsor.id}>
            <div className="admin-card-head"><strong>{sponsor.name}</strong><button className="danger-link" type="button" onClick={() => void remove(sponsor)}>Delete</button></div>
            <div className="admin-grid-two">
              <label className="admin-field"><span>Name</span><input value={sponsor.name} onChange={(e) => patch(sponsor.id, { name: e.target.value })} /></label>
              <label className="admin-field"><span>Tagline</span><input value={sponsor.tagline} onChange={(e) => patch(sponsor.id, { tagline: e.target.value })} /></label>
              <label className="admin-field"><span>Website</span><input value={sponsor.websiteUrl} onChange={(e) => patch(sponsor.id, { websiteUrl: e.target.value })} /></label>
              <label className="admin-field"><span>Instagram</span><input value={sponsor.instagramUrl || ""} onChange={(e) => patch(sponsor.id, { instagramUrl: e.target.value })} /></label>
              <AdminAssetUploadField label="Sponsor logo" value={sponsor.logoUrl} onChange={(value) => patch(sponsor.id, { logoUrl: value })} accept="image/*" helperText="Transparent PNG or WebP works best." previewType="image" />
              <AdminAssetUploadField label="Sponsor banner / poster" value={sponsor.bannerUrl} onChange={(value) => patch(sponsor.id, { bannerUrl: value })} accept="image/*" helperText="Recommended wide artwork: 1920x1080 or 1800x700." previewType="image" />
            </div>
            <label className="admin-field"><span>About partner</span><textarea value={sponsor.description} onChange={(e) => patch(sponsor.id, { description: e.target.value })} /></label>
            <label className="admin-toggle"><input type="checkbox" checked={sponsor.active} onChange={(e) => patch(sponsor.id, { active: e.target.checked })} /><span>Active</span></label>
            <div className="nested-admin-card">
              <strong>Show at events</strong>
              <div className="toggle-row sponsor-assignment-list">
                {site.events.map((event) => <label key={event.id}><input type="checkbox" checked={event.sponsorIds.includes(sponsor.id)} onChange={(e) => toggleEvent(sponsor.id, event.id, e.target.checked)} /> {event.title}</label>)}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
