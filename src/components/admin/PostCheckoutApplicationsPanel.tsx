"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccessibleDialog } from "@/components/AccessibleDialog";
import { formatDateTime, moneyCents } from "@/lib/format";
import { canSupersedeQueuedFormTimeout } from "@/lib/post-approval/admin-classification";
import { customerFormTargetAt, type PostCheckoutAdminItem, type PostCheckoutDecision } from "@/lib/post-approval/types";

function mergeUnique(current: PostCheckoutAdminItem[], incoming: PostCheckoutAdminItem[]) {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}

function guestlistPromo(item: PostCheckoutAdminItem) {
  return item.promo?.guestlistApplication === true
    || String(item.promo?.discountType) === "guestlist";
}

function noPaymentGuestlistApplication(item: PostCheckoutAdminItem) {
  return guestlistPromo(item) && item.paymentStatus === "not_required";
}

export function PostCheckoutApplicationsPanel({ timezone }: { timezone: string }) {
  const dialog = useAccessibleDialog();
  const requestVersion = useRef(0);
  const [items, setItems] = useState<PostCheckoutAdminItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState("active");
  const [search, setSearch] = useState("");
  const [nextCursor, setNextCursor] = useState<string>();

  const load = useCallback(async (options: { append?: boolean; cursor?: string } = {}) => {
    const append = Boolean(options.append);
    const requestId = ++requestVersion.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    try {
      const query = new URLSearchParams({ filter, search: search.trim(), limit: "50" });
      if (options.cursor) query.set("cursor", options.cursor);
      const response = await fetch(`/api/admin/post-checkout?${query.toString()}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as {
        enabled?: boolean;
        acceptingNew?: boolean;
        error?: string;
        applications?: PostCheckoutAdminItem[];
        nextCursor?: string;
      };
      if (requestId !== requestVersion.current) return;
      if (!response.ok) {
        setMessage(body.error || "Post-checkout applications could not be loaded.");
        return;
      }
      setEnabled(body.enabled !== false);
      setItems((current) => append
        ? mergeUnique(current, body.applications || [])
        : body.applications || []);
      setNextCursor(body.nextCursor);
    } catch {
      if (requestId === requestVersion.current) {
        setMessage("Post-checkout applications could not be loaded. Check the connection and refresh.");
      }
    } finally {
      if (requestId === requestVersion.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [filter, search]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 250);
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  async function sendAction(payload: Record<string, unknown>, success: string) {
    setBusy(String(payload.applicationId || payload.actionId || payload.orderId || "action"));
    setMessage("");
    try {
      const response = await fetch("/api/admin/post-checkout", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      setMessage(response.ok ? success : body.error || "Action failed.");
      await load();
    } catch {
      setMessage("The request could not reach the server. The record has been refreshed; confirm its current state before trying again.");
      await load();
    } finally {
      setBusy("");
    }
  }

  async function decide(item: PostCheckoutAdminItem, decision: PostCheckoutDecision) {
    const noPaymentGuestlist = noPaymentGuestlistApplication(item);
    const recoveringTimeout = decision === "approve_without_form" && canSupersedeQueuedFormTimeout(item);
    const title = decision === "approve"
      ? noPaymentGuestlist ? "Approve and issue guest-list ticket?" : "Approve and capture payment?"
      : recoveringTimeout ? "Approve after the form deadline?"
        : decision === "approve_without_form"
          ? noPaymentGuestlist ? "Issue guest-list ticket without the mandatory form?" : "Approve without the mandatory form?"
          : noPaymentGuestlist ? "Reject and release guest-list place?" : "Reject and release authorisation?";
    const description = decision === "approve"
      ? noPaymentGuestlist
        ? "Issue the free ticket only after confirming this submitted application? No Stripe payment exists for this ticket-only guest-list request."
        : `Capture ${moneyCents(item.order.totalCents)} only after confirming this submitted application? Tickets and paid add-ons are fulfilled after Stripe confirms capture.`
      : recoveringTimeout
        ? `The actual form window passed and automatic cancellation is queued. Capture ${moneyCents(item.order.totalCents)} only if Stripe cancellation has not started? The database will atomically supersede the unclaimed cancellation.`
        : decision === "approve_without_form"
          ? noPaymentGuestlist
            ? `This application is only ${item.completionPercentage}% complete. Issue the free ticket as a deliberate administrative exception?`
            : `This application is only ${item.completionPercentage}% complete. Capture ${moneyCents(item.order.totalCents)} and issue tickets and add-ons after Stripe confirmation? This remains available only while the card authorisation is safely capturable.`
          : noPaymentGuestlist
            ? "Reject the application and release its reserved event capacity? No ticket will be issued."
            : `Cancel the ${moneyCents(item.order.totalCents)} payment authorisation and release the ticket and add-on reservation?`;
    const confirmLabel = decision === "reject"
      ? "Reject and release"
      : noPaymentGuestlist ? "Approve and issue ticket" : "Approve and capture";
    if (!await dialog.confirm({
      title,
      description,
      confirmLabel,
      danger: decision !== "approve",
    })) return;
    const reason = await dialog.prompt({
      title: "Internal decision reason",
      description: "This reason is required and stored in the immutable approval audit trail.",
      inputLabel: "Reason",
      defaultValue: decision === "approve"
        ? noPaymentGuestlist ? "Guest-list application reviewed and approved" : "Application reviewed and approved"
        : decision === "approve_without_form" ? "Administrative exception" : "Application not selected",
      confirmLabel: "Continue",
    });
    if (!reason?.trim()) return;
    const success = decision === "reject"
      ? noPaymentGuestlist ? "Guest-list application rejected and capacity released." : "Rejection requested. Stripe cancellation is being confirmed."
      : noPaymentGuestlist ? "Guest-list application approved and ticket fulfilment completed." : "Approval recorded. Stripe capture is being confirmed.";
    await sendAction({
      action: "decision",
      applicationId: item.id,
      decision,
      internalReason: reason.trim(),
    }, success);
  }

  async function extend(item: PostCheckoutAdminItem) {
    const defaultValue = new Date(Math.max(
      Date.now() + 60 * 60 * 1000,
      new Date(item.formDueAt).getTime() + 60 * 60 * 1000,
    )).toISOString();
    const noPaymentGuestlist = noPaymentGuestlistApplication(item);
    const value = await dialog.prompt({
      title: "Extend actual form availability",
      description: noPaymentGuestlist
        ? "Enter an ISO date and time. This extends the guest-list form window; no Stripe capture deadline applies."
        : "Enter an ISO date and time. The customer-facing completion target stays short, but the actual availability may be extended only while Stripe can still be captured safely.",
      inputLabel: "New actual deadline",
      defaultValue,
      confirmLabel: "Extend availability",
    });
    if (!value) return;
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) { setMessage("Enter a valid date and time."); return; }
    await sendAction({ action: "extend", applicationId: item.id, formDueAt: parsed.toISOString() }, "Actual form availability extended.");
  }

  if (enabled === false) return null;

  return <section className="admin-section admin-stack post-checkout-admin">
    <div className="admin-section-title"><div><h2>Post-checkout approvals</h2><p>Paid applications capture Stripe only after approval. Ticket-only guest-list applications require the same form and decision but no payment.</p></div><button className="button button-ghost" type="button" onClick={() => void load()}>Refresh</button></div>
    <div className="admin-filter-bar">
      <input placeholder="Search customer, email or promo" value={search} onChange={(event) => setSearch(event.target.value)} />
      <select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="active">Active</option><option value="attention">Needs attention</option><option value="needs_form">Awaiting form</option><option value="review">Needs review</option><option value="expiry">Approaching expiry</option><option value="completed">Completed</option><option value="all">All</option></select>
    </div>
    {message && <p className="admin-notice" role="status">{message}</p>}
    {loading && <div className="admin-loading" role="status"><span className="spinner" />Loading post-checkout applications…</div>}
    <div className="application-admin-list">
      {items.map((item) => {
        const guestlist = guestlistPromo(item);
        const noPaymentGuestlist = noPaymentGuestlistApplication(item);
        const paymentReady = item.paymentStatus === "authorized"
          || (noPaymentGuestlist && item.paymentStatus === "not_required");
        const awaitingForm = ["awaiting_form", "draft"].includes(item.status) && paymentReady;
        const recoverableTimeout = canSupersedeQueuedFormTimeout(item);
        const reviewable = ["submitted", "under_review"].includes(item.status) && paymentReady;
        const rejectable = ["awaiting_form", "draft", "submitted", "under_review"].includes(item.status) && paymentReady;
        const processablePayment = item.paymentAction && ["requested", "retry"].includes(item.paymentAction.status);
        const guestlistRetry = noPaymentGuestlist
          && ["approved", "approved_override", "manual_review"].includes(item.status)
          && item.order.status !== "fulfilled";
        const amountLabel = noPaymentGuestlist
          ? "Payment required"
          : guestlist ? "Authorised add-ons" : "Authorised amount";
        return <article className="application-admin-card" key={item.id}>
          <header><div><span className={`status-pill status-${item.status}`}>{item.status.replaceAll("_", " ")}</span><h3>{item.customer.firstName} {item.customer.lastName}</h3><p>{item.customer.email} · {item.customer.phone || "No phone"} · {item.customer.instagram || "No Instagram"}</p></div><div><strong>{item.event.title}</strong><small>{formatDateTime(item.createdAt, timezone)}</small></div></header>
          <div className="admin-grid-three">
            <div><small>{amountLabel}</small><strong>{noPaymentGuestlist ? "None" : moneyCents(item.order.totalCents)}</strong></div>
            <div><small>Form progress</small><strong>{item.completionPercentage}%</strong></div>
            <div><small>Payment status</small><strong>{item.paymentStatus.replaceAll("_", " ")}</strong></div>
            <div><small>Customer target</small><strong>{formatDateTime(customerFormTargetAt(item), timezone)}</strong></div>
            <div><small>Actual form availability</small><strong>{formatDateTime(item.formDueAt, timezone)}</strong></div>
            <div><small>Stripe capture deadline</small><strong>{noPaymentGuestlist ? "Not required" : item.captureBefore ? formatDateTime(item.captureBefore, timezone) : "Awaiting Stripe"}</strong></div>
            <div><small>Last activity</small><strong>{formatDateTime(item.lastActivityAt, timezone)}</strong></div>
          </div>
          {item.promo && <div className="admin-card"><small>{guestlist ? "Guest-list application code" : item.promo.trackingOnly ? "Promoter tracking code" : "Promo code"}</small><strong>{item.promo.code}</strong><p>{item.promo.internalName}{guestlist ? " · eligible ticket free after approval · add-ons remain payable" : item.promo.trackingOnly ? " · tracking only" : ` · discount ${moneyCents(item.order.discountCents)}`}</p><p>Subtotal {moneyCents(item.order.subtotalCents)} · {guestlist ? `payment total ${moneyCents(item.order.totalCents)}` : `authorised ${moneyCents(item.order.totalCents)}`}</p></div>}
          {recoverableTimeout && <p className="duplicate-warning">The form deadline passed, but Stripe cancellation is still queued and has not started. An admin override can safely supersede it.</p>}
          {!item.order.pricingIntegrity && <p className="duplicate-warning">Pricing snapshot mismatch. Do not approve until payment recovery is reviewed.</p>}
          {item.paymentStatus === "captured" && item.order.status !== "fulfilled" && <p className="duplicate-warning">Payment was captured but ticket fulfilment is incomplete. Review Payment Recovery before taking another action.</p>}
          {guestlistRetry && <p className="duplicate-warning">The guest-list decision was approved, but ticket fulfilment is incomplete. Retry fulfilment before closing this record.</p>}
          <details><summary>Ticket and add-on snapshot <span>+</span></summary><ul>{item.order.items.map((line) => <li key={`${line.kind}-${line.referenceId}`}>{line.quantity} × {line.name} · {moneyCents(line.quantity * line.unitPriceCents)}</li>)}</ul></details>
          <details><summary>{item.submittedAnswers ? "Submitted answers" : "Saved draft answers"} <span>+</span></summary><pre>{JSON.stringify(item.submittedAnswers || item.draftAnswers, null, 2)}</pre></details>
          {item.overrideUsed && <p className="duplicate-warning">Approved without completed form: {item.overrideReason}</p>}
          {item.decision && <p className="admin-field-note">Decision: {item.decision.decision.replaceAll("_", " ")} · {item.decision.internalReason}</p>}
          {item.paymentAction && <p className={item.paymentAction.status === "manual_review" || item.paymentAction.status === "failed" ? "duplicate-warning" : "admin-field-note"}>Payment action: {item.paymentAction.actionType} · {item.paymentAction.status.replaceAll("_", " ")} · attempt {item.paymentAction.attemptCount}{item.paymentAction.safeErrorCode ? ` · ${item.paymentAction.safeErrorCode}` : ""}</p>}
          <div className="application-actions">
            {awaitingForm && <><button type="button" disabled={busy === item.id} onClick={() => void sendAction({ action: "reminder", applicationId: item.id }, "Form email queued.")}>Send form email</button><button type="button" disabled={busy === item.id} onClick={() => void sendAction({ action: "reminder", applicationId: item.id, final: true }, "Final form reminder queued.")}>Send final reminder</button><button type="button" disabled={busy === item.id} onClick={() => void extend(item)}>Extend actual availability</button></>}
            {(awaitingForm || recoverableTimeout) && <button className="approve-action" type="button" disabled={busy === item.id} onClick={() => void decide(item, "approve_without_form")}>{noPaymentGuestlist ? "Issue without form" : "Approve without form"}</button>}
            {reviewable && <button className="approve-action" type="button" disabled={busy === item.id} onClick={() => void decide(item, "approve")}>{noPaymentGuestlist ? "Approve and issue ticket" : "Approve and capture"}</button>}
            {rejectable && <button className="reject-action" type="button" disabled={busy === item.id} onClick={() => void decide(item, "reject")}>Reject and release</button>}
            {processablePayment && !recoverableTimeout && <button type="button" disabled={busy === item.paymentAction?.id} onClick={() => void sendAction({ action: "process_payment", actionId: item.paymentAction?.id }, "Payment action processed or safely queued for retry.")}>Process payment now</button>}
            {item.paymentAction && ["manual_review", "failed"].includes(item.paymentAction.status) && <button type="button" disabled={busy === item.id} onClick={() => void sendAction({ action: "retry_payment", applicationId: item.id }, "Payment action returned to the durable retry queue.")}>Retry payment action</button>}
            {guestlistRetry && <button type="button" disabled={busy === item.orderId} onClick={() => void sendAction({ action: "retry_guestlist", orderId: item.orderId }, "Guest-list ticket fulfilment completed.")}>Retry guest-list fulfilment</button>}
          </div>
        </article>;
      })}
      {!loading && !items.length && <div className="admin-empty">No post-checkout applications match this filter.</div>}
      {nextCursor && <button className="button button-ghost" disabled={loadingMore} type="button" onClick={() => void load({ append: true, cursor: nextCursor })}>{loadingMore ? "Loading..." : "Load more"}</button>}
    </div>
  </section>;
}
