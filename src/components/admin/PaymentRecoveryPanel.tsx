"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccessibleDialog } from "@/components/AccessibleDialog";
import { formatDateTime, moneyCents, statusLabel } from "@/lib/format";

type RecoveryItem = {
  kind: "payment" | "orphan_session" | "webhook";
  reservationId: string;
  orderId: string;
  eventId: string;
  status: string;
  totalCents: number;
  currency: string;
  failureCode?: string;
  sessionId?: string;
  paymentIntentId?: string;
  updatedAt: string;
};

type RecoveryAction = "retry_fulfilment" | "refresh_stripe" | "expire_session" | "request_refund" | "mark_resolved";

export function PaymentRecoveryPanel({ timezone }: { timezone: string }) {
  const dialog = useAccessibleDialog();
  const [items, setItems] = useState<RecoveryItem[]>([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("Loading payment recovery queue...");

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/payment-recovery", { cache: "no-store" });
    const body = await response.json().catch(() => null) as { items?: RecoveryItem[]; error?: string } | null;
    if (!response.ok) {
      setMessage(body?.error || "Payment recovery queue could not be loaded.");
      return;
    }
    setItems(body?.items || []);
    setMessage(body?.items?.length ? "" : "No payment recovery items require attention.");
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/payment-recovery", { cache: "no-store" })
      .then(async (response) => ({ response, body: await response.json().catch(() => null) as { items?: RecoveryItem[]; error?: string } | null }))
      .then(({ response, body }) => {
        if (cancelled) return;
        if (!response.ok) {
          setMessage(body?.error || "Payment recovery queue could not be loaded.");
          return;
        }
        setItems(body?.items || []);
        setMessage(body?.items?.length ? "" : "No payment recovery items require attention.");
      })
      .catch(() => { if (!cancelled) setMessage("Payment recovery queue could not be loaded."); });
    return () => { cancelled = true; };
  }, []);

  async function act(item: RecoveryItem, action: RecoveryAction) {
    const warning = action === "request_refund"
      ? "Request a full Stripe refund for this payment? This is a financial action and cannot be undone from this screen."
      : action === "expire_session"
        ? "Expire the active Stripe Checkout Session? The customer will need a new checkout."
        : `Run ${action.replaceAll("_", " ")} for this order?`;
    if (!await dialog.confirm({ title: action === "request_refund" ? "Request refund?" : "Run payment recovery action?", description: warning, confirmLabel: action === "request_refund" ? "Request refund" : "Run action", danger: action === "request_refund" || action === "expire_session" })) return;
    setBusy(item.orderId);
    setMessage("");
    const response = await fetch("/api/admin/payment-recovery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: item.orderId,
        reservationId: item.reservationId,
        action,
        operationId: crypto.randomUUID(),
      }),
    });
    const body = await response.json().catch(() => null) as { error?: string } | null;
    setMessage(response.ok ? "Recovery action completed and audited." : body?.error || "Recovery action failed.");
    setBusy("");
    await load();
  }

  return (
    <section className="admin-section admin-stack">
      <div className="admin-section-title">
        <div>
          <h2>Payment recovery</h2>
          <p>Durable payment, fulfilment, refund, dispute and manual-review states. Door roles cannot access these controls.</p>
        </div>
        <button className="admin-add" type="button" onClick={() => void load()}>Refresh queue</button>
      </div>
      {message && <p className="admin-notice" role="status">{message}</p>}
      <div className="audit-table admin-card">
        <div className="audit-row audit-head"><span>Status</span><span>Order / event</span><span>Amount / updated</span><span>Protected actions</span></div>
        {items.map((item) => (
          <div className="audit-row" key={item.reservationId}>
            <span>
              <strong className={`status-pill status-${item.status}`}>{statusLabel(item.status)}</strong>
              {item.failureCode && <small>{item.failureCode}</small>}
            </span>
            <span><strong>{item.orderId}</strong><small>{item.eventId}</small></span>
            <span><strong>{item.kind === "webhook" ? "Webhook inbox" : moneyCents(item.totalCents)}</strong><small>{formatDateTime(item.updatedAt, timezone)}</small></span>
            <span className="inline-admin-actions">
              {item.kind === "webhook" && <small>Retry is handled idempotently by the webhook worker.</small>}
              {item.kind !== "webhook" && item.sessionId && <button disabled={busy === item.orderId} type="button" onClick={() => void act(item, "refresh_stripe")}>Refresh Stripe</button>}
              {["payment_received", "fulfilment_pending", "paid_unfulfilled", "recovery_failed"].includes(item.status) && <button disabled={busy === item.orderId} type="button" onClick={() => void act(item, "retry_fulfilment")}>Retry fulfilment</button>}
              {item.sessionId && !item.paymentIntentId && <button disabled={busy === item.orderId} type="button" onClick={() => void act(item, "expire_session")}>Expire Session</button>}
              {item.paymentIntentId && !["refunded", "refund_pending"].includes(item.status) && <button className="danger-link" disabled={busy === item.orderId} type="button" onClick={() => void act(item, "request_refund")}>Request refund</button>}
              {["manual_review", "recovery_failed"].includes(item.status) && <button disabled={busy === item.orderId} type="button" onClick={() => void act(item, "mark_resolved")}>Mark resolved</button>}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
