import { z } from "zod";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import {
  checkInTicket,
  getDoorEntitlements,
  manualCheckInTicket,
  searchDoorTickets,
} from "@/lib/operations";
import { requireUser } from "@/lib/security/session";
import { captureAnalyticsSafely } from "@/lib/analytics/store";

const roles = ["scanner_only", "door_staff", "admin", "super_admin"] as const;
const querySchema = z.object({ q: z.string().trim().min(2).max(120), eventId: z.string().min(1).max(100) }).strict();
const checkInSchema = z.object({
  ticketId: z.string().min(1).max(100),
  token: z.string().max(500).optional(),
  eventId: z.string().min(1).max(100),
  notes: z.string().max(1_000).optional(),
  manual: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (!value.manual && !value.token) context.addIssue({ code: "custom", message: "A ticket token is required.", path: ["token"] });
});

function safeResult(
  result: Awaited<ReturnType<typeof checkInTicket>>,
  entitlements: Array<{ id: string; name: string; quantityRemaining: number; status: string }>,
) {
  return {
    result: result.result,
    ticket: result.ticket && !["wrong_event", "invalid"].includes(result.result)
      ? {
          id: result.ticket.id,
          eventId: result.ticket.eventId,
          holderName: result.ticket.holderName,
          ticketCode: result.ticket.ticketCode,
          status: result.ticket.status,
          checkedInAt: result.ticket.checkedInAt,
        }
      : null,
    entitlements,
    record: result.record,
  };
}

export async function GET(request: Request) {
  try {
    const actor = await requireUser([...roles]);
    const url = new URL(request.url);
    const { q: query, eventId } = querySchema.parse(Object.fromEntries(url.searchParams));
    return noStoreJson({ tickets: await searchDoorTickets(query, eventId, actor) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser([...roles]);
    const body = await parseJsonRequest(request, checkInSchema, 4_096);

    const result = body.manual
      ? await manualCheckInTicket({
          ticketId: body.ticketId,
          eventId: body.eventId,
          actor,
          notes: body.notes,
        })
      : await checkInTicket({
          ticketId: body.ticketId,
          token: body.token || "",
          eventId: body.eventId,
          actor,
          notes: body.notes,
        });

    const canViewEntitlements = ["door_staff", "admin", "super_admin"].includes(actor.role);
    const entitlements = canViewEntitlements && result.ticket?.orderId && result.ticket.eventId === body.eventId
      ? await getDoorEntitlements(result.ticket.orderId, body.eventId, actor)
      : [];

    const analyticsName=result.result==="valid"?"ticket_scan_accepted":result.result==="already_checked_in"?"ticket_scan_duplicate":"ticket_scan_rejected";
    await captureAnalyticsSafely({eventName:analyticsName,source:"server",deduplicationKey:`${analyticsName}:${result.record?.id||`${body.ticketId}:${Date.now()}`}`,eventId:body.eventId,quantity:1,occurredAt:result.record?.scannedAt||new Date().toISOString(),safeMetadata:{result:result.result}});

    return noStoreJson(safeResult(result, entitlements));
  } catch (error) {
    return apiError(error);
  }
}
