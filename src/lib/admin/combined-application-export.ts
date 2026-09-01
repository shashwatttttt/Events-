type AnyRecord = Record<string, unknown>;

export type CombinedApplicationExportResult = {
  csv: string;
  records: number;
  preCheckoutRecords: number;
  postCheckoutRecords: number;
  filename: string;
};

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : {};
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
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

function findById(items: AnyRecord[], id: string) {
  return items.find((item) => String(item.id || "") === id);
}

function answerValue(answers: AnyRecord, key: string) {
  const value = answers[key];
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value ?? "";
}

function snapshotValue(snapshot: AnyRecord, keys: string[]) {
  for (const key of keys) {
    if (!(key in snapshot)) continue;
    const value = snapshot[key];
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (value !== null && value !== undefined) return String(value);
  }
  return "";
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

function getQuestionColumns(site: AnyRecord, applications: AnyRecord[], postCheckoutApplications: AnyRecord[]) {
  const fieldsByKey = new Map<string, string>();
  const forms = asArray<AnyRecord>(site.applicationForms || site.forms);

  for (const form of forms) {
    for (const field of asArray<AnyRecord>(form.fields)) {
      const key = String(field.key || field.id || "");
      const label = String(field.label || field.placeholder || key);
      if (key && !fieldsByKey.has(key)) fieldsByKey.set(key, label);
    }
  }

  for (const application of postCheckoutApplications) {
    const formSnapshot = asRecord(application.formSnapshot);
    for (const field of asArray<AnyRecord>(formSnapshot.fields)) {
      const key = String(field.key || field.id || "");
      const label = String(field.label || field.placeholder || key);
      if (key && !fieldsByKey.has(key)) fieldsByKey.set(key, label);
    }
  }

  for (const application of applications) {
    for (const key of Object.keys(asRecord(application.answers))) {
      if (!fieldsByKey.has(key)) fieldsByKey.set(key, key);
    }
  }

  for (const application of postCheckoutApplications) {
    const answers = asRecord(application.submittedAnswers || application.draftAnswers);
    for (const key of Object.keys(answers)) {
      if (!fieldsByKey.has(key)) fieldsByKey.set(key, key);
    }
  }

  return [...fieldsByKey.entries()].map(([key, label]) => ({
    key,
    label: `Question: ${label} [${key}]`,
  }));
}

export function buildCombinedApplicationCsv(
  site: AnyRecord,
  ops: AnyRecord,
  postCheckoutSource: unknown[],
  eventId: string | null,
): CombinedApplicationExportResult {
  const events = asArray<AnyRecord>(site.events);
  const users = asArray<AnyRecord>(ops.users || ops.customers);
  const consents = asArray<AnyRecord>(ops.consents);
  const allApplications = asArray<AnyRecord>(ops.applications);
  const allPostCheckoutApplications = postCheckoutSource.map(asRecord);
  const eventFilter = eventId && eventId !== "all" ? eventId : null;

  const applications = eventFilter
    ? allApplications.filter((application) => String(application.eventId || "") === eventFilter)
    : allApplications;
  const postCheckoutApplications = eventFilter
    ? allPostCheckoutApplications.filter((application) => String(application.eventId || "") === eventFilter)
    : allPostCheckoutApplications;
  const questionColumns = getQuestionColumns(site, applications, postCheckoutApplications);

  const headers = [
    "Application method",
    "Application ID",
    "Event name",
    "Event ID",
    "Event slug",
    "Application status",
    "Payment status",
    "Answer state",
    "Form completion percentage",
    "Created at",
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
    "Consent snapshot JSON",
    "Order ID",
    "Form ID",
    "Form version",
    "Actual form availability",
    "Review deadline",
    "Stripe capture deadline",
    "Authorised amount",
    "Currency",
    "Promo code",
    "Decision",
    "Admin notes / decision reason",
    "Override used",
    "Override reason",
    "Tags / flags",
    ...questionColumns.map((column) => column.label),
  ];

  const normalizedRows: Array<{ createdAt: string; row: unknown[] }> = [];

  for (const application of applications) {
    const userId = String(application.userId || application.customerId || "");
    const eventIdValue = String(application.eventId || "");
    const user = findById(users, userId);
    const event = findById(events, eventIdValue);
    const answers = asRecord(application.answers);
    const createdAt = String(application.createdAt || application.submittedAt || "");

    normalizedRows.push({
      createdAt,
      row: [
        "pre_checkout_application",
        application.id,
        event?.title || eventIdValue,
        event?.id || eventIdValue,
        event?.slug || "",
        application.status || "",
        "",
        Object.keys(answers).length ? "Submitted" : "No answers",
        "",
        createdAt,
        application.submittedAt || application.createdAt || "",
        application.reviewedAt || "",
        user?.id || userId,
        user?.firstName || application.firstName || "",
        user?.lastName || application.lastName || "",
        user?.email || application.email || "",
        user?.phone || application.phone || "",
        user?.instagram || application.instagram || "",
        getConsentValue(consents, String(user?.id || userId), eventIdValue, "age"),
        application.termsAccepted ?? getConsentValue(consents, String(user?.id || userId), eventIdValue, "terms"),
        application.privacyAccepted ?? getConsentValue(consents, String(user?.id || userId), eventIdValue, "privacy"),
        application.entryAccepted ?? getConsentValue(consents, String(user?.id || userId), eventIdValue, "entry"),
        getConsentValue(consents, String(user?.id || userId), eventIdValue, "media"),
        getConsentValue(consents, String(user?.id || userId), eventIdValue, "sponsor"),
        getConsentValue(consents, String(user?.id || userId), eventIdValue, "marketing"),
        "",
        "",
        application.formId || "",
        application.formVersion || "",
        "",
        "",
        "",
        "",
        "",
        application.promoCode || "",
        application.decision || "",
        application.adminNotes || application.notes || "",
        "",
        "",
        [...asArray(user?.tags), ...asArray(application.tags), ...asArray(application.duplicateFlags)].filter(Boolean).join(", "),
        ...questionColumns.map((column) => answerValue(answers, column.key)),
      ],
    });
  }

  for (const application of postCheckoutApplications) {
    const eventIdValue = String(application.eventId || "");
    const event = findById(events, eventIdValue);
    const customer = asRecord(application.customer);
    const order = asRecord(application.order);
    const promo = asRecord(application.promo);
    const decision = asRecord(application.decision);
    const consentSnapshot = asRecord(application.consentSnapshot);
    const submittedAnswers = asRecord(application.submittedAnswers);
    const draftAnswers = asRecord(application.draftAnswers);
    const answers = Object.keys(submittedAnswers).length ? submittedAnswers : draftAnswers;
    const answerState = Object.keys(submittedAnswers).length
      ? "Submitted"
      : Object.keys(draftAnswers).length ? "Saved draft" : "No answers";
    const createdAt = String(application.createdAt || "");

    normalizedRows.push({
      createdAt,
      row: [
        "post_checkout_approval",
        application.id,
        event?.title || eventIdValue,
        event?.id || eventIdValue,
        event?.slug || "",
        application.status || "",
        application.paymentStatus || "",
        answerState,
        application.completionPercentage ?? "",
        createdAt,
        application.submittedAt || "",
        application.reviewedAt || "",
        application.customerId || "",
        customer.firstName || "",
        customer.lastName || "",
        customer.email || "",
        customer.phone || "",
        customer.instagram || "",
        snapshotValue(consentSnapshot, ["ageConfirmed", "age_confirmed", "age"]),
        snapshotValue(consentSnapshot, ["termsAccepted", "terms_accepted", "terms"]),
        snapshotValue(consentSnapshot, ["privacyAccepted", "privacy_accepted", "privacy"]),
        snapshotValue(consentSnapshot, ["entryAccepted", "entry_accepted", "entry"]),
        snapshotValue(consentSnapshot, ["mediaConsent", "media_consent", "media"]),
        snapshotValue(consentSnapshot, ["sponsorConsent", "sponsor_consent", "sponsor"]),
        snapshotValue(consentSnapshot, ["marketingConsent", "marketing_consent", "marketing"]),
        Object.keys(consentSnapshot).length ? JSON.stringify(consentSnapshot) : "",
        application.orderId || "",
        application.formId || "",
        application.formVersion || "",
        application.formDueAt || "",
        application.reviewDueAt || "",
        application.captureBefore || "",
        application.authorizedAmountCents ?? order.totalCents ?? "",
        application.currency || order.currency || "",
        promo.code || "",
        decision.decision || "",
        decision.internalReason || "",
        application.overrideUsed ? "Yes" : "No",
        application.overrideReason || "",
        "",
        ...questionColumns.map((column) => answerValue(answers, column.key)),
      ],
    });
  }

  normalizedRows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const rows = normalizedRows.map((item) => item.row);

  return {
    csv: buildCsv(headers, rows),
    records: rows.length,
    preCheckoutRecords: applications.length,
    postCheckoutRecords: postCheckoutApplications.length,
    filename: eventFilter
      ? `applications-all-methods-${safeFilename(eventFilter)}.csv`
      : "applications-all-methods-all-events.csv",
  };
}
