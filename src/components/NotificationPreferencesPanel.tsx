"use client";

import { useEffect, useState } from "react";
import type { NotificationOutboxItem } from "@/types/site";

type Preferences = { email: boolean; sms: boolean; in_app: boolean; whatsapp: boolean };
const defaults: Preferences = { email: true, sms: false, in_app: true, whatsapp: false };

export function NotificationPreferencesPanel() {
  const [preferences, setPreferences] = useState(defaults);
  const [notifications, setNotifications] = useState<NotificationOutboxItem[]>([]);
  const [status, setStatus] = useState("Loading notification preferences...");
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let active = true;
    void fetch("/api/account/notifications", { cache: "no-store" }).then(async (response) => {
      const body = await response.json();
      if (!active) return;
      if (!response.ok) setStatus(body.error || "Notification preferences could not be loaded.");
      else { setPreferences(body.preferences); setNotifications(body.notifications || []); setStatus(""); }
      setBusy(false);
    }).catch(() => { if (active) { setStatus("Notification preferences could not be loaded."); setBusy(false); } });
    return () => { active = false; };
  }, []);

  async function save() {
    setBusy(true); setStatus("Saving...");
    try {
      const response = await fetch("/api/account/notifications", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(preferences) });
      const body = await response.json();
      if (!response.ok) setStatus(body.error || "Notification preferences could not be saved.");
      else { setPreferences(body.preferences); setStatus("Notification preferences saved."); }
    } catch { setStatus("Notification preferences could not be saved."); }
    finally { setBusy(false); }
  }

  return <section className="account-section" aria-labelledby="notification-preferences-title">
    <div className="account-section-title"><div><p className="eyebrow"><span />Stay informed</p><h2 id="notification-preferences-title">Notification preferences</h2></div></div>
    <div className="account-card admin-stack">
      {(["email", "sms", "in_app"] as const).map((channel) => <label className="checkbox-row" key={channel}>
        <input type="checkbox" checked={preferences[channel]} disabled={busy} onChange={(event) => setPreferences((current) => ({ ...current, [channel]: event.target.checked }))} />
        <span>{channel === "email" ? "Email" : channel === "sms" ? "Transactional SMS" : "In-app notifications"}</span>
      </label>)}
      <label className="checkbox-row"><input type="checkbox" checked={false} disabled /><span>WhatsApp (not currently available)</span></label>
      <p className="muted-copy">SMS is operational only, never marketing. Turning it on records separate consent; turning it off records withdrawal.</p>
      <button className="button button-primary" type="button" disabled={busy} onClick={() => void save()}>Save preferences</button>
      {status && <p className="form-message" role="status">{status}</p>}
    </div>
    <div className="account-list" aria-label="Recent in-app notifications">
      {notifications.slice(0, 10).map((item) => <article key={item.id}><div><span className={`status-pill status-${item.status}`}>{item.status}</span><h3>{item.templateKey.replaceAll("_", " ")}</h3><p>{new Date(item.createdAt).toLocaleString("en-AU")}</p></div></article>)}
      {!notifications.length && <div className="empty-state compact-empty">No in-app notifications yet.</div>}
    </div>
  </section>;
}
