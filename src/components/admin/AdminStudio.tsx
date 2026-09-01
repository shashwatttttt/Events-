"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LogoutButton } from "@/components/LogoutButton";
import { ApplicationsPanel } from "@/components/admin/ApplicationsPanel";
import { AnalyticsPanel } from "@/components/admin/AnalyticsPanel";
import { AuditLogsPanel } from "@/components/admin/AuditLogsPanel";
import { CheckInPanel } from "@/components/admin/CheckInPanel";
import { CustomersPanel } from "@/components/admin/CustomersPanel";
import { EmailsPanel } from "@/components/admin/EmailsPanel";
import { EventsPanel } from "@/components/admin/EventsPanel";
import { ExportsPanel } from "@/components/admin/ExportsPanel";
import { FormsPanel } from "@/components/admin/FormsPanel";
import { MediaPanel } from "@/components/admin/MediaPanel";
import { LaunchReadinessPanel } from "@/components/admin/LaunchReadinessPanel";
import { OverviewPanel } from "@/components/admin/OverviewPanel";
import { PaymentRecoveryPanel } from "@/components/admin/PaymentRecoveryPanel";
import { ProductsPanel } from "@/components/admin/ProductsPanel";
import { PromoCodesPanel } from "@/components/admin/PromoCodesPanel";
import { ReviewsPanel } from "@/components/admin/ReviewsPanel";
import { SettingsPanel } from "@/components/admin/SettingsPanel";
import { StaffPanel } from "@/components/admin/StaffPanel";
import { SponsorsPanel } from "@/components/admin/SponsorsPanel";
import { TicketingPanel } from "@/components/admin/TicketingPanel";
import type { AdminSnapshot } from "@/components/admin/types";
import { WebsitePanel } from "@/components/admin/WebsitePanel";
import styles from "@/components/admin/AdminStudio.module.css";
import type { SiteData } from "@/types/site";

const tabs = [
  "Overview",
  "Analytics",
  "Events",
  "Applications",
  "Customers",
  "Ticketing",
  "Payment recovery",
  "Launch readiness",
  "Products",
  "Promo codes",
  "Sponsors",
  "Forms",
  "Media",
  "Reviews",
  "Emails",
  "Exports",
  "Check-in",
  "Event staff",
  "Website",
  "Settings",
  "Audit logs",
] as const;

type Tab = (typeof tabs)[number];

type PersistenceDiagnostics = {
  appMode: "test" | "live";
  dataProvider: "local" | "supabase";
  isDurableProvider: boolean;
  siteVersion: number | null;
  siteUpdatedAt: string | null;
  operationsVersion: number | null;
  operationsUpdatedAt: string | null;
};

export function AdminStudio() {
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [site, setSite] = useState<SiteData | null>(null);
  const [persistence, setPersistence] = useState<PersistenceDiagnostics | null>(null);
  const [baseline, setBaseline] = useState("");
  const [siteVersion, setSiteVersion] = useState("");
  const [staleSave, setStaleSave] = useState(false);
  const [tab, setTab] = useState<Tab>("Overview");
  const [status, setStatus] = useState("Loading platform...");
  const [saving, setSaving] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  function selectTab(nextTab: Tab) {
    setTab(nextTab);
    setNavigationOpen(false);
    requestAnimationFrame(() => headingRef.current?.focus());
  }

  useEffect(() => {
    if (!navigationOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setNavigationOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [navigationOpen]);

  const applySnapshot = useCallback((body: AdminSnapshot) => {
    setSnapshot(body);
    setSite(body.site);
    setSiteVersion(body.siteVersion);
    setBaseline(JSON.stringify(body.site));
    setStaleSave(false);
    setStatus("Platform loaded");
  }, []);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/snapshot", { cache: "no-store" });
    if (!response.ok) {
      setStatus("Could not load admin data.");
      return;
    }

    applySnapshot((await response.json()) as AdminSnapshot);
  }, [applySnapshot]);

  const refreshSnapshot = useCallback(async () => {
    const response = await fetch("/api/admin/snapshot", { cache: "no-store" });
    if (!response.ok) return;
    setSnapshot((await response.json()) as AdminSnapshot);
  }, []);

  const loadPersistence = useCallback(async () => {
    const response = await fetch("/api/admin/persistence", { cache: "no-store" });
    if (!response.ok) return;
    setPersistence((await response.json()) as PersistenceDiagnostics);
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/admin/persistence", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as PersistenceDiagnostics;
      })
      .then((body) => {
        if (!cancelled && body) setPersistence(body);
      })
      .catch(() => undefined);

    fetch("/api/admin/snapshot", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as (AdminSnapshot & { error?: string }) | null;
        if (!response.ok) {
          throw new Error(body?.error || "Could not load admin data.");
        }
        return body as AdminSnapshot;
      })
      .then((body) => {
        if (!cancelled) applySnapshot(body);
      })
      .catch((error) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : "Could not load admin data.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applySnapshot, loadPersistence]);

  const dirty = useMemo(
    () => Boolean(site && JSON.stringify(site) !== baseline),
    [site, baseline],
  );

  async function save() {
    if (!site) return;

    setSaving(true);
    setStatus("Saving...");

    try {
      const response = await fetch("/api/admin/site", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site, expectedVersion: siteVersion }),
      });
      const body = (await response.json()) as { error?: string; code?: string; site?: SiteData; version?: string };

      if (!response.ok) {
        if (response.status === 409 && body.code === "CMS_STALE_VERSION") {
          setStaleSave(true);
          setStatus("Another administrator saved a newer version. Your draft is still here; reload before saving again.");
        } else {
          setStatus(body.error || "Save failed.");
        }
        return;
      }

      const saved = body.site || site;
      setSiteVersion(body.version || siteVersion);
      setStaleSave(false);
      setSite(saved);
      setBaseline(JSON.stringify(saved));
      setSnapshot((current) => (current ? { ...current, site: saved, siteVersion: body.version || current.siteVersion } : current));
      setStatus("Saved. Verifying persistent storage...");

      try {
        const verificationResponse = await fetch("/api/admin/snapshot", { cache: "no-store" });
        if (!verificationResponse.ok) {
          setStatus("Saved, but verification could not reload admin data.");
          return;
        }
        const verifiedSnapshot = (await verificationResponse.json()) as AdminSnapshot;
        if (JSON.stringify(saved) === JSON.stringify(verifiedSnapshot.site)) {
          setSnapshot(verifiedSnapshot);
          setSite(verifiedSnapshot.site);
          setSiteVersion(verifiedSnapshot.siteVersion);
          setBaseline(JSON.stringify(verifiedSnapshot.site));
          setStatus("Saved and verified from persistent storage.");
        } else {
          setStatus("Save returned OK, but reload verification failed. Check DATA_PROVIDER and Supabase.");
        }
      } catch {
        setStatus("Saved, but verification could not reload admin data.");
      } finally {
        void loadPersistence();
      }
    } catch {
      setStatus("Save failed. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  const persistenceWarning = Boolean(
    persistence
    && persistence.appMode === "live"
    && persistence.dataProvider !== "supabase",
  );
  const persistenceStatus = persistence ? (
    <div
      className={`admin-persistence-status${persistenceWarning ? " is-warning" : ""}`}
      role={persistenceWarning ? "alert" : undefined}
    >
      <span>APP_MODE <strong>{persistence.appMode}</strong></span>
      <span>DATA_PROVIDER <strong>{persistence.dataProvider}</strong></span>
      <span>Durable storage <strong>{persistence.isDurableProvider ? "yes" : "no"}</strong></span>
      <span>
        Site document{" "}
        <strong>{persistence.siteVersion === null ? "unversioned" : `v${persistence.siteVersion}`}</strong>
        {persistence.siteUpdatedAt
          ? ` - ${new Date(persistence.siteUpdatedAt).toLocaleString()}`
          : ""}
      </span>
      {persistenceWarning && <strong>Live mode requires DATA_PROVIDER=supabase.</strong>}
    </div>
  ) : null;

  if (!snapshot || !site) {
    return (
      <div className="admin-loading" role="status" aria-live="polite">
        <span className="spinner" />
        <span>{status}</span>
        {persistenceStatus}
      </div>
    );
  }

  const currentSnapshot = { ...snapshot, site };

  return (
    <div className={`admin-shell ${styles.adminShell}`}>
      <a className="skip-link" href="#admin-main-content">Skip to admin content</a>
      {navigationOpen && (
        <button
          aria-label="Close admin navigation"
          className={styles.backdrop}
          onClick={() => setNavigationOpen(false)}
          type="button"
        />
      )}
      <aside
        aria-label="Admin navigation"
        aria-hidden={!navigationOpen ? undefined : false}
        className={`admin-sidebar ${styles.sidebar}${navigationOpen ? ` ${styles.sidebarOpen}` : ""}`}
        id="admin-mobile-navigation"
      >
        <div className={styles.sidebarHeader}>
          <Link className="admin-wordmark" href="/">
            <strong>SKIE</strong>
            <small>CONTROL</small>
          </Link>
          <button className={styles.closeButton} type="button" onClick={() => setNavigationOpen(false)} aria-label="Close sections menu">×</button>
        </div>

        <nav aria-label="Admin sections">
          {tabs.map((item) => (
            <button
              key={item}
              className={tab === item ? "is-active" : ""}
              aria-pressed={tab === item}
              onClick={() => selectTab(item)}
              type="button"
            >
              {item}
              <span aria-hidden="true">open</span>
            </button>
          ))}
        </nav>

        <div className="admin-sidebar-footer">
          <Link href="/skie-control/check-in" target="_blank">
            Open door mode
          </Link>
          <LogoutButton admin />
        </div>
      </aside>

      <main className={`admin-main ${styles.main}`} id="admin-main-content" tabIndex={-1}>
        <header className={`admin-topbar ${styles.topbar}`}>
          <button
            aria-controls="admin-mobile-navigation"
            aria-expanded={navigationOpen}
            className={styles.mobileMenuButton}
            onClick={() => setNavigationOpen(true)}
            type="button"
          >
            <span aria-hidden="true">☰</span>
            Sections
          </button>
          <div>
            <p>Production control system</p>
            <h1 ref={headingRef} tabIndex={-1}>{tab}</h1>
          </div>
          {persistenceStatus}
          <div className={`admin-actions ${styles.topbarActions}`}>
            <span aria-live="polite" className={dirty ? "status-dot is-dirty" : "status-dot"} role="status">
              {status}
            </span>
            <Link href="/" target="_blank">
              View site
            </Link>
            {staleSave && (
              <button className="button button-ghost" onClick={() => void load()} type="button">
                Reload latest
              </button>
            )}
            <button
              className="button button-primary"
              disabled={!dirty || saving}
              onClick={save}
              type="button"
            >
              {saving ? "Saving..." : "Save changes"}
            </button>
          </div>
        </header>

        {tab === "Overview" && <OverviewPanel snapshot={currentSnapshot} />}
        {tab === "Analytics" && <AnalyticsPanel events={site.events} />}
        {tab === "Events" && <EventsPanel site={site} setSite={setSite} />}
        {tab === "Applications" && (
          <ApplicationsPanel
            applications={snapshot.applications}
            defaultExpiryHours={site.settings.defaultAllocationExpiryHours}
            onChanged={load}
            timezone={site.settings.timezone}
          />
        )}
        {tab === "Customers" && (
          <CustomersPanel customers={snapshot.ops.users} onChanged={load} />
        )}
        {tab === "Ticketing" && (
          <TicketingPanel
            defaultExpiryHours={site.settings.defaultAllocationExpiryHours}
            snapshot={currentSnapshot}
            onChanged={load}
            timezone={site.settings.timezone}
          />
        )}
        {tab === "Payment recovery" && <PaymentRecoveryPanel timezone={site.settings.timezone} />}
        {tab === "Launch readiness" && <LaunchReadinessPanel snapshot={currentSnapshot} />}
        {tab === "Products" && <ProductsPanel site={site} setSite={setSite} />}
        {tab === "Promo codes" && <PromoCodesPanel events={site.events} products={site.products} />}
        {tab === "Sponsors" && <SponsorsPanel site={site} setSite={setSite} />}
        {tab === "Forms" && <FormsPanel site={site} setSite={setSite} />}
        {tab === "Media" && <MediaPanel site={site} setSite={setSite} />}
        {tab === "Reviews" && <ReviewsPanel site={site} setSite={setSite} />}
        {tab === "Emails" && (
          <EmailsPanel snapshot={currentSnapshot} site={site} setSite={setSite} />
        )}
        {tab === "Exports" && (
          <ExportsPanel snapshot={currentSnapshot} onChanged={refreshSnapshot} />
        )}
        {tab === "Check-in" && <CheckInPanel snapshot={currentSnapshot} />}
        {tab === "Event staff" && <StaffPanel events={site.events} timezone={site.settings.timezone} />}
        {tab === "Website" && <WebsitePanel site={site} setSite={setSite} />}
        {tab === "Settings" && <SettingsPanel site={site} setSite={setSite} />}
        {tab === "Audit logs" && <AuditLogsPanel snapshot={currentSnapshot} />}
      </main>
    </div>
  );
}
