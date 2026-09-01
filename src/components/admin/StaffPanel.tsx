"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { dateTimeLocalInputToIso, formatDateTime, formatDateTimeLocalInput, statusLabel } from "@/lib/format";
import type { EventItem, EventStaffAssignment, EventStaffAssignmentAudit, EventStaffRole, UserProfile, UserRole } from "@/types/site";

type StaffData = {
  actorRole: UserRole;
  users: Array<Omit<UserProfile, "passwordHash">>;
  assignments: EventStaffAssignment[];
  audits: EventStaffAssignmentAudit[];
};

async function fetchStaffData() {
  const response = await fetch("/api/admin/staff", { cache: "no-store" });
  const body = await response.json() as StaffData & { error?: string };
  return { body, ok: response.ok };
}

export function StaffPanel({ events, timezone }: { events: EventItem[]; timezone: string }) {
  const [data, setData] = useState<StaffData | null>(null);
  const [message, setMessage] = useState("Loading staff assignments...");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { body, ok } = await fetchStaffData();
    if (!ok) {
      setMessage(body.error || "Staff assignments could not be loaded.");
      return;
    }
    setData(body);
    setMessage("");
  }, []);

  useEffect(() => {
    let current = true;
    void fetchStaffData().then(({ body, ok }) => {
      if (!current) return;
      if (!ok) {
        setMessage(body.error || "Staff assignments could not be loaded.");
        return;
      }
      setData(body);
      setMessage("");
    });
    return () => { current = false; };
  }, []);

  const eligible = useMemo(
    () => data?.users.filter((user) => ["scanner_only", "door_staff", "admin", "super_admin"].includes(user.role)) || [],
    [data],
  );

  async function mutate(payload: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/admin/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json() as { error?: string };
    setBusy(false);
    if (!response.ok) {
      setMessage(body.error || "Staff assignment update failed.");
      return;
    }
    setMessage("Staff access updated and audited.");
    await load();
  }

  async function assign(form: HTMLFormElement) {
    const formData = new FormData(form);
    try {
      await mutate({
        action: "assign",
        userId: formData.get("userId"),
        eventId: formData.get("eventId"),
        role: formData.get("role"),
        startsAt: dateTimeLocalInputToIso(String(formData.get("startsAt") || ""), timezone),
        endsAt: dateTimeLocalInputToIso(String(formData.get("endsAt") || ""), timezone),
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enter valid Melbourne assignment times.");
    }
  }

  const defaultStart = formatDateTimeLocalInput(new Date().toISOString(), timezone);

  return (
    <section className="admin-section admin-stack">
      <div className="admin-section-title"><div><h2>Event staff</h2><p>Time-bounded scanner and door access, scoped to one event and recorded in an immutable audit trail.</p></div></div>
      {message && <p className="admin-notice" role="status">{message}</p>}
      {data?.actorRole === "super_admin" && (
        <div className="admin-card">
          <h3>Account roles</h3>
          <p>Assign the minimum global role first. Event access is granted separately below.</p>
          <div className="account-list">
            {data.users.filter((user) => user.role !== "super_admin").map((user) => (
              <article key={user.id}>
                <div><strong>{user.firstName} {user.lastName}</strong><p>{user.email}</p></div>
                <select value={user.role} disabled={busy} onChange={(event) => void mutate({ action: "set_role", userId: user.id, role: event.target.value })}>
                  {(["customer", "scanner_only", "door_staff", "admin"] as UserRole[]).map((role) => <option value={role} key={role}>{statusLabel(role)}</option>)}
                </select>
              </article>
            ))}
          </div>
        </div>
      )}
      <form className="admin-card admin-grid-three" onSubmit={(event) => { event.preventDefault(); void assign(event.currentTarget); }}>
        <label className="admin-field"><span>Staff account</span><select name="userId" required>{eligible.map((user) => <option key={user.id} value={user.id}>{user.firstName} {user.lastName} ({statusLabel(user.role)})</option>)}</select></label>
        <label className="admin-field"><span>Event</span><select name="eventId" required>{events.map((event) => <option key={event.id} value={event.id}>{event.title}</option>)}</select></label>
        <label className="admin-field"><span>Capability role</span><select name="role" defaultValue="scanner_only">{(["scanner_only", "door_staff", "event_admin"] as EventStaffRole[]).map((role) => <option key={role} value={role}>{statusLabel(role)}</option>)}</select></label>
        <label className="admin-field"><span>Starts (Melbourne)</span><input name="startsAt" type="datetime-local" required defaultValue={defaultStart} /></label>
        <label className="admin-field"><span>Ends (Melbourne, optional)</span><input name="endsAt" type="datetime-local" /></label>
        <button className="button button-primary" disabled={busy || !eligible.length || !events.length}>Assign event access</button>
      </form>
      <div className="admin-card">
        <h3>Assignments</h3>
        <div className="audit-table">
          <div className="audit-row audit-head"><span>Staff</span><span>Event / window</span><span>Role</span><span>Control</span></div>
          {data?.assignments.map((assignment) => {
            const user = data.users.find((item) => item.id === assignment.userId);
            const event = events.find((item) => item.id === assignment.eventId);
            return <div className="audit-row" key={assignment.id}><span>{user?.firstName} {user?.lastName}</span><span>{event?.title || assignment.eventId}<small>{formatDateTime(assignment.startsAt, timezone)}{assignment.endsAt ? ` to ${formatDateTime(assignment.endsAt, timezone)}` : " onward"}</small></span><strong>{statusLabel(assignment.role)}{assignment.active ? "" : " / revoked"}</strong><span>{assignment.active && <button type="button" disabled={busy} onClick={() => void mutate({ action: "revoke", assignmentId: assignment.id })}>Revoke</button>}</span></div>;
          })}
        </div>
      </div>
      <div className="admin-card">
        <h3>Assignment audit</h3>
        <div className="audit-table">
          <div className="audit-row audit-head"><span>Time</span><span>Action</span><span>Event</span><span>Role</span></div>
          {data?.audits.map((audit) => <div className="audit-row" key={audit.id}><span>{formatDateTime(audit.createdAt, timezone)}</span><strong>{statusLabel(audit.action)}</strong><span>{events.find((event) => event.id === audit.eventId)?.title || audit.eventId}</span><span>{statusLabel(audit.role)}</span></div>)}
        </div>
      </div>
    </section>
  );
}
