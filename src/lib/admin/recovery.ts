import "server-only";
import { randomUUID } from "node:crypto";
import { config } from "@/lib/config";
import { mutateOperationsData, mutateSiteData, readOperationsData } from "@/lib/data/documents";
import { PublicApiError } from "@/lib/http";
import { randomId } from "@/lib/security/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createTicketToken, createTicketTokenHash } from "@/lib/tickets/security";
import type { AdminSavedFilter, EventItem, EventLaunchReadiness, SessionUser, Ticket } from "@/types/site";

type SafeValue = string | number | boolean | null;

function assertReason(reason: string) {
  const clean = reason.trim().slice(0, 500);
  if (clean.length < 3) throw new PublicApiError("RECOVERY_REASON_REQUIRED", "Enter a reason of at least three characters.", 422);
  return clean;
}

function auditLocal(actor: SessionUser, action: string, entityType: string, entityId: string, metadata: Record<string, SafeValue>, reason?: string) {
  return mutateOperationsData((operations) => {
    operations.auditLogs.push({
      id: randomId("audit"), actorId: actor.id, actorEmail: actor.email, action, entityType, entityId,
      metadata: { ...metadata, ...(reason ? { reason } : {}) }, createdAt: new Date().toISOString(),
    });
  });
}

export async function recordAdminOperation(input: {
  actor: SessionUser; action: string; entityType: string; entityId: string; operationId: string;
  reason?: string; safeMetadata?: Record<string, SafeValue>;
}) {
  if (config.dataProvider !== "supabase") return auditLocal(input.actor, input.action, input.entityType, input.entityId, input.safeMetadata || {}, input.reason);
  const { error } = await createSupabaseAdminClient().rpc("skie_admin_record_operation", {
    p_actor_id: input.actor.id, p_action: input.action, p_entity_type: input.entityType, p_entity_id: input.entityId,
    p_reason: input.reason || null, p_idempotency_key: input.operationId, p_safe_metadata: input.safeMetadata || {},
  });
  if (error) throw new PublicApiError("ADMIN_AUDIT_FAILED", "The administrative audit entry could not be recorded.", 503);
}

function duplicateSlug(source: string) {
  return `${source.replace(/-copy(?:-\d+)?$/, "")}-copy-${Date.now().toString(36)}`.slice(0, 80);
}

export async function duplicateEvent(actor: SessionUser, eventId: string, operationId: string) {
  const cloned = await mutateSiteData((site) => {
    const source = site.events.find((item) => item.id === eventId);
    if (!source) throw new PublicApiError("EVENT_NOT_FOUND", "Event was not found.", 404);
    const nextId = randomId("event");
    const event: EventItem = {
      ...structuredClone(source), id: nextId, slug: duplicateSlug(source.slug), title: `${source.title} (Copy)`,
      lifecycle: "draft", visibility: "hidden", featured: false,
      ticketTypes: source.ticketTypes.map((ticket) => ({ ...ticket, id: randomId("ticket_type"), sold: 0 })),
      productIds: [],
    };
    site.events.push(event);
    return event;
  });
  await recordAdminOperation({ actor, action: "event.duplicated", entityType: "event", entityId: cloned.id, operationId, safeMetadata: { sourceEventId: eventId } });
  return cloned;
}

function mapSavedFilter(row: Record<string, unknown>): AdminSavedFilter {
  return { id: String(row.id), actorId: String(row.actor_id), scope: row.scope as AdminSavedFilter["scope"], name: String(row.name), filters: (row.filters || {}) as AdminSavedFilter["filters"], createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function mapReadiness(row: Record<string, unknown>): EventLaunchReadiness {
  return { eventId: String(row.event_id), checklist: (row.checklist || {}) as Record<string, boolean>, lowStockThreshold: Number(row.low_stock_threshold), capacityWarningPercent: Number(row.capacity_warning_percent), updatedBy: String(row.updated_by), updatedAt: String(row.updated_at) };
}

export async function listAdminConvenienceData(actor: SessionUser) {
  if (config.dataProvider !== "supabase") {
    const operations = await readOperationsData();
    return { savedFilters: operations.adminSavedFilters.filter((item) => item.actorId === actor.id), readiness: operations.eventLaunchReadiness, entitlementRedemptions: operations.entitlementRedemptions, operationAudits: operations.auditLogs };
  }
  const client = createSupabaseAdminClient();
  const [filters, readiness, redemptions, audits] = await Promise.all([
    client.from("admin_saved_filters").select("*").eq("actor_id", actor.id).order("updated_at", { ascending: false }),
    client.from("event_launch_readiness").select("*").order("updated_at", { ascending: false }),
    client.from("entitlement_redemptions").select("id,entitlement_id,event_id,quantity,redeemed_by,idempotency_key,redeemed_at,reversed_at,reversed_by,reversal_reason").order("redeemed_at", { ascending: false }).limit(250),
    client.from("admin_operation_audit").select("id,actor_id,action,entity_type,entity_id,reason,safe_metadata,created_at").order("created_at", { ascending: false }).limit(250),
  ]);
  if (filters.error || readiness.error || redemptions.error || audits.error) throw new PublicApiError("ADMIN_TOOLS_UNAVAILABLE", "Admin recovery data is temporarily unavailable.", 503);
  return { savedFilters: (filters.data || []).map((row) => mapSavedFilter(row)), readiness: (readiness.data || []).map((row) => mapReadiness(row)), entitlementRedemptions: redemptions.data || [], operationAudits: (audits.data || []).map((row) => ({ id: row.id, actorId: row.actor_id, actorEmail: "Protected admin", action: row.action, entityType: row.entity_type, entityId: row.entity_id, metadata: { ...(row.safe_metadata as Record<string, SafeValue>), ...(row.reason ? { reason: row.reason } : {}) }, createdAt: row.created_at })) };
}

export async function saveAdminFilter(actor: SessionUser, scope: AdminSavedFilter["scope"], name: string, filters: AdminSavedFilter["filters"]) {
  if (config.dataProvider !== "supabase") return mutateOperationsData((operations) => {
    const now = new Date().toISOString();
    const current = operations.adminSavedFilters.find((item) => item.actorId === actor.id && item.scope === scope && item.name === name);
    if (current) { current.filters = filters; current.updatedAt = now; return current; }
    const item: AdminSavedFilter = { id: randomId("filter"), actorId: actor.id, scope, name, filters, createdAt: now, updatedAt: now };
    operations.adminSavedFilters.push(item); return item;
  });
  const { data, error } = await createSupabaseAdminClient().rpc("skie_admin_save_filter", { p_actor_id: actor.id, p_scope: scope, p_name: name, p_filters: filters });
  if (error || !data) throw new PublicApiError("FILTER_SAVE_FAILED", "The saved filter could not be stored.", 503);
  return mapSavedFilter((Array.isArray(data) ? data[0] : data) as Record<string, unknown>);
}

export async function saveLaunchReadiness(actor: SessionUser, input: { eventId: string; checklist: Record<string, boolean>; lowStockThreshold: number; capacityWarningPercent: number; operationId: string }) {
  if (config.dataProvider !== "supabase") return mutateOperationsData((operations) => {
    const now = new Date().toISOString();
    const item: EventLaunchReadiness = { eventId: input.eventId, checklist: input.checklist, lowStockThreshold: input.lowStockThreshold, capacityWarningPercent: input.capacityWarningPercent, updatedBy: actor.id, updatedAt: now };
    const index = operations.eventLaunchReadiness.findIndex((candidate) => candidate.eventId === input.eventId);
    if (index >= 0) operations.eventLaunchReadiness[index] = item; else operations.eventLaunchReadiness.push(item);
    operations.auditLogs.push({ id: randomId("audit"), actorId: actor.id, actorEmail: actor.email, action: "launch_readiness.updated", entityType: "event", entityId: input.eventId, metadata: { lowStockThreshold: input.lowStockThreshold, capacityWarningPercent: input.capacityWarningPercent }, createdAt: now });
    return item;
  });
  const { data, error } = await createSupabaseAdminClient().rpc("skie_admin_save_launch_readiness", { p_actor_id: actor.id, p_event_id: input.eventId, p_checklist: input.checklist, p_low_stock_threshold: input.lowStockThreshold, p_capacity_warning_percent: input.capacityWarningPercent, p_idempotency_key: input.operationId });
  if (error || !data) throw new PublicApiError("READINESS_SAVE_FAILED", "Launch readiness could not be saved.", 503);
  return mapReadiness((Array.isArray(data) ? data[0] : data) as Record<string, unknown>);
}

export async function reissueTicket(actor: SessionUser, ticketId: string, reasonInput: string, operationId: string) {
  const reason = assertReason(reasonInput);
  if (config.dataProvider !== "supabase") return mutateOperationsData((operations) => {
    const replay = operations.auditLogs.find((item) => item.action === "ticket.reissued" && item.metadata.operationId === operationId);
    if (replay) return operations.tickets.find((item) => item.id === replay.metadata.replacementTicketId)!;
    const old = operations.tickets.find((item) => item.id === ticketId);
    if (!old || !["valid", "checked_in"].includes(old.status)) throw new PublicApiError("TICKET_NOT_REISSUABLE", "This ticket cannot be reissued.", 409);
    const id = randomId("ticket"); const replacement: Ticket = { ...old, id, ticketCode: `SKIE-${id.slice(-12).toUpperCase().match(/.{1,4}/g)?.join("-")}`, tokenPreview: "", tokenHash: "", status: "valid", checkedInAt: undefined, checkedInBy: undefined, createdAt: new Date().toISOString() };
    replacement.tokenPreview = createTicketToken(replacement).slice(0, 8);
    replacement.tokenHash = createTicketTokenHash(replacement); old.status = "transferred"; operations.tickets.push(replacement);
    operations.auditLogs.push({ id: randomId("audit"), actorId: actor.id, actorEmail: actor.email, action: "ticket.reissued", entityType: "ticket", entityId: old.id, metadata: { replacementTicketId: replacement.id, operationId, reason }, createdAt: replacement.createdAt });
    return replacement;
  });
  const oldResult = await createSupabaseAdminClient().from("tickets").select("event_id,customer_id").eq("id", ticketId).maybeSingle();
  if (oldResult.error || !oldResult.data) throw new PublicApiError("TICKET_NOT_FOUND", "Ticket was not found.", 404);
  const id = randomUUID(); const tokenIdentity = { id, eventId: String(oldResult.data.event_id), userId: String(oldResult.data.customer_id) };
  const code = `SKIE-${id.replaceAll("-", "").slice(-12).toUpperCase().match(/.{1,4}/g)?.join("-")}`;
  const { data, error } = await createSupabaseAdminClient().rpc("skie_admin_reissue_ticket", { p_actor_id: actor.id, p_ticket_id: ticketId, p_reason: reason, p_new_ticket_id: id, p_new_ticket_code: code, p_new_token_hash: createTicketTokenHash(tokenIdentity), p_new_token_preview: createTicketToken(tokenIdentity).slice(0,8), p_idempotency_key: operationId });
  if (error || !data) throw new PublicApiError("TICKET_REISSUE_FAILED", "The ticket could not be reissued.", 409);
  return data;
}

export async function reverseCheckIn(actor: SessionUser, ticketId: string, reasonInput: string, operationId: string) {
  const reason = assertReason(reasonInput);
  if (config.dataProvider !== "supabase") return mutateOperationsData((operations) => {
    const ticket = operations.tickets.find((item) => item.id === ticketId);
    if (!ticket || ticket.status !== "checked_in") throw new PublicApiError("CHECK_IN_NOT_REVERSIBLE", "This check-in cannot be reversed.", 409);
    const record = [...operations.checkIns].reverse().find((item) => item.ticketId === ticketId && item.result === "valid" && !item.reversedAt);
    if (!record) throw new PublicApiError("CHECK_IN_RECORD_NOT_FOUND", "The accepted scan record was not found.", 409);
    const now = new Date().toISOString(); record.reversedAt = now; record.reversedBy = actor.id; record.reversalReason = reason;
    ticket.status = "valid"; ticket.checkedInAt = undefined; ticket.checkedInBy = undefined;
    operations.auditLogs.push({ id: randomId("audit"), actorId: actor.id, actorEmail: actor.email, action: "check_in.reversed", entityType: "ticket", entityId: ticketId, metadata: { checkInId: record.id, reason, operationId }, createdAt: now }); return ticket;
  });
  const { data, error } = await createSupabaseAdminClient().rpc("skie_admin_reverse_check_in", { p_actor_id: actor.id, p_ticket_id: ticketId, p_reason: reason, p_idempotency_key: operationId });
  if (error || !data) throw new PublicApiError("CHECK_IN_REVERSAL_FAILED", "The check-in could not be reversed.", 409); return data;
}

export async function reverseEntitlementRedemption(actor: SessionUser, redemptionId: string, reasonInput: string, operationId: string) {
  const reason = assertReason(reasonInput);
  if (config.dataProvider !== "supabase") return mutateOperationsData((operations) => {
    const redemption = operations.entitlementRedemptions.find((item) => item.id === redemptionId);
    if (!redemption || redemption.reversedAt) throw new PublicApiError("REDEMPTION_NOT_REVERSIBLE", "This redemption cannot be reversed.", 409);
    const entitlement = operations.entitlements.find((item) => item.id === redemption.entitlementId);
    if (!entitlement) throw new PublicApiError("ENTITLEMENT_NOT_FOUND", "Entitlement was not found.", 404);
    const now = new Date().toISOString(); entitlement.quantityRemaining = Math.min(entitlement.quantityTotal, entitlement.quantityRemaining + redemption.quantity); if (entitlement.status === "redeemed") entitlement.status = "active";
    redemption.reversedAt = now; redemption.reversedBy = actor.id; redemption.reversalReason = reason;
    operations.auditLogs.push({ id: randomId("audit"), actorId: actor.id, actorEmail: actor.email, action: "entitlement_redemption.reversed", entityType: "entitlement", entityId: entitlement.id, metadata: { redemptionId, quantity: redemption.quantity, reason, operationId }, createdAt: now }); return entitlement;
  });
  const { data, error } = await createSupabaseAdminClient().rpc("skie_admin_reverse_entitlement_redemption", { p_actor_id: actor.id, p_redemption_id: redemptionId, p_reason: reason, p_idempotency_key: operationId });
  if (error || !data) throw new PublicApiError("REDEMPTION_REVERSAL_FAILED", "The redemption could not be reversed.", 409); return data;
}
