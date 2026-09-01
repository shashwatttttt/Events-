import { NextResponse } from "next/server";
import { mutateOperationsData, readOperationsData, readSiteData } from "@/lib/data/documents";
import { apiError } from "@/lib/http";
import { randomId } from "@/lib/security/crypto";
import { requireUser } from "@/lib/security/session";

type AnyRecord = Record<string, unknown>;
const exportTypes = new Set(["applications", "customers", "ticketing", "sponsor"]);

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AnyRecord) : {};
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function csvCell(value: unknown) {
  if (Array.isArray(value)) return csvCell(value.join(", "));
  if (typeof value === "boolean") return `"${value ? "Yes" : "No"}"`;
  const raw = String(value ?? "");
  const text = /^[\t\r\n ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${text.replaceAll('"', '""')}"`;
}

function buildCsv(headers: string[], rows: unknown[][]) {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

function safeFilename(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

function centsToAud(value: unknown) {
  const cents = Number(value || 0);
  return (cents / 100).toFixed(2);
}


function getEventId(item: unknown) {
  return String(asRecord(item).eventId || "");
}

function getUserId(item: unknown) {
  return String(asRecord(item).userId || asRecord(item).customerId || "");
}

function getAnswerValue(answers: AnyRecord, key: string) {
  const value = answers[key];
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value ?? "";
}

function getConsentValue(consents: AnyRecord[], userId: string, eventId: string, type: string) {
  const consent = consents
    .filter((item) => (
      String(item.userId || "") === userId
      && String(item.eventId || "") === eventId
      && String(item.type || "") === type
    ))
    .sort((left, right) => String(right.acceptedAt || "").localeCompare(String(left.acceptedAt || "")))[0];

  if (!consent) return "";
  return consent.accepted ? "Yes" : "No";
}

function getQuestionColumns(site: AnyRecord, applications: AnyRecord[]) {
  const forms = asArray<AnyRecord>(site.applicationForms || site.forms);
  const fieldsByKey = new Map<string, string>();

  for (const form of forms) {
    for (const field of asArray<AnyRecord>(form.fields)) {
      const key = String(field.key || field.id || "");
      const label = String(field.label || field.placeholder || key);
      if (key && !fieldsByKey.has(key)) fieldsByKey.set(key, label);
    }
  }

  for (const application of applications) {
    const answers = asRecord(application.answers);
    for (const key of Object.keys(answers)) {
      if (!fieldsByKey.has(key)) fieldsByKey.set(key, key);
    }
  }

  return [...fieldsByKey.entries()].map(([key, label]) => ({
    key,
    label: `Question: ${label} [${key}]`,
  }));
}

function findById(items: AnyRecord[], id: string) {
  return items.find((item) => String(item.id || "") === id);
}

function createApplicationsCsv(site: AnyRecord, ops: AnyRecord, eventId: string | null) {
  const events = asArray<AnyRecord>(site.events);
  const users = asArray<AnyRecord>(ops.users || ops.customers);
  const consents = asArray<AnyRecord>(ops.consents);
  const allApplications = asArray<AnyRecord>(ops.applications);

  const applications =
    eventId && eventId !== "all"
      ? allApplications.filter((application) => String(application.eventId || "") === eventId)
      : allApplications;

  const questionColumns = getQuestionColumns(site, allApplications);

  const headers = [
    "Application ID",
    "Event name",
    "Event ID",
    "Event slug",
    "Application status",
    "Submitted at",
    "Reviewed at",
    "Customer ID",
    "First name",
    "Last name",
    "Email",
    "Phone",
    "Instagram",
    "Age confirmed",
    "Terms accepted",
    "Privacy accepted",
    "Entry policy accepted",
    "Media consent",
    "Sponsor consent",
    "Marketing consent",
    "Admin notes",
    "Tags / flags",
    ...questionColumns.map((column) => column.label),
  ];

  const rows = applications.map((application) => {
    const user = findById(users, String(application.userId || application.customerId || ""));
    const event = findById(events, String(application.eventId || ""));
    const answers = asRecord(application.answers);

    return [
      application.id,
      event?.title || application.eventId || "",
      event?.id || application.eventId || "",
      event?.slug || "",
      application.status || "",
      application.createdAt || application.submittedAt || "",
      application.reviewedAt || "",
      user?.id || application.userId || application.customerId || "",
      user?.firstName || application.firstName || "",
      user?.lastName || application.lastName || "",
      user?.email || application.email || "",
      user?.phone || application.phone || "",
      user?.instagram || application.instagram || "",
      getConsentValue(consents, String(user?.id || application.userId || ""), String(application.eventId || ""), "age"),
      application.termsAccepted ?? getConsentValue(consents, String(user?.id || application.userId || ""), String(application.eventId || ""), "terms"),
      application.privacyAccepted ??
        getConsentValue(consents, String(user?.id || application.userId || ""), String(application.eventId || ""), "privacy"),
      application.entryAccepted ??
        getConsentValue(consents, String(user?.id || application.userId || ""), String(application.eventId || ""), "entry"),
      getConsentValue(consents, String(user?.id || application.userId || ""), String(application.eventId || ""), "media"),
      getConsentValue(consents, String(user?.id || application.userId || ""), String(application.eventId || ""), "sponsor"),
      getConsentValue(consents, String(user?.id || application.userId || ""), String(application.eventId || ""), "marketing"),
      application.adminNotes || application.notes || "",
      [...asArray(user?.tags), ...asArray(application.tags), ...asArray(application.duplicateFlags)].filter(Boolean).join(", "),
      ...questionColumns.map((column) => getAnswerValue(answers, column.key)),
    ];
  });

  return {
    csv: buildCsv(headers, rows),
    records: rows.length,
    filename: eventId && eventId !== "all" ? `applications-${safeFilename(String(eventId))}.csv` : "applications-all-events.csv",
  };
}

function createCustomersCsv(site: AnyRecord, ops: AnyRecord, eventId: string | null) {
  const applications = asArray<AnyRecord>(ops.applications);
  const orders = asArray<AnyRecord>(ops.orders);
  const tickets = asArray<AnyRecord>(ops.tickets);
  const users = asArray<AnyRecord>(ops.users || ops.customers);

  const scopedUserIds =
    eventId && eventId !== "all"
      ? new Set([
          ...applications.filter((item) => getEventId(item) === eventId).map(getUserId),
          ...orders.filter((item) => getEventId(item) === eventId).map(getUserId),
          ...tickets.filter((item) => getEventId(item) === eventId).map(getUserId),
        ])
      : null;

  const rowsUsers = scopedUserIds ? users.filter((user) => scopedUserIds.has(String(user.id || ""))) : users;

  const headers = [
    "Customer ID",
    "First name",
    "Last name",
    "Email",
    "Phone",
    "Instagram",
    "Created at",
    "Tags / flags",
    "Notes",
  ];

  const rows = rowsUsers.map((user) => [
    user.id,
    user.firstName,
    user.lastName,
    user.email,
    user.phone,
    user.instagram,
    user.createdAt,
    asArray(user.tags).join(", "),
    user.internalNotes || user.notes || user.adminNotes || "",
  ]);

  return {
    csv: buildCsv(headers, rows),
    records: rows.length,
    filename: eventId && eventId !== "all" ? `customers-${safeFilename(String(eventId))}.csv` : "customers-all-events.csv",
  };
}

function createTicketingCsv(site: AnyRecord, ops: AnyRecord, eventId: string | null) {
  const events = asArray<AnyRecord>(site.events);
  const users = asArray<AnyRecord>(ops.users || ops.customers);
  const allOrders = asArray<AnyRecord>(ops.orders);
  const allTickets = asArray<AnyRecord>(ops.tickets);
  const allocations = asArray<AnyRecord>(ops.allocations);
  const payments = asArray<AnyRecord>(ops.payments);
  const scopedOrders =
    eventId && eventId !== "all"
      ? allOrders.filter((order) => String(order.eventId || "") === eventId)
      : allOrders;
  const scopedTickets =
    eventId && eventId !== "all"
      ? allTickets.filter((ticket) => String(ticket.eventId || "") === eventId)
      : allTickets;

  const headers = [
    "Order ID",
    "Order status",
    "Order created at",
    "Order paid at",
    "Order total AUD",
    "Currency",
    "Order items",
    "Payment status",
    "Payment provider",
    "Payment reference",
    "Allocation ID",
    "Allocation status",
    "Ticket ID",
    "Ticket code",
    "Ticket status",
    "Checked in",
    "Checked in at",
    "Event ID",
    "Event name",
    "Event slug",
    "Customer ID",
    "Customer name",
    "Customer email",
    "Ticket holder name",
    "Ticket holder email",
    "Ticket created at",
  ];

  function row(order: AnyRecord | undefined, ticket: AnyRecord | undefined) {
    const eventIdValue = String(order?.eventId || ticket?.eventId || "");
    const userIdValue = String(order?.userId || ticket?.userId || ticket?.customerId || "");
    const event = findById(events, eventIdValue);
    const user = findById(users, userIdValue);
    const allocation = findById(allocations, String(order?.allocationId || ""));
    const payment = payments
      .filter((item) => String(item.orderId || "") === String(order?.id || ""))
      .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")))[0];
    return [
      order?.id || ticket?.orderId || "",
      order?.status || "",
      order?.createdAt || "",
      order?.paidAt || "",
      centsToAud(order?.totalCents || order?.amountCents),
      order?.currency || "",
      asArray<AnyRecord>(order?.items).map((item) => `${item.quantity || 0} x ${item.name || item.referenceId || "Item"}`).join("; "),
      payment?.status || "",
      payment?.provider || "",
      payment?.providerReference || "",
      allocation?.id || order?.allocationId || "",
      allocation?.status || "",
      ticket?.id || "",
      ticket?.code || ticket?.ticketCode || "",
      ticket?.status || "",
      ticket?.status === "checked_in" ? "Yes" : "No",
      ticket?.checkedInAt || "",
      event?.id || eventIdValue,
      event?.title || eventIdValue,
      event?.slug || "",
      user?.id || userIdValue,
      [user?.firstName, user?.lastName].filter(Boolean).join(" "),
      user?.email || "",
      ticket?.holderName || "",
      ticket?.holderEmail || "",
      ticket?.createdAt || "",
    ];
  }

  const rows: unknown[][] = [];
  for (const order of scopedOrders) {
    const orderTickets = scopedTickets.filter((ticket) => String(ticket.orderId || "") === String(order.id || ""));
    if (orderTickets.length) {
      rows.push(...orderTickets.map((ticket) => row(order, ticket)));
    } else {
      rows.push(row(order, undefined));
    }
  }

  const scopedOrderIds = new Set(scopedOrders.map((order) => String(order.id || "")));
  for (const ticket of scopedTickets) {
    if (!ticket.orderId || !scopedOrderIds.has(String(ticket.orderId))) rows.push(row(undefined, ticket));
  }

  return {
    csv: buildCsv(headers, rows),
    records: rows.length,
    filename: eventId && eventId !== "all" ? `ticketing-${safeFilename(String(eventId))}.csv` : "ticketing-all-events.csv",
  };
}

function createSponsorCsv(site: AnyRecord, ops: AnyRecord, eventId: string | null) {
  const events = asArray<AnyRecord>(site.events);
  const users = asArray<AnyRecord>(ops.users || ops.customers);
  const consents = asArray<AnyRecord>(ops.consents);

  const latestByUserAndEvent = new Map<string, AnyRecord>();
  for (const consent of consents
    .filter((item) => item.type === "sponsor" && item.userId && item.eventId)
    .sort((left, right) => String(left.acceptedAt || "").localeCompare(String(right.acceptedAt || "")))) {
    latestByUserAndEvent.set(`${consent.userId}:${consent.eventId}`, consent);
  }

  const accepted = [...latestByUserAndEvent.values()].filter((consent) => {
    const eventMatches = !eventId || eventId === "all" || String(consent.eventId || "") === eventId;
    return eventMatches && consent.accepted === true;
  });

  const rows = accepted.flatMap((consent) => {
    const user = findById(users, String(consent.userId || ""));
    if (!user) return [];
    const event = findById(events, String(consent.eventId || ""));
    return [[
      event?.id || consent.eventId || "",
      event?.title || consent.eventId || "",
      user.id,
      user.firstName,
      user.lastName,
      user.email,
      user.phone,
      user.instagram,
      consent.acceptedAt || "",
      consent.policyVersion || "",
    ]];
  });

  const csv = buildCsv([
    "Event ID",
    "Event name",
    "Customer ID",
    "First name",
    "Last name",
    "Email",
    "Phone",
    "Instagram",
    "Sponsor consent accepted at",
    "Policy version",
  ], rows);

  return {
    csv,
    records: rows.length,
    filename: eventId && eventId !== "all" ? `sponsor-consent-${safeFilename(String(eventId))}.csv` : "sponsor-consent-all-events.csv",
  };
}

export async function GET(request: Request) {
  try {
    const actor = await requireUser(["admin", "super_admin"]);
    const url = new URL(request.url);
    const type = url.searchParams.get("type") || "applications";
    const eventId = url.searchParams.get("eventId");
    if (!exportTypes.has(type)) throw new Error("Unknown export type.");

    const [siteData, opsData] = await Promise.all([readSiteData(), readOperationsData()]);
    if (eventId && eventId !== "all" && !siteData.events.some((event) => event.id === eventId)) {
      throw new Error("Event not found.");
    }
    const site = asRecord(siteData);
    const ops = asRecord(opsData);

    let result: { csv: string; records: number; filename: string };

    if (type === "customers") {
      result = createCustomersCsv(site, ops, eventId);
    } else if (type === "ticketing") {
      result = createTicketingCsv(site, ops, eventId);
    } else if (type === "sponsor") {
      result = createSponsorCsv(site, ops, eventId);
    } else {
      result = createApplicationsCsv(site, ops, eventId);
    }

    await mutateOperationsData((current) => {
      current.auditLogs.push({
        id: randomId("audit"),
        actorId: actor.id,
        actorEmail: actor.email,
        action: `export.${type}_csv`,
        entityType: "export",
        entityId: eventId || "all",
        metadata: {
          records: result.records,
          type,
          eventId: eventId || "all",
          internalExport: type !== "sponsor",
          consentFilter: type === "sponsor",
        },
        createdAt: new Date().toISOString(),
      });
    });

    return new NextResponse(result.csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
