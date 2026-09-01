"use client";

import { useMemo, useState } from "react";
import { useAccessibleDialog } from "@/components/AccessibleDialog";
import type { UserProfile } from "@/types/site";

export function CustomersPanel({
  customers,
  onChanged,
}: {
  customers: UserProfile[];
  onChanged: () => Promise<void>;
}) {
  const dialog = useAccessibleDialog();
  const [busy, setBusy] = useState("");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const filtered = useMemo(
    () => customers.filter((user) => `${user.firstName} ${user.lastName} ${user.email} ${user.phone} ${user.instagram} ${user.tags.join(" ")}`.toLowerCase().includes(search.toLowerCase())),
    [customers, search],
  );

  async function save(user: UserProfile, form: HTMLFormElement) {
    setBusy(user.id);
    setMessage("");
    const data = new FormData(form);
    const response = await fetch("/api/admin/customers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: user.id,
        tags: String(data.get("tags") || "").split(","),
        internalNotes: data.get("internalNotes"),
      }),
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    setMessage(response.ok ? "Customer changes saved and audited." : body.error || "Customer update failed.");
    setBusy("");
    if (response.ok) await onChanged();
  }

  async function removeTestCustomer(user: UserProfile) {
    const reason = await dialog.prompt({
      title: "Why is this customer test data?",
      description: "The reason is stored in the immutable admin audit trail. Real customers, Stripe payments, check-ins and redemptions cannot be removed.",
      inputLabel: "Removal reason",
      defaultValue: "Fake customer created during checkout testing",
      confirmLabel: "Continue",
    });
    if (!reason?.trim()) return;
    const confirmation = await dialog.prompt({
      title: "Confirm test customer removal",
      description: `Type ${user.email} exactly. This hides the customer and their disposable test records from the control panel and analytics. Financial history is never erased.`,
      inputLabel: "Customer email",
      confirmLabel: "Remove test customer",
    });
    if (!confirmation) return;
    if (!await dialog.confirm({
      title: "Remove this test customer?",
      description: `${user.firstName} ${user.lastName} will lose access and disappear from customer, ticket and analytics views. Protected commercial records will cause the server to refuse this action.`,
      confirmLabel: "Remove test customer",
      danger: true,
    })) return;

    setBusy(`delete:${user.id}`);
    setMessage("");
    try {
      const response = await fetch("/api/admin/customers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, reason: reason.trim(), confirmation: confirmation.trim() }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; removed?: { hiddenTickets?: number } };
      setMessage(response.ok
        ? `Test customer removed from operational views${body.removed?.hiddenTickets ? ` with ${body.removed.hiddenTickets} ticket(s)` : ""}.`
        : body.error || "The test customer could not be removed safely.");
      if (response.ok) await onChanged();
    } catch {
      setMessage("The request could not reach the server. Refresh before trying again.");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="admin-section admin-stack">
      <div className="admin-section-title">
        <div>
          <h2>Customers</h2>
          <p>Search names, email, phone, Instagram and tags. Private notes never appear publicly.</p>
        </div>
      </div>
      <div className="admin-filter-bar">
        <input
          aria-label="Search customers by name, email or phone"
          placeholder="Search name, email, phone, Instagram or tag"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <p className="admin-field-note">Test-data removal is restricted to super administrators and is blocked for Stripe payments, refunds, disputes, check-ins, redemptions and staff accounts.</p>
      {message && <p className="admin-notice" role="status">{message}</p>}
      <div className="customer-admin-grid">
        {filtered.map((user) => (
          <form className="admin-card" key={user.id} onSubmit={(event) => { event.preventDefault(); void save(user, event.currentTarget); }}>
            <div className="admin-card-head">
              <div>
                <strong>{user.firstName} {user.lastName}</strong>
                <small>{user.email}</small>
              </div>
              <span className="status-pill">{user.role}</span>
            </div>
            <p>{user.phone} · {user.instagram || "No Instagram"}</p>
            <label className="admin-field">
              <span>Tags — comma separated</span>
              <input name="tags" defaultValue={user.tags.join(", ")} placeholder="VIP, Regular, Needs review" />
            </label>
            <label className="admin-field">
              <span>Private notes</span>
              <textarea name="internalNotes" defaultValue={user.internalNotes} placeholder="Only admins see this." />
            </label>
            <div className="inline-admin-actions">
              <button className="button button-ghost" disabled={busy === user.id || busy === `delete:${user.id}`}>{busy === user.id ? "Saving..." : "Save customer"}</button>
              {user.role === "customer" && (
                <button
                  className="danger-link"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void removeTestCustomer(user)}
                >
                  {busy === `delete:${user.id}` ? "Removing..." : "Delete test customer"}
                </button>
              )}
            </div>
          </form>
        ))}
        {!filtered.length && <div className="admin-empty">No customers match this search.</div>}
      </div>
    </section>
  );
}
