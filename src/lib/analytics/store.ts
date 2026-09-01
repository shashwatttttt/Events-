import "server-only";
import { config } from "@/lib/config";
import { mutateOperationsData, readOperationsData } from "@/lib/data/documents";
import { sanitizeAnalyticsMetadata, sanitizeAnalyticsText, melbourneDate } from "@/lib/analytics/privacy";
import { randomId, sha256 } from "@/lib/security/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { AnalyticsEvent, AnalyticsEventName, AnalyticsReport, NotificationChannel } from "@/types/site";

export type AnalyticsCapture = {
  eventName: AnalyticsEventName; source: "client" | "server"; deduplicationKey: string; occurredAt?: string;
  eventId?: string; ticketTypeId?: string; promoCodeId?: string; notificationChannel?: NotificationChannel;
  utmSource?: string; utmMedium?: string; utmCampaign?: string; referrerCategory?: AnalyticsEvent["referrerCategory"];
  deviceCategory?: AnalyticsEvent["deviceCategory"]; browserFamily?: AnalyticsEvent["browserFamily"];
  anonymousSessionHash?: string; customerId?: string; revenueCents?: number; quantity?: number; safeMetadata?: unknown;
};
export type AnalyticsFilters = { startDate: string; endDate: string; eventId?: string; campaign?: string; channel?: string };

function normalizeCapture(input: AnalyticsCapture): AnalyticsCapture {
  return { ...input, deduplicationKey: sanitizeAnalyticsText(input.deduplicationKey, 200) || sha256(input.deduplicationKey), eventId: sanitizeAnalyticsText(input.eventId, 120), ticketTypeId: sanitizeAnalyticsText(input.ticketTypeId, 120), utmSource: sanitizeAnalyticsText(input.utmSource), utmMedium: sanitizeAnalyticsText(input.utmMedium), utmCampaign: sanitizeAnalyticsText(input.utmCampaign), safeMetadata: sanitizeAnalyticsMetadata(input.safeMetadata) };
}

function mapRow(row: Record<string, unknown>): AnalyticsEvent {
  return { id: String(row.id), eventName: String(row.event_name) as AnalyticsEventName, source: String(row.source) as "client" | "server", deduplicationKey: String(row.deduplication_key), eventId: row.event_id ? String(row.event_id) : undefined, ticketTypeId: row.ticket_type_id ? String(row.ticket_type_id) : undefined, promoCodeId: row.promo_code_id ? String(row.promo_code_id) : undefined, notificationChannel: row.notification_channel ? String(row.notification_channel) as NotificationChannel : undefined, utmSource: row.utm_source ? String(row.utm_source) : undefined, utmMedium: row.utm_medium ? String(row.utm_medium) : undefined, utmCampaign: row.utm_campaign ? String(row.utm_campaign) : undefined, referrerCategory: row.referrer_category as AnalyticsEvent["referrerCategory"], deviceCategory: row.device_category as AnalyticsEvent["deviceCategory"], browserFamily: row.browser_family as AnalyticsEvent["browserFamily"], anonymousSessionHash: row.anonymous_session_hash ? String(row.anonymous_session_hash) : undefined, customerId: row.customer_id ? String(row.customer_id) : undefined, revenueCents: row.revenue_cents === null || row.revenue_cents === undefined ? undefined : Number(row.revenue_cents), quantity: row.quantity === null || row.quantity === undefined ? undefined : Number(row.quantity), safeMetadata: (row.safe_metadata || {}) as AnalyticsEvent["safeMetadata"], occurredAt: String(row.occurred_at), melbourneDate: String(row.melbourne_date), retentionUntil: String(row.retention_until), createdAt: String(row.created_at) };
}

export async function captureAnalyticsEvent(raw: AnalyticsCapture) {
  const input = normalizeCapture(raw);
  if (config.dataProvider === "supabase") {
    const { data, error } = await createSupabaseAdminClient().rpc("skie_capture_analytics_event", { p_event_name: input.eventName, p_source: input.source, p_deduplication_key: input.deduplicationKey, p_occurred_at: input.occurredAt || new Date().toISOString(), p_event_id: input.eventId || null, p_ticket_type_id: input.ticketTypeId || null, p_promo_code_id: input.promoCodeId || null, p_notification_channel: input.notificationChannel || null, p_utm_source: input.utmSource || null, p_utm_medium: input.utmMedium || null, p_utm_campaign: input.utmCampaign || null, p_referrer_category: input.referrerCategory || null, p_device_category: input.deviceCategory || null, p_browser_family: input.browserFamily || null, p_anonymous_session_hash: input.anonymousSessionHash || null, p_customer_id: input.customerId || null, p_revenue_cents: input.revenueCents ?? null, p_quantity: input.quantity ?? null, p_safe_metadata: input.safeMetadata || {} });
    if (error) throw new Error("ANALYTICS_CAPTURE_UNAVAILABLE");
    return data as { accepted: boolean; inserted: boolean; eventId?: string };
  }
  return mutateOperationsData((operations) => {
    const existing = operations.analyticsEvents.find((event) => event.deduplicationKey === input.deduplicationKey);
    if (existing) return { accepted: true, inserted: false, eventId: existing.id };
    const occurredAt = input.occurredAt || new Date().toISOString();
    const retention = new Date(occurredAt); retention.setUTCDate(retention.getUTCDate() + 400);
    const event: AnalyticsEvent = { id: randomId("analytics"), eventName: input.eventName, source: input.source, deduplicationKey: input.deduplicationKey, eventId: input.eventId, ticketTypeId: input.ticketTypeId, promoCodeId: input.promoCodeId, notificationChannel: input.notificationChannel, utmSource: input.utmSource, utmMedium: input.utmMedium, utmCampaign: input.utmCampaign, referrerCategory: input.referrerCategory, deviceCategory: input.deviceCategory, browserFamily: input.browserFamily, anonymousSessionHash: input.anonymousSessionHash, customerId: input.customerId, revenueCents: input.revenueCents, quantity: input.quantity, safeMetadata: input.safeMetadata as AnalyticsEvent["safeMetadata"], occurredAt, melbourneDate: melbourneDate(occurredAt), retentionUntil: melbourneDate(retention), createdAt: new Date().toISOString() };
    operations.analyticsEvents.push(event);
    return { accepted: true, inserted: true, eventId: event.id };
  });
}

export async function captureAnalyticsSafely(input: AnalyticsCapture) {
  try { return await captureAnalyticsEvent(input); }
  catch { return { accepted: false, inserted: false }; }
}

function filtered(events: AnalyticsEvent[], filters: AnalyticsFilters) {
  return deduplicateAnalyticsEvents(events).filter((event) => event.melbourneDate >= filters.startDate && event.melbourneDate <= filters.endDate && (!filters.eventId || event.eventId === filters.eventId) && (!filters.campaign || event.utmCampaign === filters.campaign) && (!filters.channel || event.notificationChannel === filters.channel));
}

export function deduplicateAnalyticsEvents(events: AnalyticsEvent[]) { const seen=new Set<string>();return events.filter((event)=>{if(seen.has(event.deduplicationKey))return false;seen.add(event.deduplicationKey);return true;}); }

export function aggregateAnalytics(events: AnalyticsEvent[], filters: AnalyticsFilters): AnalyticsReport {
  const scoped = filtered(events, filters); const byType = new Map<AnalyticsEventName, { count: number; revenueCents: number; quantity: number }>(); const byDate = new Map<string, { count: number; revenueCents: number }>();
  for (const event of scoped) { const type = byType.get(event.eventName) || { count: 0, revenueCents: 0, quantity: 0 }; type.count += 1; type.revenueCents += event.revenueCents || 0; type.quantity += event.quantity || 0; byType.set(event.eventName, type); const date = byDate.get(event.melbourneDate) || { count: 0, revenueCents: 0 }; date.count += 1; date.revenueCents += event.revenueCents || 0; byDate.set(event.melbourneDate, date); }
  return { startDate: filters.startDate, endDate: filters.endDate, totals: { events: scoped.length, revenueCents: scoped.filter((event) => event.eventName === "payment_completed").reduce((sum, event) => sum + (event.revenueCents || 0), 0), ticketQuantity: scoped.filter((event) => event.eventName === "ticket_issued").reduce((sum, event) => sum + (event.quantity || 0), 0) }, byEventType: [...byType].map(([eventName, value]) => ({ eventName, ...value })).sort((a,b) => a.eventName.localeCompare(b.eventName)), byDate: [...byDate].map(([date,value]) => ({ date,...value })).sort((a,b) => a.date.localeCompare(b.date)) };
}

export async function analyticsReport(filters: AnalyticsFilters) {
  if (config.dataProvider === "supabase") { const { data, error } = await createSupabaseAdminClient().rpc("skie_analytics_report", { p_start_date: filters.startDate, p_end_date: filters.endDate, p_event_id: filters.eventId || null, p_campaign: filters.campaign || null, p_channel: filters.channel || null }); if (error) throw new Error("ANALYTICS_REPORT_UNAVAILABLE"); return data as AnalyticsReport; }
  return aggregateAnalytics((await readOperationsData()).analyticsEvents, filters);
}

export async function analyticsEvents(filters: AnalyticsFilters) {
  if (config.dataProvider === "supabase") {
    const client = createSupabaseAdminClient();
    let query = client.from("analytics_events").select("*").gte("melbourne_date", filters.startDate).lte("melbourne_date", filters.endDate).order("occurred_at", { ascending: true }).limit(10000);
    if (filters.eventId) query=query.eq("event_id",filters.eventId);
    if (filters.campaign) query=query.eq("utm_campaign",filters.campaign);
    if (filters.channel) query=query.eq("notification_channel",filters.channel);
    const [eventsResult, removedResult] = await Promise.all([
      query,
      client.from("profiles").select("id").not("admin_deleted_at", "is", null).limit(5000),
    ]);
    if(eventsResult.error || removedResult.error) throw new Error("ANALYTICS_REPORT_UNAVAILABLE");
    const removed = new Set((removedResult.data || []).map((row) => String(row.id)));
    return (eventsResult.data||[]).map((row)=>mapRow(row)).filter((event) => !event.customerId || !removed.has(event.customerId));
  }
  return filtered((await readOperationsData()).analyticsEvents,filters).sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt));
}

function csvCell(value: unknown) { const raw=String(value??""); const safe=/^[\t\r\n ]*[=+\-@]/.test(raw)?`'${raw}`:raw; return `"${safe.replaceAll('"','""')}"`; }
export function analyticsCsv(events: AnalyticsEvent[]) { const headers=["UTC timestamp","Melbourne date","Event type","Event ID","Ticket type ID","Promo code ID","Channel","UTM source","UTM medium","UTM campaign","Referrer category","Device category","Browser family","Revenue cents","Quantity"]; return `\uFEFF${[headers,...events.map((event)=>[event.occurredAt,event.melbourneDate,event.eventName,event.eventId,event.ticketTypeId,event.promoCodeId,event.notificationChannel,event.utmSource,event.utmMedium,event.utmCampaign,event.referrerCategory,event.deviceCategory,event.browserFamily,event.revenueCents,event.quantity])].map((row)=>row.map(csvCell).join(",")).join("\r\n")}`; }
