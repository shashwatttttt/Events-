"use client";

import { useEffect, useState } from "react";
import { useAccessibleDialog } from "@/components/AccessibleDialog";
import type { AdminSnapshot } from "@/components/admin/types";
import { formatDateTime, statusLabel } from "@/lib/format";
import type { NotificationAttempt, NotificationOutboxItem, SiteData } from "@/types/site";

const templateKeys = [
  "application_received", "ticket_unlocked", "waitlist", "not_selected", "payment_confirmed",
  "ticket_issued", "ticket_resend", "refund_invalidation", "event_update", "event_cancellation",
  "event_reminder", "payment_reminder", "admin_manual_message",
] as const;
const channels = ["email", "sms", "in_app", "whatsapp"] as const;
type Preview = { channel: string; subject?: string; html?: string; text?: string; title?: string; body?: string; href?: string };

export function EmailsPanel({ site }: { snapshot: AdminSnapshot; site: SiteData; setSite: (site: SiteData) => void }) {
  const dialog = useAccessibleDialog();
  const [items, setItems] = useState<NotificationOutboxItem[]>([]);
  const [attempts, setAttempts] = useState<NotificationAttempt[]>([]);
  const [templateKey, setTemplateKey] = useState<(typeof templateKeys)[number]>("ticket_issued");
  const [channel, setChannel] = useState<(typeof channels)[number]>("email");
  const [recipient, setRecipient] = useState("local@example.test");
  const [orderId, setOrderId] = useState("");
  const [eventId, setEventId] = useState("");
  const [manualCustomerId, setManualCustomerId] = useState("");
  const [manualSubject, setManualSubject] = useState("");
  const [manualMessage, setManualMessage] = useState("");
  const [status, setStatus] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  async function load() {
    const response = await fetch("/api/admin/notifications", { cache: "no-store" });
    if (!response.ok) return;
    const body = await response.json() as { items: NotificationOutboxItem[]; attempts: NotificationAttempt[] };
    setItems(body.items); setAttempts(body.attempts);
  }

  useEffect(() => {
    let active = true;
    void fetch("/api/admin/notifications", { cache: "no-store" }).then(async (response) => {
      if (!response.ok || !active) return;
      const body = await response.json() as { items: NotificationOutboxItem[]; attempts: NotificationAttempt[] };
      if (active) { setItems(body.items); setAttempts(body.attempts); }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function act(body: Record<string, unknown>) {
    setBusy(true); setStatus("");
    try {
      const response = await fetch("/api/admin/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) { setStatus(result.error || "Notification action failed."); return; }
      if (body.action === "preview") setPreview(result);
      else { setStatus("Notification action recorded."); setSelected([]); await load(); }
    } catch { setStatus("Notification action failed."); }
    finally { setBusy(false); }
  }

  async function retrySelected() {
    const notificationIds = selected.filter((id) => ["retry", "temporary_failure", "failed"].includes(items.find((item) => item.id === id)?.status || ""));
    if (!await dialog.confirm({ title: "Retry failed notifications?", description: `Retry ${notificationIds.length} failed notification(s)?`, confirmLabel: "Retry notifications" })) return;
    await act({ action: "bulk_retry", notificationIds });
  }

  async function resendSelected() {
    const orderIds = [...new Set(selected.map((id) => items.find((item) => item.id === id)?.orderId).filter((id): id is string => Boolean(id)))];
    if (!await dialog.confirm({ title: "Resend ticket notifications?", description: `Queue ticket resends for ${orderIds.length} order(s)?`, confirmLabel: "Queue resends" })) return;
    await act({ action: "bulk_resend_ticket", orderIds });
  }

  return <section className="admin-section admin-stack">
    <div className="admin-section-title"><div><h2>Notification delivery</h2><p>Durable email, SMS and in-app delivery, with WhatsApp disabled until separately configured. Recipients are redacted.</p></div></div>
    <div className="admin-card admin-grid-three">
      <label className="admin-field"><span>Template</span><select value={templateKey} onChange={(event) => setTemplateKey(event.target.value as typeof templateKey)}>{templateKeys.map((key) => <option key={key}>{key}</option>)}</select></label>
      <label className="admin-field"><span>Channel</span><select value={channel} onChange={(event) => setChannel(event.target.value as typeof channel)}>{channels.map((key) => <option key={key} disabled={key === "whatsapp"}>{key}</option>)}</select></label>
      <label className="admin-field"><span>Local test recipient</span><input value={recipient} onChange={(event) => setRecipient(event.target.value)} /></label>
      <label className="admin-field"><span>Fulfilled order ID (ticket templates)</span><input value={orderId} onChange={(event) => setOrderId(event.target.value)} /></label>
      <div className="admin-actions">
        <button className="button button-ghost" disabled={busy} type="button" onClick={() => void act({ action: "preview", templateKey, channel })}>Preview</button>
        <button className="button button-primary" disabled={busy} type="button" onClick={() => void act({ action: "test_send", templateKey, channel, recipient, ...(orderId ? { orderId } : {}) })}>Queue local test</button>
        <button className="button button-ghost" disabled={busy || !orderId} type="button" onClick={() => void act({ action: "resend_ticket", orderId })}>Resend ticket notifications</button>
      </div>
    </div>
    <div className="admin-card admin-stack">
      <h3>Channel controls</h3><p>Leave event ID blank for a global control. WhatsApp also requires the disabled-by-default server feature flag.</p>
      <label className="admin-field"><span>Optional event ID</span><input value={eventId} onChange={(event) => setEventId(event.target.value)} /></label>
      <div className="admin-actions">{channels.map((item) => <span key={item}><button type="button" disabled={busy} onClick={() => void act({ action: "set_control", channel: item, enabled: true, ...(eventId ? { eventId } : {}) })}>Enable {item}</button> <button type="button" disabled={busy} onClick={() => void act({ action: "set_control", channel: item, enabled: false, ...(eventId ? { eventId } : {}) })}>Disable {item}</button></span>)}</div>
    </div>
    <div className="admin-card admin-stack">
      <h3>Manual customer message</h3>
      <div className="admin-grid-three"><label className="admin-field"><span>Customer ID</span><input value={manualCustomerId} onChange={(event) => setManualCustomerId(event.target.value)} /></label><label className="admin-field"><span>Subject</span><input value={manualSubject} maxLength={120} onChange={(event) => setManualSubject(event.target.value)} /></label><label className="admin-field"><span>Event ID (optional)</span><input value={eventId} onChange={(event) => setEventId(event.target.value)} /></label></div>
      <label className="admin-field"><span>Message</span><textarea value={manualMessage} maxLength={1000} onChange={(event) => setManualMessage(event.target.value)} /></label>
      <button className="button button-primary" disabled={busy || !manualCustomerId || !manualSubject || !manualMessage} type="button" onClick={() => void act({ action: "manual_message", templateKey: ["event_reminder", "event_update", "event_cancellation", "admin_manual_message"].includes(templateKey) ? templateKey : "admin_manual_message", customerId: manualCustomerId, subject: manualSubject, message: manualMessage, ...(eventId ? { eventId } : {}) })}>Queue manual message</button>
    </div>
    {status && <p className="admin-notice" role="status">{status}</p>}
    {preview && <details open className="admin-card"><summary><strong>{preview.subject || preview.title || `${preview.channel} preview`}</strong></summary>{preview.channel === "email" ? <div className="admin-grid-two"><iframe className="email-log-body" referrerPolicy="no-referrer" sandbox="" srcDoc={preview.html} title={`Email preview: ${preview.subject}`} /><pre className="email-text-preview">{preview.text}</pre></div> : <div><p>{preview.body}</p><pre className="email-text-preview">{preview.text}</pre>{preview.href && <code>{preview.href}</code>}</div>}</details>}
    <div className="admin-section-title"><div><h2>Outbox and attempts</h2><p>{items.length} recent notifications.</p></div></div>
    <div className="admin-card admin-actions"><label><input type="checkbox" checked={items.length > 0 && items.every((item) => selected.includes(item.id))} onChange={(event) => setSelected(event.target.checked ? items.map((item) => item.id) : [])} /> Select recent</label><button type="button" disabled={busy || !selected.some((id) => ["retry", "temporary_failure", "failed"].includes(items.find((item) => item.id === id)?.status || ""))} onClick={() => void retrySelected()}>Retry selected failures</button><button type="button" disabled={busy || !selected.some((id)=>items.find((item)=>item.id===id)?.orderId)} onClick={() => void resendSelected()}>Resend selected orders</button></div>
    <div className="account-list">
      {items.map((item) => <details key={item.id}><summary><div><label onClick={(event)=>event.stopPropagation()}><input type="checkbox" aria-label={`Select notification ${item.id}`} checked={selected.includes(item.id)} onChange={(event)=>setSelected((current)=>event.target.checked?[...new Set([...current,item.id])]:current.filter((id)=>id!==item.id))}/> Select</label><span className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</span><h3>{item.channel} · {item.templateKey}</h3><p>{item.recipientAddress} · {formatDateTime(item.createdAt, site.settings.timezone)}</p></div><code>{item.orderId || item.eventId || item.id}</code></summary><div className="admin-card"><p>Attempts: {item.attemptCount}/{item.maxAttempts}{item.safeErrorCode ? ` · ${item.safeErrorCode}` : ""}</p>{attempts.filter((attempt) => attempt.outboxId === item.id).map((attempt) => <p key={attempt.id}>#{attempt.attemptNumber} {attempt.status}{attempt.safeErrorCode ? ` · ${attempt.safeErrorCode}` : ""}</p>)}<div className="admin-actions">{["retry", "temporary_failure", "failed"].includes(item.status) && <button type="button" onClick={() => void act({ action: "retry", notificationId: item.id })}>Retry</button>}{["queued", "retry", "temporary_failure"].includes(item.status) && <button type="button" onClick={() => void act({ action: "cancel", notificationId: item.id })}>Cancel</button>}</div></div></details>)}
      {!items.length && <div className="admin-empty">No queued notifications yet.</div>}
    </div>
  </section>;
}
