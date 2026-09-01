import "server-only";

import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { TicketStatus } from "@/types/site";

export async function setNormalizedAdminTicketStatus(input: {
  actorId: string;
  ticketId: string;
  status: Extract<TicketStatus, "valid" | "cancelled" | "entry_refused">;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc("skie_admin_set_ticket_status", {
    p_actor_id: input.actorId,
    p_ticket_id: input.ticketId,
    p_status: input.status,
    p_idempotency_key: `ticket-status:${input.ticketId}:${input.status}:${randomUUID()}`,
  });
  if (error) {
    const message = String(error.message || "");
    const safe = [
      "TICKET_NOT_FOUND",
      "TICKET_REFUNDED",
      "CHECK_IN_REVERSAL_REQUIRED",
      "TICKET_STATUS_INVALID",
      "ADMIN_REQUIRED",
    ].find((code) => message.includes(code));
    throw new Error(safe || "TICKET_STATUS_UPDATE_FAILED");
  }
  return data;
}
