"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccessibleDialog } from "@/components/AccessibleDialog";
import type { AdminSnapshot } from "@/components/admin/types";
import { formatDateTime, moneyCents, statusLabel } from "@/lib/format";
import type { AdminSavedFilter, Ticket, TicketStatus } from "@/types/site";

export function TicketingPanel({
  defaultExpiryHours,
  snapshot,
  onChanged,
  timezone,
}: {
  defaultExpiryHours: number;
  snapshot: AdminSnapshot;
  onChanged: () => Promise<void>;
  timezone: string;
}) {
  const dialog = useAccessibleDialog();
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [selectedAllocations, setSelectedAllocations] = useState<string[]>([]);
  const [savedFilters,setSavedFilters]=useState<AdminSavedFilter[]>([]);
  useEffect(()=>{let active=true;void fetch("/api/admin/operations",{cache:"no-store"}).then(async(response)=>response.ok?response.json():null).then((body)=>{if(active&&body)setSavedFilters((body.savedFilters||[]).filter((item:AdminSavedFilter)=>item.scope==="ticketing"))}).catch(()=>undefined);return()=>{active=false}},[]);

  const matchingUserIds = useMemo(() => new Set(snapshot.ops.users.filter((user) => `${user.firstName} ${user.lastName} ${user.email} ${user.phone}`.toLowerCase().includes(search.toLowerCase())).map((user) => user.id)), [search, snapshot.ops.users]);
  const allocations = useMemo(() => snapshot.ops.allocations.filter((item) => !search || matchingUserIds.has(item.userId) || item.id.toLowerCase().includes(search.toLowerCase())), [matchingUserIds, search, snapshot.ops.allocations]);
  const orders = useMemo(() => snapshot.ops.orders.filter((item) => !search || matchingUserIds.has(item.userId) || item.id.toLowerCase().includes(search.toLowerCase())), [matchingUserIds, search, snapshot.ops.orders]);
  const tickets = useMemo(() => snapshot.ops.tickets.filter((item) => !search || matchingUserIds.has(item.userId) || `${item.id} ${item.orderId || ""} ${item.ticketCode} ${item.holderName} ${item.holderEmail}`.toLowerCase().includes(search.toLowerCase())), [matchingUserIds, search, snapshot.ops.tickets]);

  async function allocationAction(allocationId: string, action: "extend" | "cancel" | "unlock" | "remind") {
    const prompt = action === "cancel" ? "Cancel this unlocked allocation and its pending checkout?" : action === "extend" ? `Extend this allocation by ${defaultExpiryHours} hours?` : action === "remind" ? "Send a payment reminder now?" : "Unlock this allocation again?";
    if (!await dialog.confirm({ title: "Confirm allocation action", description: prompt, confirmLabel: action === "cancel" ? "Cancel allocation" : "Continue", danger: action === "cancel" })) return;
    setBusy(allocationId);
    setMessage("");
    const response = await fetch("/api/admin/allocations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allocationId, action, hours: defaultExpiryHours }),
    });
    const body = (await response.json()) as { error?: string };
    setMessage(response.ok ? `Allocation ${action} completed.` : body.error || "Allocation update failed.");
    setBusy("");
    if (response.ok) await onChanged();
  }

  async function ticketAction(ticketId: string, status: TicketStatus) {
    if (!await dialog.confirm({ title: "Change ticket status?", description: `Change this ticket to ${statusLabel(status)}?`, confirmLabel: "Change status", danger: ["cancelled", "refunded"].includes(status) })) return;
    setBusy(ticketId);
    const response = await fetch("/api/admin/tickets", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId, status }),
    });
    const body = (await response.json()) as { error?: string };
    setMessage(response.ok ? `Ticket moved to ${statusLabel(status)}.` : body.error || "Ticket update failed.");
    setBusy("");
    if (response.ok) await onChanged();
  }

  async function removeTestTicket(ticket: Ticket) {
    const reason = await dialog.prompt({
      title: "Why is this ticket test data?",
      description: "This reason is stored in the immutable audit trail. Real Stripe, refunded, checked-in or redeemed records cannot be removed.",
      inputLabel: "Removal reason",
      defaultValue: "Fake ticket created during checkout testing",
      confirmLabel: "Continue",
    });
    if (!reason?.trim()) return;
    const confirmation = await dialog.prompt({
      title: "Confirm test ticket removal",
      description: `Type ticket code ${ticket.ticketCode} exactly. The ticket will disappear from operational and analytics views, but protected transaction history is preserved.`,
      inputLabel: "Ticket code",
      confirmLabel: "Remove test ticket",
    });
    if (!confirmation) return;
    if (!await dialog.confirm({
      title: "Delete this test ticket?",
      description: "The server will refuse the action if it finds Stripe payment, refund, dispute, check-in, redemption or unresolved recovery history.",
      confirmLabel: "Delete test ticket",
      danger: true,
    })) return;

    setBusy(`delete:${ticket.id}`);
    setMessage("");
    try {
      const response = await fetch("/api/admin/tickets", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId: ticket.id, reason: reason.trim(), confirmation: confirmation.trim() }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      setMessage(response.ok ? "Test ticket removed from ticket and analytics views." : body.error || "The test ticket could not be removed safely.");
      if (response.ok) await onChanged();
    } catch {
      setMessage("The request could not reach the server. Refresh before trying again.");
    } finally {
      setBusy("");
    }
  }

  async function bulkExtend() {
    if (!selectedAllocations.length || !await dialog.confirm({ title: "Extend selected allocations?", description: `Extend ${selectedAllocations.length} allocation(s) by ${defaultExpiryHours} hours? The batch stops if any has active payment state.`, confirmLabel: "Extend allocations" })) return;
    setBusy("bulk-allocation");
    const response = await fetch("/api/admin/allocations", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allocationIds: selectedAllocations, action: "extend", hours: defaultExpiryHours }) });
    const body = await response.json() as { error?: string; completed?: number };
    setMessage(response.ok ? `${body.completed || 0} allocation(s) extended and audited.` : body.error || "Bulk extension failed.");
    setBusy(""); if (response.ok) { setSelectedAllocations([]); await onChanged(); }
  }

  async function recoveryAction(action: "reissue_ticket" | "reverse_check_in" | "reverse_redemption", id: string) {
    const reason = await dialog.prompt({ title: "Recovery reason required", description: "This reason will be written to the immutable audit trail.", inputLabel: "Reason", confirmLabel: "Continue" });
    if (!reason) return;
    const label = action === "reissue_ticket" ? "reissue this ticket" : action === "reverse_check_in" ? "reverse this check-in" : "reverse this add-on redemption";
    if (!await dialog.confirm({ title: "Confirm recovery action", description: `Confirm: ${label}? Reason: ${reason}`, confirmLabel: "Run recovery action", danger: true })) return;
    setBusy(id);
    const idField = action === "reverse_redemption" ? { redemptionId: id } : { ticketId: id };
    const response = await fetch("/api/admin/operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...idField, reason, operationId: `${action}_${crypto.randomUUID()}` }) });
    const body = await response.json() as { error?: string };
    setMessage(response.ok ? "Recovery action completed and audited." : body.error || "Recovery action failed.");
    setBusy(""); if (response.ok) await onChanged();
  }

  async function saveFilter() {
    const name = await dialog.prompt({ title: "Save ticketing filter", description: "Give this ticketing search a recognisable name.", inputLabel: "Filter name", defaultValue: "Door lookup", confirmLabel: "Save filter" });
    if (!name) return;
    const response = await fetch("/api/admin/operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_filter", scope: "ticketing", name, filters: { search } }) });
    const body = await response.json() as { savedFilter?: AdminSavedFilter };
    if (body.savedFilter) setSavedFilters((items) => [...items.filter((item) => item.id !== body.savedFilter!.id), body.savedFilter!]);
    setMessage(response.ok ? "Ticketing filter saved." : "Filter could not be saved.");
  }

  return (
    <section className="admin-section admin-stack">
      <div className="admin-section-title">
        <div>
          <h2>Ticketing</h2>
          <p>Allocations, orders, payments, tickets and event extras in one operational trail.</p>
        </div>
      </div>
      <div className="admin-filter-bar"><input aria-label="Search customers, orders, tickets or phone" placeholder="Search customer, email, phone, order or ticket" value={search} onChange={(event) => setSearch(event.target.value)} /><button type="button" onClick={() => void saveFilter()}>Save filter</button><select aria-label="Load saved ticketing filter" defaultValue="" onChange={(event)=>{const saved=savedFilters.find((item)=>item.id===event.target.value);if(saved)setSearch(String(saved.filters.search||""));}}><option value="">Load saved filter</option>{savedFilters.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <div className="admin-card admin-actions"><label><input type="checkbox" checked={allocations.length > 0 && allocations.every((item) => selectedAllocations.includes(item.id))} onChange={(event) => setSelectedAllocations(event.target.checked ? allocations.map((item) => item.id) : [])} /> Select visible allocations</label><button type="button" className="button button-primary" disabled={!selectedAllocations.length || busy === "bulk-allocation"} onClick={() => void bulkExtend()}>Extend {selectedAllocations.length} selected</button></div>
      <p className="admin-field-note">Delete test ticket is fail-closed and available only to super administrators. Real Stripe and attendance records are protected.</p>
      {message && <p className="admin-notice" role="status">{message}</p>}
      <div className="admin-grid-two">
        <div className="admin-card">
          <h3>Allocations</h3>
          <div className="account-list">
            {allocations.map((allocation) => {
              const user = snapshot.ops.users.find((item) => item.id === allocation.userId);
              const event = snapshot.site.events.find((item) => item.id === allocation.eventId);
              return (
                <article key={allocation.id}>
                  <div>
                    <label><input type="checkbox" aria-label={`Select allocation ${allocation.id}`} checked={selectedAllocations.includes(allocation.id)} onChange={(event) => setSelectedAllocations((current) => event.target.checked ? [...new Set([...current, allocation.id])] : current.filter((id) => id !== allocation.id))} /> Select</label>
                    <span className={`status-pill status-${allocation.status}`}>{statusLabel(allocation.status)}</span>
                    <h3>{user?.firstName} {user?.lastName}</h3>
                    <p>{event?.title} · max {allocation.maxQuantity} · expires {formatDateTime(allocation.expiresAt, timezone)}</p>
                    <div className="inline-admin-actions">
                      <button type="button" disabled={busy === allocation.id} onClick={() => void allocationAction(allocation.id, "remind")}>Remind</button>
                      <button type="button" disabled={busy === allocation.id} onClick={() => void allocationAction(allocation.id, "extend")}>Extend {defaultExpiryHours}h</button>
                      <button type="button" disabled={busy === allocation.id} onClick={() => void allocationAction(allocation.id, "unlock")}>Unlock</button>
                      <button type="button" disabled={busy === allocation.id} className="danger-link" onClick={() => void allocationAction(allocation.id, "cancel")}>Cancel</button>
                    </div>
                  </div>
                  <strong>{moneyCents(allocation.priceCents)}</strong>
                </article>
              );
            })}
          </div>
        </div>
        <div className="admin-card">
          <h3>Orders</h3>
          <div className="account-list">
            {orders.map((order) => {
              const user = snapshot.ops.users.find((item) => item.id === order.userId);
              return (
                <article key={order.id}>
                  <div>
                    <span className={`status-pill status-${order.status}`}>{statusLabel(order.status)}</span>
                    <h3>{user?.firstName} {user?.lastName}</h3>
                    <p>{order.items.map((item) => `${item.quantity}× ${item.name}`).join(" · ")}</p>
                  </div>
                  <strong>{moneyCents(order.totalCents)}</strong>
                </article>
              );
            })}
          </div>
        </div>
      </div>
      <div className="admin-card">
        <h3>Issued tickets</h3>
        <div className="audit-table">
          <div className="audit-row audit-head"><span>Holder</span><span>Code</span><span>Status</span><span>Controls</span></div>
          {tickets.map((ticket) => (
            <div className="audit-row" key={ticket.id}>
              <span>{ticket.holderName}</span>
              <strong>{ticket.ticketCode}</strong>
              <span>{statusLabel(ticket.status)}</span>
              <span className="inline-admin-actions">
                {ticket.status !== "valid" && ticket.status !== "refunded" && ticket.status !== "checked_in" && (
                  <button type="button" disabled={busy === ticket.id} onClick={() => void ticketAction(ticket.id, "valid")}>Restore</button>
                )}
                {ticket.status === "checked_in" && <button type="button" disabled={busy === ticket.id} onClick={() => void recoveryAction("reverse_check_in", ticket.id)}>Reverse check-in</button>}
                {["valid", "checked_in"].includes(ticket.status) && <button type="button" disabled={busy === ticket.id} onClick={() => void recoveryAction("reissue_ticket", ticket.id)}>Reissue</button>}
                {ticket.status !== "cancelled" && ticket.status !== "refunded" && (
                  <button type="button" disabled={busy === ticket.id} onClick={() => void ticketAction(ticket.id, "cancelled")}>Cancel</button>
                )}
                {ticket.status !== "entry_refused" && ticket.status !== "refunded" && (
                  <button type="button" disabled={busy === ticket.id} onClick={() => void ticketAction(ticket.id, "entry_refused")}>Refuse entry</button>
                )}
                {!ticket.checkedInAt && !["checked_in", "refunded"].includes(ticket.status) && (
                  <button className="danger-link" type="button" disabled={Boolean(busy)} onClick={() => void removeTestTicket(ticket)}>{busy === `delete:${ticket.id}` ? "Removing..." : "Delete test ticket"}</button>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="admin-card"><h3>Add-on redemption recovery</h3><div className="account-list">{snapshot.ops.entitlementRedemptions.map((redemption) => { const entitlement = snapshot.ops.entitlements.find((item) => item.id === redemption.entitlementId); return <article key={redemption.id}><div><strong>{entitlement?.name || redemption.entitlementId}</strong><p>{redemption.quantity} unit(s) · {formatDateTime(redemption.redeemedAt, timezone)}{redemption.reversedAt ? " · reversed" : ""}</p></div>{!redemption.reversedAt && <button type="button" disabled={busy === redemption.id} onClick={() => void recoveryAction("reverse_redemption", redemption.id)}>Reverse with reason</button>}</article>; })}{!snapshot.ops.entitlementRedemptions.length && <div className="admin-empty">No add-on redemptions recorded.</div>}</div></div>
    </section>
  );
}
