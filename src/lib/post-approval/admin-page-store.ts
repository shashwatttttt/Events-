import "server-only";

import {
  canSupersedeQueuedFormTimeout,
  postCheckoutAdminBucket,
} from "@/lib/post-approval/admin-classification";
import { listAdminPostCheckoutApplications, PostCheckoutStoreError } from "@/lib/post-approval/store";
import type {
  PostCheckoutAdminItem,
  PostCheckoutApplication,
  PostCheckoutFormSnapshot,
} from "@/lib/post-approval/types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const postCheckoutAdminFilters = [
  "active", "attention", "needs_form", "review", "expiry", "completed", "all",
] as const;
export type PostCheckoutAdminFilter = typeof postCheckoutAdminFilters[number];

export type PostCheckoutAdminPageOptions = {
  filter?: PostCheckoutAdminFilter;
  search?: string;
  eventId?: string;
  cursor?: string;
  limit?: number;
};

export type PostCheckoutAdminPage = {
  items: PostCheckoutAdminItem[];
  nextCursor?: string;
};

const APPLICATION_COLUMNS = [
  "id", "order_id", "reservation_id", "checkout_attempt_id", "customer_id", "event_id",
  "form_id", "form_version", "form_snapshot", "draft_answers", "submitted_answers", "consent_snapshot",
  "status", "payment_status", "completion_percentage", "stripe_checkout_session_id",
  "stripe_payment_intent_id", "authorized_amount_cents", "capturable_amount_cents", "currency",
  "form_due_at", "review_due_at", "capture_before", "next_reminder_at", "reminder_count",
  "last_reminder_at", "last_activity_at", "submitted_at", "reviewed_at", "reviewed_by",
  "override_used", "override_reason", "failure_code", "state_version", "created_at", "updated_at",
].join(",");

const ADMIN_RELATIONS = `${APPLICATION_COLUMNS},customer:profiles!post_checkout_applications_customer_id_fkey(first_name,last_name,email,phone,instagram),orders(status,workflow_status,subtotal_cents,discount_cents,total_cents,currency,created_at,order_lines(kind,reference_id,name,quantity,unit_price_cents)),reservation:reservations!post_checkout_applications_reservation_id_fkey(expected_subtotal_cents,expected_discount_cents,expected_total_cents,promo_code_id),decision:post_checkout_decisions!post_checkout_decisions_application_id_fkey(id,decision,internal_reason,customer_message,actor_id,created_at),payment_actions:post_checkout_payment_actions!post_checkout_payment_actions_application_id_fkey(id,action_type,status,attempt_count,safe_error_code,available_at,last_attempt_at,created_at)`;

type CursorValue = { createdAt: string; id: string };
type RawRow = Record<string, unknown>;

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function answerRecord(value: unknown): Record<string, string | boolean | number> {
  const source = objectRecord(value);
  return Object.fromEntries(
    Object.entries(source).filter(([, item]) => ["string", "boolean", "number"].includes(typeof item)),
  ) as Record<string, string | boolean | number>;
}

function optionalText(value: unknown) {
  return value === null || value === undefined || value === "" ? undefined : String(value);
}

function mapApplication(row: RawRow): PostCheckoutApplication {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    reservationId: String(row.reservation_id),
    checkoutAttemptId: String(row.checkout_attempt_id),
    customerId: String(row.customer_id),
    eventId: String(row.event_id),
    formId: String(row.form_id),
    formVersion: Number(row.form_version),
    formSnapshot: objectRecord(row.form_snapshot) as PostCheckoutFormSnapshot,
    draftAnswers: answerRecord(row.draft_answers),
    submittedAnswers: row.submitted_answers ? answerRecord(row.submitted_answers) : undefined,
    consentSnapshot: objectRecord(row.consent_snapshot),
    status: String(row.status) as PostCheckoutApplication["status"],
    paymentStatus: String(row.payment_status) as PostCheckoutApplication["paymentStatus"],
    completionPercentage: Number(row.completion_percentage || 0),
    stripeCheckoutSessionId: optionalText(row.stripe_checkout_session_id),
    stripePaymentIntentId: optionalText(row.stripe_payment_intent_id),
    authorizedAmountCents: row.authorized_amount_cents === null ? undefined : Number(row.authorized_amount_cents),
    capturableAmountCents: row.capturable_amount_cents === null ? undefined : Number(row.capturable_amount_cents),
    currency: String(row.currency || "AUD"),
    formDueAt: String(row.form_due_at),
    reviewDueAt: optionalText(row.review_due_at),
    captureBefore: optionalText(row.capture_before),
    nextReminderAt: optionalText(row.next_reminder_at),
    reminderCount: Number(row.reminder_count || 0),
    lastReminderAt: optionalText(row.last_reminder_at),
    lastActivityAt: String(row.last_activity_at),
    submittedAt: optionalText(row.submitted_at),
    reviewedAt: optionalText(row.reviewed_at),
    reviewedBy: optionalText(row.reviewed_by),
    overrideUsed: Boolean(row.override_used),
    overrideReason: optionalText(row.override_reason),
    failureCode: optionalText(row.failure_code),
    stateVersion: Number(row.state_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseCursor(cursor?: string): CursorValue | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorValue;
    if (!value.createdAt || !value.id || !Number.isFinite(new Date(value.createdAt).getTime())) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function encodeCursor(item: PostCheckoutAdminItem) {
  return Buffer.from(JSON.stringify({ createdAt: item.createdAt, id: item.id }), "utf8").toString("base64url");
}

function rpcUnavailable(error: unknown) {
  const candidate = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {};
  return String(candidate.code || "") === "PGRST202"
    || String(candidate.message || "").includes("skie_list_post_checkout_admin_page");
}

async function hydrateRows(rows: RawRow[]): Promise<PostCheckoutAdminItem[]> {
  const client = createSupabaseAdminClient();
  const promoIds = [...new Set(rows.flatMap((row) => {
    const reservationValue = Array.isArray(row.reservation) ? row.reservation[0] : row.reservation;
    const reservation = objectRecord(reservationValue);
    return reservation.promo_code_id ? [String(reservation.promo_code_id)] : [];
  }))];
  const promosById = new Map<string, RawRow>();
  if (promoIds.length) {
    const promoResult = await client.from("promo_codes")
      .select("id,code,internal_name,discount_type")
      .in("id", promoIds);
    if (promoResult.error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
    for (const promo of promoResult.data || []) promosById.set(String(promo.id), promo as unknown as RawRow);
  }

  return rows.map((row) => {
    const base = mapApplication(row);
    const profileValue = Array.isArray(row.customer) ? row.customer[0] : row.customer;
    const profile = objectRecord(profileValue);
    const orderValue = Array.isArray(row.orders) ? row.orders[0] : row.orders;
    const order = objectRecord(orderValue);
    const lines = Array.isArray(order.order_lines) ? order.order_lines.map((item) => objectRecord(item)) : [];
    const reservationValue = Array.isArray(row.reservation) ? row.reservation[0] : row.reservation;
    const reservation = objectRecord(reservationValue);
    const promoCodeId = optionalText(reservation.promo_code_id);
    const promo = promoCodeId ? promosById.get(promoCodeId) : undefined;
    const subtotalCents = Number(reservation.expected_subtotal_cents ?? order.subtotal_cents ?? order.total_cents ?? 0);
    const discountCents = Number(reservation.expected_discount_cents ?? order.discount_cents ?? 0);
    const totalCents = Number(order.total_cents || 0);
    const expectedTotalCents = Number(reservation.expected_total_cents ?? totalCents);
    const decisionValue = Array.isArray(row.decision) ? row.decision[0] : row.decision;
    const decision = objectRecord(decisionValue);
    const paymentActions = Array.isArray(row.payment_actions)
      ? row.payment_actions.map((item) => objectRecord(item)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      : [];
    const paymentAction = paymentActions[0] || {};
    return {
      ...base,
      customer: {
        firstName: String(profile.first_name || ""),
        lastName: String(profile.last_name || ""),
        email: String(profile.email || ""),
        phone: String(profile.phone || ""),
        instagram: String(profile.instagram || ""),
      },
      event: { title: String(row.event_id), slug: String(row.event_id) },
      order: {
        status: String(order.status || ""),
        workflowStatus: String(order.workflow_status || ""),
        subtotalCents,
        discountCents,
        totalCents,
        pricingIntegrity: subtotalCents - discountCents === totalCents && expectedTotalCents === totalCents,
        currency: String(order.currency || "AUD"),
        createdAt: String(order.created_at || base.createdAt),
        items: lines.map((line) => ({
          kind: String(line.kind),
          referenceId: String(line.reference_id),
          name: String(line.name),
          quantity: Number(line.quantity),
          unitPriceCents: Number(line.unit_price_cents),
        })),
      },
      promo: promo && promoCodeId ? {
        id: promoCodeId,
        code: String(promo.code || ""),
        internalName: String(promo.internal_name || ""),
        discountType: String(promo.discount_type) as "percentage" | "fixed" | "tracking",
        trackingOnly: String(promo.discount_type) === "tracking",
      } : undefined,
      decision: decision.id ? {
        id: String(decision.id),
        decision: String(decision.decision),
        internalReason: String(decision.internal_reason),
        customerMessage: optionalText(decision.customer_message),
        actorId: String(decision.actor_id),
        createdAt: String(decision.created_at),
      } : undefined,
      paymentAction: paymentAction.id ? {
        id: String(paymentAction.id),
        actionType: String(paymentAction.action_type) as "capture" | "cancel" | "reconcile",
        status: String(paymentAction.status),
        attemptCount: Number(paymentAction.attempt_count || 0),
        safeErrorCode: optionalText(paymentAction.safe_error_code),
        availableAt: String(paymentAction.available_at),
        lastAttemptAt: optionalText(paymentAction.last_attempt_at),
      } : undefined,
    };
  });
}

function fallbackMatches(item: PostCheckoutAdminItem, options: Required<Pick<PostCheckoutAdminPageOptions, "filter" | "search">>) {
  const searchText = `${item.customer.firstName} ${item.customer.lastName} ${item.customer.email} ${item.eventId} ${item.promo?.code || ""} ${item.promo?.internalName || ""}`.toLowerCase();
  if (options.search && !searchText.includes(options.search.toLowerCase())) return false;
  if (options.filter === "all") return true;
  if (options.filter === "needs_form") return ["awaiting_form", "draft"].includes(item.status) || canSupersedeQueuedFormTimeout(item);
  if (options.filter === "review") return ["submitted", "under_review"].includes(item.status);
  if (options.filter === "expiry") return Boolean(item.captureBefore
    && new Date(item.captureBefore).getTime() <= Date.now() + 12 * 60 * 60 * 1000
    && ["authorized", "capture_requested", "cancel_requested"].includes(item.paymentStatus)
    && postCheckoutAdminBucket(item) !== "completed");
  return postCheckoutAdminBucket(item) === options.filter;
}

async function fallbackPage(options: PostCheckoutAdminPageOptions): Promise<PostCheckoutAdminPage> {
  const limit = Math.max(1, Math.min(options.limit || 50, 100));
  const cursor = parseCursor(options.cursor);
  const all = await listAdminPostCheckoutApplications();
  const filtered = all.filter((item) => (!options.eventId || item.eventId === options.eventId)
    && fallbackMatches(item, { filter: options.filter || "active", search: options.search || "" }))
    .filter((item) => !cursor
      || item.createdAt < cursor.createdAt
      || (item.createdAt === cursor.createdAt && item.id < cursor.id));
  const items = filtered.slice(0, limit);
  return { items, nextCursor: filtered.length > limit && items.length ? encodeCursor(items[items.length - 1]) : undefined };
}

export async function listPostCheckoutAdminPage(options: PostCheckoutAdminPageOptions = {}): Promise<PostCheckoutAdminPage> {
  const limit = Math.max(1, Math.min(options.limit || 50, 100));
  const cursor = parseCursor(options.cursor);
  const client = createSupabaseAdminClient();
  const pageResult = await client.rpc("skie_list_post_checkout_admin_page", {
    p_filter: options.filter || "active",
    p_search: (options.search || "").slice(0, 120),
    p_event_id: options.eventId || null,
    p_cursor_created_at: cursor?.createdAt || null,
    p_cursor_id: cursor?.id || null,
    p_limit: limit + 1,
  });
  if (pageResult.error) {
    if (rpcUnavailable(pageResult.error)) return fallbackPage(options);
    throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  }
  const pageRows = (pageResult.data || []) as unknown as Array<{ application_id: string; created_at: string }>;
  const selectedRows = pageRows.slice(0, limit);
  if (!selectedRows.length) return { items: [] };
  const ids = selectedRows.map((row) => String(row.application_id));
  const detailResult = await client.from("post_checkout_applications")
    .select(ADMIN_RELATIONS)
    .in("id", ids);
  if (detailResult.error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  const hydrated = await hydrateRows((detailResult.data || []) as unknown as RawRow[]);
  const itemsById = new Map(hydrated.map((item) => [item.id, item]));
  const items = ids.map((id) => itemsById.get(id)).filter(Boolean) as PostCheckoutAdminItem[];
  return {
    items,
    nextCursor: pageRows.length > limit && items.length ? encodeCursor(items[items.length - 1]) : undefined,
  };
}

export async function getPostCheckoutAdminItemById(applicationId: string) {
  const result = await createSupabaseAdminClient().from("post_checkout_applications")
    .select(ADMIN_RELATIONS)
    .eq("id", applicationId)
    .maybeSingle();
  if (result.error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  if (!result.data) return null;
  return (await hydrateRows([result.data as unknown as RawRow]))[0] || null;
}
