import { z } from "zod";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { requireUser } from "@/lib/security/session";
import { enqueueTicketNotificationsForOrder } from "@/lib/notifications/service";
import { auditNotificationAdminAction } from "@/lib/notifications/store";
import {
  duplicateEvent, listAdminConvenienceData, reissueTicket, reverseCheckIn,
  reverseEntitlementRedemption, saveAdminFilter, saveLaunchReadiness,
} from "@/lib/admin/recovery";

const operationId = z.string().regex(/^[A-Za-z0-9_-]{8,200}$/);
const reason = z.string().trim().min(3).max(500);
const safeFilterValue = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("duplicate_event"), eventId: z.string().min(1).max(120), operationId }).strict(),
  z.object({ action: z.literal("save_filter"), scope: z.enum(["applications", "ticketing", "notifications", "analytics"]), name: z.string().trim().min(1).max(80), filters: z.record(z.string().max(80), safeFilterValue) }).strict(),
  z.object({ action: z.literal("save_readiness"), eventId: z.string().min(1).max(120), checklist: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,79}$/), z.boolean()), lowStockThreshold: z.number().int().min(0).max(100000), capacityWarningPercent: z.number().int().min(1).max(100), operationId }).strict(),
  z.object({ action: z.literal("reissue_ticket"), ticketId: z.string().min(1).max(120), reason, operationId }).strict(),
  z.object({ action: z.literal("reverse_check_in"), ticketId: z.string().min(1).max(120), reason, operationId }).strict(),
  z.object({ action: z.literal("reverse_redemption"), redemptionId: z.string().min(1).max(120), reason, operationId }).strict(),
]);

export async function GET() {
  try {
    const actor = await requireUser(["admin", "super_admin"]);
    return noStoreJson(await listAdminConvenienceData(actor));
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["admin", "super_admin"]);
    const input = await parseJsonRequest(request, schema, 32_768);
    if (input.action === "duplicate_event") return noStoreJson({ event: await duplicateEvent(actor, input.eventId, input.operationId) }, 201);
    if (input.action === "save_filter") return noStoreJson({ savedFilter: await saveAdminFilter(actor, input.scope, input.name, input.filters) });
    if (input.action === "save_readiness") return noStoreJson({ readiness: await saveLaunchReadiness(actor, input) });
    if (input.action === "reissue_ticket") {
      const ticket = await reissueTicket(actor, input.ticketId, input.reason, input.operationId) as Record<string, unknown>;
      const orderId = typeof ticket.orderId === "string" ? ticket.orderId : typeof ticket.order_id === "string" ? ticket.order_id : undefined;
      let notificationQueued = false;
      if (orderId) try { const queued = await enqueueTicketNotificationsForOrder(orderId, "ticket_resend", actor.id); await auditNotificationAdminAction(actor, queued.queued.map((item) => item.id), "ticket_resend"); notificationQueued = queued.queued.length > 0; } catch { notificationQueued = false; }
      return noStoreJson({ ticket, notificationQueued }, 201);
    }
    if (input.action === "reverse_check_in") return noStoreJson({ ticket: await reverseCheckIn(actor, input.ticketId, input.reason, input.operationId) });
    return noStoreJson({ entitlement: await reverseEntitlementRedemption(actor, input.redemptionId, input.reason, input.operationId) });
  } catch (error) { return apiError(error); }
}
