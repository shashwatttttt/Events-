"use client";

import type { SiteData } from "@/types/site";
import { useAccessibleDialog } from "@/components/AccessibleDialog";

export function SettingsPanel({
  site,
  setSite,
}: {
  site: SiteData;
  setSite: (site: SiteData) => void;
}) {
  const dialog = useAccessibleDialog();
  function updateSetting<K extends keyof SiteData["settings"]>(
    key: K,
    value: SiteData["settings"][K],
  ) {
    setSite({ ...site, settings: { ...site.settings, [key]: value } });
  }

  return (
    <section className="admin-section admin-stack">
      <div className="admin-section-title">
        <div>
          <h2>Platform settings</h2>
          <p>Live mode requires both this switch and APP_MODE=live on the server.</p>
        </div>
      </div>

      <div className="admin-card settings-mode-card">
        <div>
          <p className="eyebrow"><span />Safety switch</p>
          <h3>{site.settings.appMode.toUpperCase()} MODE</h3>
          <p>
            {site.settings.appMode === "test"
              ? "Fake outbox, test checkout and safe tickets are active."
              : "The admin intends to use Stripe, Resend and production records."}
          </p>
        </div>
        <button
          className={`mode-switch ${site.settings.appMode === "live" ? "is-live" : ""}`}
          onClick={async () => {
            const next = site.settings.appMode === "test" ? "live" : "test";
            if (
              next === "live"
              && !await dialog.confirm({ title: "Turn on live-mode intent?", description: "The server APP_MODE must also be live before real services activate. This change does not modify server or provider configuration.", confirmLabel: "Turn on live intent", danger: true })
            ) return;
            updateSetting("appMode", next);
          }}
          type="button"
        >
          <span />
          {site.settings.appMode === "test" ? "Switch to live intent" : "Switch back to test"}
        </button>
      </div>

      <div className="admin-grid-two">
        <div className="admin-card">
          <h3>Public brand</h3>
          <label className="admin-field">
            <span>Public wordmark name</span>
            <input
              value={site.brand.name}
              onChange={(event) => setSite({
                ...site,
                brand: { ...site.brand, name: event.target.value },
              })}
            />
          </label>
          <label className="admin-field">
            <span>Website accent colour</span>
            <input
              type="color"
              value={site.brand.accent}
              onChange={(event) => setSite({
                ...site,
                brand: { ...site.brand, accent: event.target.value },
              })}
            />
          </label>
          <label className="admin-field">
            <span>Public contact email</span>
            <input
              type="email"
              value={site.brand.contactEmail}
              onChange={(event) => setSite({
                ...site,
                brand: { ...site.brand, contactEmail: event.target.value },
              })}
            />
          </label>
        </div>

        <div className="admin-card">
          <h3>Operational defaults</h3>
          <label className="admin-field">
            <span>New-event ticket limit</span>
            <input
              type="number"
              min="1"
              max="20"
              value={site.settings.defaultTicketLimit}
              onChange={(event) => updateSetting("defaultTicketLimit", Number(event.target.value))}
            />
          </label>
          <label className="admin-field">
            <span>Application allocation expiry hours</span>
            <input
              type="number"
              min="1"
              max="336"
              value={site.settings.defaultAllocationExpiryHours}
              onChange={(event) => updateSetting(
                "defaultAllocationExpiryHours",
                Number(event.target.value),
              )}
            />
          </label>
          <label className="admin-field">
            <span>Public and admin timezone</span>
            <input
              value={site.settings.timezone}
              onChange={(event) => updateSetting("timezone", event.target.value)}
            />
          </label>
          <p className="admin-field-note">
            Defaults apply to new events, new application approvals and allocation extensions.
            Existing event limits are edited in Events.
          </p>
        </div>
      </div>

      <div className="admin-card">
        <h3>Homepage features</h3>
        <div className="toggle-row">
          <label>
            <input
              type="checkbox"
              checked={site.settings.newsletterEnabled}
              onChange={(event) => updateSetting("newsletterEnabled", event.target.checked)}
            />
            Show newsletter form in footer
          </label>
          <label>
            <input
              type="checkbox"
              checked={site.settings.featuredSponsorCarousel}
              onChange={(event) => updateSetting(
                "featuredSponsorCarousel",
                event.target.checked,
              )}
            />
            Show active sponsors on homepage
          </label>
        </div>
      </div>

      <div className="admin-card">
        <h3>External service readiness</h3>
        <ul className="settings-checklist">
          <li>Supabase project + SQL schema</li>
          <li>Stripe account + webhook endpoint</li>
          <li>Resend API key + verified skieevents.com domain</li>
          <li>Vercel environment variables + custom domain</li>
          <li>GitHub repository with secrets excluded</li>
        </ul>
      </div>
    </section>
  );
}
