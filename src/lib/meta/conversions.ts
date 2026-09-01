import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { sanitizeAnalyticsMetadata, sanitizeAnalyticsText } from "@/lib/analytics/privacy";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Order } from "@/types/site";
import type {
  MetaConversionInput,
  MetaDashboardReport,
  MetaRequestContext,
  MetaStandardEvent,
} from "@/lib/meta/types";

const MAX_ATTEMPTS = 8;
const META_COOKIE_PATTERN = /^fb\.[0-9]+\.[0-9]+\.[A-Za-z0-9._-]+$/;

type MetaRow = {
  id: string;
  meta_event_id: string;
  event_name: MetaStandardEvent;
  source_event: string;
  customer_id?: string | null;
  skie_event_id?: string | null;
  order_id?: string | null;
  value_cents?: number | string | null;
  currency?: string | null;
  quantity?: number | null;
  content_ids?: string[] | null;
  event_source_url?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  safe_metadata?: Record<string, string | number | boolean | null> | null;
  status: string;
  attempt_count: number;
  occurred_at: string;
};

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeMetaEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeMetaPhone(value: unknown, country = "AU") {
  if (typeof value !== "string") return "";
  let digits = value.replace(/\D/g, "");
  if (country === "AU") {
    if (digits.startsWith("0")) digits = `61${digits.slice(1)}`;
    else if (!digits.startsWith("61") && digits.length === 9) digits = `61${digits}`;
  }
  return digits;
}

function cleanId(value: unknown, maximum = 160) {
  return sanitizeAnalyticsText(value, maximum)?.replaceAll("/", "_");
}

function cleanUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return config.siteUrl;
  try {
    const url = new URL(value);
    const site = new URL(config.siteUrl);
    if (url.origin !== site.origin) return config.siteUrl;
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (!["utm_source", "utm_medium", "utm_campaign"].includes(key)) url.searchParams.delete(key);
    }
    return url.toString().slice(0, 1000);
  } catch {
    return config.siteUrl;
  }
}

function cleanMetaCookie(value: unknown) {
  return typeof value === "string" && META_COOKIE_PATTERN.test(value)
    ? value.slice(0, 220)
    : undefined;
}

function retryDelaySeconds(attempt: number) {
  return Math.min(6 * 60 * 60, 30 * (2 ** Math.max(0, attempt - 1)));
}

function safeDeliveryCode(status: number, body: unknown) {
  if (status === 401 || status === 403) return "META_AUTH_FAILED";
  if (status === 429) return "META_RATE_LIMITED";
  if (status >= 500) return "META_PROVIDER_UNAVAILABLE";
  if (body && typeof body === "object" && "error" in body) return "META_EVENT_REJECTED";
  return "META_DELIVERY_FAILED";
}

async function inheritedAttribution(orderId?: string) {
  if (!orderId || config.dataProvider !== "supabase") return {};
  const { data } = await createSupabaseAdminClient()
    .from("meta_conversion_events")
    .select("fbp,fbc,event_source_url")
    .eq("order_id", orderId)
    .eq("event_name", "InitiateCheckout")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return {
    fbp: cleanMetaCookie(data?.fbp),
    fbc: cleanMetaCookie(data?.fbc),
    eventSourceUrl: cleanUrl(data?.event_source_url),
  };
}

export async function queueMetaConversion(raw: MetaConversionInput) {
  if (config.dataProvider !== "supabase" || !config.metaPixelId) {
    return { queued: false, delivered: false, status: "skipped" as const };
  }
  const inherited = await inheritedAttribution(raw.orderId);
  const metaEventId = cleanId(raw.metaEventId, 200);
  if (!metaEventId) throw new Error("META_EVENT_ID_INVALID");
  const payload = {
    meta_event_id: metaEventId,
    event_name: raw.eventName,
    source_event: cleanId(raw.sourceEvent, 120) || "unknown",
    customer_id: raw.customerId || null,
    skie_event_id: cleanId(raw.eventId, 120) || null,
    order_id: cleanId(raw.orderId, 120) || null,
    value_cents: Number.isInteger(raw.valueCents) && Number(raw.valueCents) >= 0 ? raw.valueCents : null,
    currency: /^[A-Z]{3}$/.test(String(raw.currency || "")) ? raw.currency : null,
    quantity: Number.isInteger(raw.quantity) && Number(raw.quantity) >= 0 ? raw.quantity : null,
    content_ids: (raw.contentIds || []).map((item) => cleanId(item, 120)).filter(Boolean).slice(0, 50),
    event_source_url: cleanUrl(raw.eventSourceUrl || inherited.eventSourceUrl),
    fbp: cleanMetaCookie(raw.fbp || inherited.fbp) || null,
    fbc: cleanMetaCookie(raw.fbc || inherited.fbc) || null,
    safe_metadata: sanitizeAnalyticsMetadata(raw.safeMetadata),
    occurred_at: raw.occurredAt || new Date().toISOString(),
    status: "queued",
    available_at: new Date().toISOString(),
  };
  const client = createSupabaseAdminClient();
  const { data, error } = await client
    .from("meta_conversion_events")
    .upsert(payload, { onConflict: "meta_event_id", ignoreDuplicates: true })
    .select("id,status")
    .maybeSingle();
  if (error) throw new Error("META_EVENT_QUEUE_UNAVAILABLE");
  let id = data?.id ? String(data.id) : "";
  if (!id) {
    const existing = await client.from("meta_conversion_events")
      .select("id,status")
      .eq("meta_event_id", metaEventId)
      .single();
    if (existing.error || !existing.data) throw new Error("META_EVENT_QUEUE_UNAVAILABLE");
    id = String(existing.data.id);
  }
  if (!config.metaConversionsApiEnabled) {
    return { queued: true, delivered: false, status: "queued" as const, id };
  }
  const delivered = await deliverMetaConversion(id).catch(() => ({ delivered: false, status: "retry" as const }));
  return { queued: true, id, ...delivered };
}

async function customerUserData(row: MetaRow) {
  const userData: Record<string, string[] | string> = {};
  if (row.customer_id) {
    const { data } = await createSupabaseAdminClient()
      .from("profiles")
      .select("email,phone")
      .eq("id", row.customer_id)
      .is("admin_deleted_at", null)
      .maybeSingle();
    const email = normalizeMetaEmail(data?.email);
    const phone = normalizeMetaPhone(data?.phone);
    if (email) userData.em = [hash(email)];
    if (phone) userData.ph = [hash(phone)];
    userData.external_id = [hash(String(row.customer_id))];
  }
  const fbp = cleanMetaCookie(row.fbp);
  const fbc = cleanMetaCookie(row.fbc);
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  return userData;
}

async function finishDelivery(
  row: MetaRow,
  values: Record<string, unknown>,
) {
  const { error } = await createSupabaseAdminClient()
    .from("meta_conversion_events")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", row.id);
  if (error) throw new Error("META_EVENT_STATUS_UNAVAILABLE");
}

export async function deliverMetaConversion(id: string) {
  const client = createSupabaseAdminClient();
  const { data, error } = await client.from("meta_conversion_events").select("*").eq("id", id).single();
  if (error || !data) throw new Error("META_EVENT_NOT_FOUND");
  const row = data as MetaRow;
  if (row.status === "sent") return { delivered: true, status: "sent" as const };
  if (!config.metaConversionsApiEnabled) return { delivered: false, status: "queued" as const };
  const userData = await customerUserData(row);
  if (!Object.keys(userData).length) {
    await finishDelivery(row, { status: "skipped", safe_error_code: "META_MATCH_DATA_UNAVAILABLE" });
    return { delivered: false, status: "skipped" as const };
  }
  const customData: Record<string, unknown> = {};
  if (row.currency) customData.currency = row.currency;
  if (row.value_cents !== null && row.value_cents !== undefined) customData.value = Number(row.value_cents) / 100;
  if (row.quantity !== null && row.quantity !== undefined) customData.num_items = Number(row.quantity);
  if (row.content_ids?.length) {
    customData.content_ids = row.content_ids;
    customData.content_type = "product";
  }
  if (row.order_id) customData.order_id = row.order_id;
  const event = {
    event_name: row.event_name,
    event_time: Math.floor(new Date(row.occurred_at).getTime() / 1000),
    event_id: row.meta_event_id,
    action_source: "website",
    event_source_url: cleanUrl(row.event_source_url),
    user_data: userData,
    custom_data: customData,
  };
  const body: Record<string, unknown> = { data: [event], partner_agent: "skie-events-direct-capi" };
  if (config.metaTestEventCode) body.test_event_code = config.metaTestEventCode;
  let response: Response;
  let responseBody: unknown = null;
  try {
    response = await fetch(
      `https://graph.facebook.com/${encodeURIComponent(config.metaGraphApiVersion)}/${encodeURIComponent(config.metaPixelId)}/events`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.metaConversionsApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    );
    responseBody = await response.json().catch(() => null);
  } catch {
    const delay = retryDelaySeconds(row.attempt_count || 1);
    await finishDelivery(row, {
      status: "retry",
      safe_error_code: "META_NETWORK_FAILED",
      available_at: new Date(Date.now() + delay * 1000).toISOString(),
    });
    return { delivered: false, status: "retry" as const };
  }
  if (response.ok) {
    const result = responseBody && typeof responseBody === "object"
      ? responseBody as { events_received?: unknown }
      : {};
    await finishDelivery(row, {
      status: "sent",
      sent_at: new Date().toISOString(),
      safe_error_code: null,
      response_status: response.status,
      events_received: Number(result.events_received || 0),
    });
    return { delivered: true, status: "sent" as const };
  }
  const retryable = response.status === 429 || response.status >= 500;
  const attempt = Number(row.attempt_count || 1);
  await finishDelivery(row, {
    status: retryable && attempt < MAX_ATTEMPTS ? "retry" : "failed",
    safe_error_code: safeDeliveryCode(response.status, responseBody),
    response_status: response.status,
    available_at: new Date(Date.now() + retryDelaySeconds(attempt) * 1000).toISOString(),
  });
  return { delivered: false, status: retryable && attempt < MAX_ATTEMPTS ? "retry" as const : "failed" as const };
}

export async function processMetaConversionBatch(batchSize = 10) {
  if (!config.metaConversionsApiEnabled || config.dataProvider !== "supabase") {
    return { processed: 0, sent: 0, retry: 0, failed: 0, disabled: true };
  }
  const { data, error } = await createSupabaseAdminClient().rpc("skie_claim_meta_conversion_events", {
    p_limit: Math.max(1, Math.min(25, batchSize)),
    p_worker_id: `meta_${randomUUID()}`,
  });
  if (error) throw new Error("META_EVENT_CLAIM_UNAVAILABLE");
  const rows = (Array.isArray(data) ? data : []) as MetaRow[];
  const result = { processed: rows.length, sent: 0, retry: 0, failed: 0, disabled: false };
  for (const row of rows) {
    const delivery = await deliverMetaConversion(row.id).catch(() => ({ delivered: false, status: "retry" as const }));
    if (delivery.status === "sent") result.sent += 1;
    else if (delivery.status === "failed") result.failed += 1;
    else result.retry += 1;
  }
  return result;
}

export async function queueMetaLead(input: {
  customerId: string;
  eventId: string;
  referenceId: string;
  method: "pre_checkout" | "post_checkout";
  context: MetaRequestContext;
  orderId?: string;
  occurredAt?: string;
}) {
  if (!input.context.consentGranted) return { queued: false, delivered: false, status: "skipped" as const };
  return queueMetaConversion({
    metaEventId: `lead:${input.method}:${input.referenceId}`,
    eventName: "Lead",
    sourceEvent: input.method === "pre_checkout" ? "application_submitted" : "post_checkout_form_submitted",
    customerId: input.customerId,
    eventId: input.eventId,
    orderId: input.orderId,
    contentIds: [input.eventId],
    eventSourceUrl: input.context.eventSourceUrl,
    fbp: input.context.fbp,
    fbc: input.context.fbc,
    safeMetadata: { method: input.method },
    occurredAt: input.occurredAt,
  });
}

export async function queueMetaCheckout(order: Order, context: MetaRequestContext) {
  if (!context.consentGranted || order.totalCents <= 0) {
    return { queued: false, delivered: false, status: "skipped" as const };
  }
  const ticket = order.items.find((item) => item.kind === "ticket");
  return queueMetaConversion({
    metaEventId: `checkout:${order.id}`,
    eventName: "InitiateCheckout",
    sourceEvent: "checkout_started",
    customerId: order.userId,
    eventId: order.eventId,
    orderId: order.id,
    valueCents: order.totalCents,
    currency: order.currency.toUpperCase(),
    quantity: ticket?.quantity || 0,
    contentIds: order.items.map((item) => item.referenceId),
    eventSourceUrl: context.eventSourceUrl,
    fbp: context.fbp,
    fbc: context.fbc,
    safeMetadata: { checkoutMode: order.allocationId ? "invite" : "direct_or_post_checkout" },
    occurredAt: order.createdAt,
  });
}

export async function queueMetaPurchaseForOrder(orderId: string, occurredAt?: string) {
  if (config.dataProvider !== "supabase") return { queued: false, delivered: false, status: "skipped" as const };
  const client = createSupabaseAdminClient();
  const { data: order, error } = await client.from("orders")
    .select("id,event_id,customer_id,total_cents,currency,status,order_lines(kind,reference_id,quantity)")
    .eq("id", orderId)
    .single();
  if (error || !order || order.status !== "fulfilled" || Number(order.total_cents || 0) <= 0) {
    return { queued: false, delivered: false, status: "skipped" as const };
  }
  const attribution = await client.from("meta_conversion_events")
    .select("fbp,fbc,event_source_url")
    .eq("order_id", orderId)
    .eq("event_name", "InitiateCheckout")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!attribution.data) {
    return { queued: false, delivered: false, status: "skipped" as const };
  }
  const lines = Array.isArray(order.order_lines) ? order.order_lines : [];
  const ticketQuantity = lines
    .filter((line) => String(line.kind) === "ticket")
    .reduce((sum, line) => sum + Number(line.quantity || 0), 0);
  return queueMetaConversion({
    metaEventId: `purchase:${orderId}`,
    eventName: "Purchase",
    sourceEvent: "order_fulfilled",
    customerId: String(order.customer_id),
    eventId: String(order.event_id),
    orderId,
    valueCents: Number(order.total_cents),
    currency: String(order.currency || config.currency).toUpperCase(),
    quantity: ticketQuantity,
    contentIds: lines.map((line) => String(line.reference_id)).filter(Boolean),
    eventSourceUrl: attribution.data.event_source_url || config.siteUrl,
    fbp: attribution.data.fbp || undefined,
    fbc: attribution.data.fbc || undefined,
    safeMetadata: { fulfilmentVerified: true },
    occurredAt,
  });
}

export async function readMetaDashboard(since: string): Promise<MetaDashboardReport> {
  if (config.dataProvider !== "supabase") {
    return {
      since,
      totals: { events: 0, sent: 0, pending: 0, failed: 0, purchaseValueCents: 0 },
      byEvent: [],
      recent: [],
    };
  }
  const { data, error } = await createSupabaseAdminClient().rpc("skie_meta_ads_dashboard", { p_since: since });
  if (error) throw new Error("META_DASHBOARD_UNAVAILABLE");
  return data as MetaDashboardReport;
}
