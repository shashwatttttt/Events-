import { z } from "zod";
import { apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { verifyTicket } from "@/lib/operations";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";

const schema = z.object({
  ticketId: z.string().min(1).max(100),
  token: z.string().min(16).max(500),
  eventId: z.string().min(1).max(100).optional(),
}).strict();

export async function POST(request: Request) {
  try {
    await enforceRateLimit(requestKey(request, "ticket-verify"), 60, 60_000);
    const { ticketId, token, eventId } = await parseJsonRequest(request, schema, 2_048);
    const verification = await verifyTicket(ticketId, token, eventId);
    return noStoreJson({
      result: verification.result,
      ticket: verification.ticket
        ? {
            id: verification.ticket.id,
            eventId: verification.ticket.eventId,
            ticketCode: verification.ticket.ticketCode,
            holderName: verification.ticket.holderName,
            status: verification.ticket.status,
            checkedInAt: verification.ticket.checkedInAt,
          }
        : null,
    });
  } catch (error) {
    return apiError(error);
  }
}
