"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccessibleDialog } from "@/components/AccessibleDialog";
import { PostCheckoutApplicationsPanel } from "@/components/admin/PostCheckoutApplicationsPanel";
import type { EnrichedApplication } from "@/components/admin/types";
import { formatDateTime, statusLabel } from "@/lib/format";
import type { AdminSavedFilter, ApplicationStatus } from "@/types/site";

const statuses: ApplicationStatus[] = [
  "pending",
  "approved",
  "waitlist",
  "hold",
  "rejected",
  "cancelled",
];

export function ApplicationsPanel({
  applications,
  defaultExpiryHours,
  onChanged,
  timezone,
}: {
  applications: EnrichedApplication[];
  defaultExpiryHours: number;
  onChanged: () => Promise<void>;
  timezone: string;
}) {
  const dialog = useAccessibleDialog();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkStatus, setBulkStatus] = useState<Exclude<ApplicationStatus, "approved">>("waitlist");
  const [savedFilters, setSavedFilters] = useState<AdminSavedFilter[]>([]);
  useEffect(() => { let active=true; void fetch("/api/admin/operations",{cache:"no-store"}).then(async(response)=>response.ok?response.json():null).then((body)=>{if(active&&body)setSavedFilters((body.savedFilters||[]).filter((item:AdminSavedFilter)=>item.scope==="applications"))}).catch(()=>undefined); return()=>{active=false}; }, []);

  const filtered = useMemo(
    () => applications.filter((application) => (
      (filter === "all" || application.status === filter)
      && `${application.customer?.firstName} ${application.customer?.lastName} ${application.customer?.email} ${application.event?.title}`
        .toLowerCase()
        .includes(search.toLowerCase())
    )),
    [applications, filter, search],
  );

  async function update(
    application: EnrichedApplication,
    status: ApplicationStatus,
    form: HTMLFormElement,
  ) {
    setBusy(application.id);
    setMessage("");
    const data = new FormData(form);
    const response = await fetch("/api/admin/applications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        applicationId: application.id,
        status,
        ticketTypeId: data.get("ticketTypeId"),
        maxQuantity: Number(data.get("maxQuantity") || application.event?.defaultTicketLimit || 2),
        expiryHours: Number(data.get("expiryHours") || defaultExpiryHours),
        adminNotes: data.get("adminNotes"),
      }),
    });
    const body = await response.json();
    setMessage(
      response.ok
        ? `Application moved to ${statusLabel(status)}.`
        : body.error || "Update failed.",
    );
    setBusy("");
    if (response.ok) await onChanged();
  }

  async function bulkUpdate() {
    if (!selected.length || !await dialog.confirm({ title: "Update selected applications?", description: `Move ${selected.length} application(s) to ${statusLabel(bulkStatus)}?`, confirmLabel: "Update applications", danger: bulkStatus === "rejected" || bulkStatus === "cancelled" })) return;
    setBusy("bulk"); setMessage("");
    const response = await fetch("/api/admin/applications", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ applicationIds: selected, status: bulkStatus }) });
    const body = await response.json() as { error?: string; completed?: number; failed?: number };
    setMessage(response.ok ? `${body.completed || 0} application(s) updated${body.failed ? `; ${body.failed} failed` : ""}.` : body.error || "Bulk update failed.");
    setBusy(""); if (response.ok) { setSelected([]); await onChanged(); }
  }

  async function saveFilter() {
    const name = await dialog.prompt({ title: "Save application filter", description: "Give this set of application filters a recognisable name.", inputLabel: "Filter name", defaultValue: "Review queue", confirmLabel: "Save filter" });
    if (!name) return;
    const response = await fetch("/api/admin/operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save_filter", scope: "applications", name, filters: { search, status: filter } }) });
    const body=await response.json() as {savedFilter?:AdminSavedFilter}; if(body.savedFilter)setSavedFilters((items)=>[...items.filter((item)=>item.id!==body.savedFilter!.id),body.savedFilter!]);
    setMessage(response.ok ? "Application filter saved." : "Filter could not be saved.");
  }

  return <>
    <PostCheckoutApplicationsPanel timezone={timezone} />
    <section className="admin-section admin-stack">
      <div className="admin-section-title">
        <div>
          <h2>Invite-only applications</h2>
          <p>Review the person, history, duplicate flags and allocation before unlocking tickets.</p>
        </div>
      </div>
      <div className="admin-filter-bar">
        <input
          placeholder="Search name, email, event"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">All statuses</option>
          {statuses.map((status) => (
            <option value={status} key={status}>{statusLabel(status)}</option>
          ))}
        </select>
        <button type="button" onClick={() => void saveFilter()}>Save filter</button>
        <select aria-label="Load saved application filter" defaultValue="" onChange={(event)=>{const saved=savedFilters.find((item)=>item.id===event.target.value);if(saved){setSearch(String(saved.filters.search||""));setFilter(String(saved.filters.status||"all"));}}}><option value="">Load saved filter</option>{savedFilters.map((item)=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
      </div>
      <div className="admin-card admin-actions">
        <label><input type="checkbox" checked={filtered.length > 0 && filtered.every((item) => selected.includes(item.id))} onChange={(event) => setSelected(event.target.checked ? filtered.map((item) => item.id) : [])} /> Select filtered ({filtered.length})</label>
        <select aria-label="Bulk application status" value={bulkStatus} onChange={(event) => setBulkStatus(event.target.value as typeof bulkStatus)}><option value="pending">Pending</option><option value="waitlist">Waitlist</option><option value="hold">Hold</option><option value="rejected">Rejected</option><option value="cancelled">Cancelled</option></select>
        <button className="button button-primary" type="button" disabled={!selected.length || busy === "bulk"} onClick={() => void bulkUpdate()}>Apply to {selected.length} selected</button>
      </div>
      {message && <p className="admin-notice" role="status">{message}</p>}
      <div className="application-admin-list">
        {filtered.map((application) => (
          <form
            className="application-admin-card"
            key={application.id}
            onSubmit={(event) => event.preventDefault()}
          >
            <header>
              <div>
                <label><input type="checkbox" aria-label={`Select ${application.customer?.firstName || "application"}`} checked={selected.includes(application.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, application.id])] : current.filter((id) => id !== application.id))} /> Select</label>
                <span className={`status-pill status-${application.status}`}>
                  {statusLabel(application.status)}
                </span>
                <h3>
                  {application.customer?.firstName} {application.customer?.lastName}
                </h3>
                <p>
                  {application.customer?.email} · {application.customer?.instagram || "No Instagram"}
                </p>
              </div>
              <div>
                <strong>{application.event?.title}</strong>
                <small>{formatDateTime(application.createdAt, timezone)}</small>
              </div>
            </header>
            {application.duplicateFlags.length > 0 && (
              <div className="duplicate-warning">
                Possible duplicate: {application.duplicateFlags.join(" · ")}
              </div>
            )}
            <details>
              <summary>Application answers <span>+</span></summary>
              <pre>{JSON.stringify(application.answers, null, 2)}</pre>
            </details>
            <div className="admin-grid-three">
              <label className="admin-field">
                <span>Ticket type</span>
                <select
                  name="ticketTypeId"
                  defaultValue={
                    application.allocation?.ticketTypeId
                    || application.event?.ticketTypes.find((type) => type.active)?.id
                  }
                >
                  {application.event?.ticketTypes.map((type) => (
                    <option value={type.id} key={type.id}>{type.name}</option>
                  ))}
                </select>
              </label>
              <label className="admin-field">
                <span>Max tickets</span>
                <input
                  name="maxQuantity"
                  type="number"
                  min="1"
                  max="20"
                  defaultValue={
                    application.allocation?.maxQuantity
                    || application.event?.defaultTicketLimit
                    || 2
                  }
                />
              </label>
              <label className="admin-field">
                <span>Expiry hours</span>
                <input
                  name="expiryHours"
                  type="number"
                  min="1"
                  max="336"
                  defaultValue={defaultExpiryHours}
                />
              </label>
            </div>
            <label className="admin-field">
              <span>Private admin notes</span>
              <textarea name="adminNotes" defaultValue={application.adminNotes} />
            </label>
            <div className="application-actions">
              {statuses
                .filter((status) => status !== application.status && status !== "cancelled")
                .map((status) => (
                  <button
                    type="button"
                    key={status}
                    disabled={busy === application.id}
                    onClick={(event) => update(application, status, event.currentTarget.form!)}
                    className={
                      status === "approved"
                        ? "approve-action"
                        : status === "rejected"
                          ? "reject-action"
                          : ""
                    }
                  >
                    {statusLabel(status)}
                  </button>
                ))}
            </div>
          </form>
        ))}
        {!filtered.length && <div className="admin-empty">No invite-only applications match these filters.</div>}
      </div>
    </section>
  </>;
}
