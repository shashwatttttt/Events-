"use client";

import { useMemo, useState } from "react";
import type { AdminSnapshot } from "@/components/admin/types";
import type { ConsentRecord } from "@/types/site";

function numberLabel(value: number, singular: string, plural?: string) {
  return `${value} ${value === 1 ? singular : plural || `${singular}s`}`;
}

export function ExportsPanel({
  snapshot,
  onChanged,
}: {
  snapshot: AdminSnapshot;
  onChanged: () => Promise<void>;
}) {
  const [eventId, setEventId] = useState("all");
  const [downloading, setDownloading] = useState("");
  const [message, setMessage] = useState("");

  const selectedEventName = useMemo(() => {
    if (eventId === "all") return "All events";
    return snapshot.site.events.find((event) => event.id === eventId)?.title || "Selected event";
  }, [eventId, snapshot.site.events]);

  const scopedApplications = useMemo(
    () =>
      eventId === "all"
        ? snapshot.ops.applications
        : snapshot.ops.applications.filter((application) => application.eventId === eventId),
    [eventId, snapshot.ops.applications],
  );

  const scopedOrders = useMemo(
    () =>
      eventId === "all"
        ? snapshot.ops.orders
        : snapshot.ops.orders.filter((order) => order.eventId === eventId),
    [eventId, snapshot.ops.orders],
  );

  const scopedTickets = useMemo(
    () =>
      eventId === "all"
        ? snapshot.ops.tickets
        : snapshot.ops.tickets.filter((ticket) => ticket.eventId === eventId),
    [eventId, snapshot.ops.tickets],
  );

  const scopedCustomers = useMemo(() => {
    if (eventId === "all") return snapshot.ops.users;

    const userIds = new Set([
      ...scopedApplications.map((application) => application.userId),
      ...scopedOrders.map((order) => order.userId),
      ...scopedTickets.map((ticket) => ticket.userId),
    ]);

    return snapshot.ops.users.filter((user) => userIds.has(user.id));
  }, [eventId, scopedApplications, scopedOrders, scopedTickets, snapshot.ops.users]);

  const consentCount = useMemo(() => {
    const latest = new Map<string, ConsentRecord>();
    for (const consent of [...snapshot.ops.consents]
      .filter((item) => item.type === "sponsor" && item.eventId)
      .sort((left, right) => left.acceptedAt.localeCompare(right.acceptedAt))) {
      latest.set(`${consent.userId}:${consent.eventId}`, consent);
    }
    return [...latest.values()].filter((consent) => (
      consent.accepted && (eventId === "all" || consent.eventId === eventId)
    )).length;
  }, [eventId, snapshot.ops.consents]);

  const eventQuery = eventId === "all" ? "" : `&eventId=${encodeURIComponent(eventId)}`;
  const applicationEventQuery = eventId === "all" ? "" : `?eventId=${encodeURIComponent(eventId)}`;

  const exports = [
    {
      title: "All applications + form answers",
      description:
        "Combined internal export of pre-checkout applications and post-checkout approval forms, including submitted answers, saved drafts, customer details, status, payment state, consents and dynamic question columns.",
      records: `${numberLabel(scopedApplications.length, "pre-checkout application")} + post-checkout records`,
      fields: "Both methods + dynamic form columns",
      href: `/api/admin/export/applications${applicationEventQuery}`,
      cta: "Download combined application CSV",
    },
    {
      title: "Customers",
      description:
        "Internal customer export with names, email, phone, Instagram and account profile fields collected through signup/application flows.",
      records: numberLabel(scopedCustomers.length, "customer"),
      fields: "Profile fields",
      href: `/api/admin/export?type=customers${eventQuery}`,
      cta: "Download customer CSV",
    },
    {
      title: "Orders + tickets",
      description:
        "Operational export for ticketing, paid orders, issued tickets, allocation status and check-in reconciliation.",
      records: `${numberLabel(scopedOrders.length, "order")} - ${numberLabel(scopedTickets.length, "ticket")}`,
      fields: "Payment + ticket fields",
      href: `/api/admin/export?type=ticketing${eventQuery}`,
      cta: "Download ticketing CSV",
    },
    {
      title: "Sponsor-safe consent export",
      description:
        "Filtered export for sponsor sharing only. Includes limited fields and only customers who accepted event-specific sponsor consent.",
      records: numberLabel(consentCount, "eligible record"),
      fields: "Consent-safe fields",
      href: `/api/admin/export?type=sponsor${eventQuery}`,
      cta: "Download sponsor CSV",
    },
  ];

  const exportLogs = snapshot.ops.auditLogs
    .filter((log) => log.action.startsWith("export."))
    .reverse();

  async function download(item: (typeof exports)[number]) {
    setDownloading(item.title);
    setMessage("");
    try {
      const response = await fetch(item.href, { cache: "no-store" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error || "Export failed.");
      }

      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "skie-export.csv";
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
      setMessage(`${item.title} downloaded.`);
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setDownloading("");
    }
  }

  return (
    <section className="admin-section admin-stack">
      <div className="admin-section-title">
        <div>
          <h2>Export Centre</h2>
          <p>
            Download collected Skie Events data for internal operations. The combined application export includes both
            pre-checkout and post-checkout approval forms, with every current and future question added automatically.
          </p>
        </div>
      </div>

      <div className="admin-card export-card">
        <label className="admin-field">
          <span>Event filter</span>
          <select value={eventId} onChange={(event) => setEventId(event.target.value)}>
            <option value="all">All events</option>
            {snapshot.site.events.map((event) => (
              <option value={event.id} key={event.id}>
                {event.title}
              </option>
            ))}
          </select>
        </label>

        <div className="export-summary">
          <div>
            <small>Selected scope</small>
            <strong>{selectedEventName}</strong>
          </div>
          <div>
            <small>Available exports</small>
            <strong>{exports.length}</strong>
          </div>
        </div>
      </div>

      <div className="admin-grid-two">
        {exports.map((item) => (
          <article className="admin-card export-card" key={item.title}>
            <div className="admin-section-title">
              <div>
                <h3>{item.title}</h3>
                <p>{item.description}</p>
              </div>
            </div>

            <div className="export-summary">
              <div>
                <small>Records</small>
                <strong>{item.records}</strong>
              </div>
              <div>
                <small>Included fields</small>
                <strong>{item.fields}</strong>
              </div>
            </div>

            <button
              className="button button-primary"
              disabled={Boolean(downloading)}
              onClick={() => void download(item)}
              type="button"
            >
              {downloading === item.title ? "Preparing CSV..." : item.cta} <span>↗</span>
            </button>
          </article>
        ))}
      </div>

      {message && <p className="admin-notice" role="status">{message}</p>}

      <div className="admin-card">
        <h3>Export history</h3>

        <div className="account-list">
          {exportLogs.map((log) => (
            <article key={log.id}>
              <div>
                <strong>{log.action}</strong>
                <p>
                  {log.actorEmail} - {new Date(log.createdAt).toLocaleString("en-AU")}
                </p>
              </div>
              <span>{String(log.metadata.records || 0)} records</span>
            </article>
          ))}

          {!exportLogs.length && <div className="admin-empty">No exports yet.</div>}
        </div>
      </div>
    </section>
  );
}
