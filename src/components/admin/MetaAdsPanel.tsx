"use client";

import { useCallback, useEffect, useState } from "react";
import { moneyCents } from "@/lib/format";
import type { MetaDashboardReport } from "@/lib/meta/types";

type MetaDashboardBody = {
  configuration: {
    pixelId: string;
    pixelConfigured: boolean;
    capiRequested: boolean;
    capiConfigured: boolean;
    capiEnabled: boolean;
    graphApiVersionConfigured: boolean;
    accessTokenConfigured: boolean;
    testMode: boolean;
    consentMode: string;
    consentVersion: string;
  };
  delivery: MetaDashboardReport;
  firstPartyEstimate: {
    startDate: string;
    endDate: string;
    pageViews: number;
    eventViews: number;
    applications: number;
    checkouts: number;
    completedPayments: number;
  };
};

type MetaActionBody = {
  error?: string;
  result?: {
    delivered?: boolean;
    queued?: boolean;
    status?: string;
    processed?: number;
    sent?: number;
    retry?: number;
    failed?: number;
  };
};

function healthLabel(value: boolean, ready = "Ready", missing = "Needs setup") {
  return value ? ready : missing;
}

function skippedCount(total: number, sent: number, pending: number, failed: number) {
  return Math.max(0, total - sent - pending - failed);
}

export function MetaAdsPanel() {
  const [body, setBody] = useState<MetaDashboardBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/meta", { cache: "no-store" });
      const result = await response.json() as MetaDashboardBody & { error?: string };
      if (!response.ok) throw new Error(result.error || "Meta ads data could not be loaded.");
      setBody(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Meta ads data could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let current = true;
    void fetch("/api/admin/meta", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json() as MetaDashboardBody & { error?: string };
        if (!response.ok) throw new Error(result.error || "Meta ads data could not be loaded.");
        return result;
      })
      .then((result) => {
        if (current) {
          setBody(result);
          setMessage("");
        }
      })
      .catch((error) => {
        if (current) setMessage(error instanceof Error ? error.message : "Meta ads data could not be loaded.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => { current = false; };
  }, []);

  async function action(actionName: "retry" | "test") {
    setWorking(true);
    setMessage(actionName === "retry" ? "Retrying queued Meta events..." : "Sending Meta test event...");
    try {
      const response = await fetch("/api/admin/meta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: actionName }),
      });
      const result = await response.json() as MetaActionBody;
      if (!response.ok) throw new Error(result.error || "Meta action failed.");
      await load();
      if (actionName === "retry") {
        setMessage(`Processed ${result.result?.processed || 0} queued event(s): ${result.result?.sent || 0} sent, ${result.result?.retry || 0} retrying, ${result.result?.failed || 0} failed.`);
      } else if (result.result?.delivered) {
        setMessage("Meta test event delivered. Confirm it in Events Manager → Test events.");
      } else {
        setMessage(`Meta test event status: ${result.result?.status || (result.result?.queued ? "queued" : "not delivered")}. Check the recent delivery result below.`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Meta action failed.");
    } finally {
      setWorking(false);
    }
  }

  if (loading && !body) {
    return <div className="admin-loading" role="status"><span className="spinner" /><span>Loading Meta ads</span></div>;
  }
  if (!body) return <p className="admin-notice" role="alert">{message || "Meta ads data is unavailable."}</p>;

  const { configuration, delivery, firstPartyEstimate } = body;
  const totalSkipped = skippedCount(
    delivery.totals.events,
    delivery.totals.sent,
    delivery.totals.pending,
    delivery.totals.failed,
  );
  const sendRate = delivery.totals.events
    ? Math.round((delivery.totals.sent / delivery.totals.events) * 100)
    : 0;

  return (
    <section className="admin-section">
      <div className="admin-section-title">
        <div>
          <p className="eyebrow"><span />Meta measurement</p>
          <h2>PIXEL + CONVERSIONS API</h2>
          <p>Consent-gated browser activity and authoritative server events for applications, checkout starts and fulfilled paid orders.</p>
        </div>
        <div className="admin-actions">
          <button className="button button-ghost" disabled={working} onClick={() => void load()} type="button">Refresh</button>
          <button className="button button-ghost" disabled={working || !configuration.capiConfigured} onClick={() => void action("retry")} type="button">Retry queue</button>
          <button className="button button-primary" disabled={working || !configuration.capiConfigured || !configuration.testMode} onClick={() => void action("test")} type="button">Send test event</button>
        </div>
      </div>

      {message && <p className="admin-notice" aria-live="polite">{message}</p>}

      <div className="stat-grid">
        <div><small>Delivered</small><strong>{delivery.totals.sent}</strong><span>{sendRate}% delivery rate</span></div>
        <div><small>Queued / retry</small><strong>{delivery.totals.pending}</strong><span>Processed by operations worker</span></div>
        <div><small>Failed / skipped</small><strong>{delivery.totals.failed} / {totalSkipped}</strong><span>Errors / unavailable match data</span></div>
        <div><small>Purchase value sent</small><strong>{moneyCents(delivery.totals.purchaseValueCents)}</strong><span>Gross fulfilled value; use SKIE revenue for refunds</span></div>
      </div>

      <div className="admin-grid-two">
        <div className="admin-card">
          <h3>Integration health</h3>
          <div className="analytics-metrics">
            <div><span>Browser Pixel</span><strong>{healthLabel(configuration.pixelConfigured)}</strong></div>
            <div><span>Dataset / Pixel ID</span><strong>{configuration.pixelId || "Missing"}</strong></div>
            <div><span>Conversions API</span><strong>{healthLabel(configuration.capiEnabled, "Enabled", configuration.capiRequested ? "Incomplete" : "Disabled")}</strong></div>
            <div><span>Graph API version</span><strong>{healthLabel(configuration.graphApiVersionConfigured)}</strong></div>
            <div><span>Access token</span><strong>{healthLabel(configuration.accessTokenConfigured, "Stored securely", "Missing")}</strong></div>
            <div><span>Consent</span><strong>Opt-in · {configuration.consentVersion}</strong></div>
            <div><span>Test Events mode</span><strong>{configuration.testMode ? "Active" : "Off"}</strong></div>
          </div>
        </div>
        <div className="admin-card">
          <h3>First-party funnel reference</h3>
          <p>{firstPartyEstimate.startDate} to {firstPartyEstimate.endDate}</p>
          <div className="analytics-metrics">
            <div><span>Page views</span><strong>{firstPartyEstimate.pageViews}</strong></div>
            <div><span>Event views</span><strong>{firstPartyEstimate.eventViews}</strong></div>
            <div><span>Applications</span><strong>{firstPartyEstimate.applications}</strong></div>
            <div><span>Checkout starts</span><strong>{firstPartyEstimate.checkouts}</strong></div>
            <div><span>Completed payments</span><strong>{firstPartyEstimate.completedPayments}</strong></div>
          </div>
          <p>These are SKIE’s privacy-reduced first-party totals. Meta totals will normally be lower because optional advertising consent, browser blocking and Meta matching affect delivery and attribution.</p>
        </div>
      </div>

      <div className="admin-card">
        <h3>Meta event delivery</h3>
        {delivery.byEvent.length === 0 ? (
          <p>No server-side Meta events are recorded for this period.</p>
        ) : (
          <div className="analytics-table">
            <div className="analytics-row analytics-head"><span>Event</span><span>Delivery</span><span>Value</span></div>
            {delivery.byEvent.map((item) => {
              const skipped = skippedCount(item.total, item.sent, item.pending, item.failed);
              return (
                <div className="analytics-row" key={item.eventName}>
                  <strong>{item.eventName}</strong>
                  <span>{item.sent} / {item.total} sent · {item.pending} pending · {item.failed} failed · {skipped} skipped</span>
                  <span>{moneyCents(item.valueCents)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="admin-card">
        <h3>Recent privacy-safe deliveries</h3>
        {delivery.recent.length === 0 ? (
          <p>No delivery records yet.</p>
        ) : (
          <div className="analytics-table">
            <div className="analytics-row analytics-head"><span>Event</span><span>Status</span><span>Result</span></div>
            {delivery.recent.map((item) => (
              <div className="analytics-row" key={item.id}>
                <strong>{item.eventName}<small>{new Date(item.occurredAt).toLocaleString()} · {item.sourceEvent}</small></strong>
                <span>{item.status} · {item.attemptCount} attempt{item.attemptCount === 1 ? "" : "s"}</span>
                <span>{item.safeErrorCode || (item.eventsReceived !== undefined ? `${item.eventsReceived} received` : "—")}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
