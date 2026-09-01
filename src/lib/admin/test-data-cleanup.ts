import "server-only";

import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const SAFE_CODES = [
  "SUPER_ADMIN_REQUIRED",
  "REASON_REQUIRED",
  "TICKET_NOT_FOUND",
  "TICKET_CONFIRMATION_MISMATCH",
  "TEST_TICKET_HAS_ATTENDANCE_OR_REFUND",
  "TEST_TICKET_HAS_CHECK_IN_HISTORY",
  "TEST_TICKET_HAS_PROTECTED_PAYMENT",
  "TEST_TICKET_HAS_REDEMPTION_HISTORY",
  "TEST_TICKET_HAS_UNRESOLVED_RECOVERY",
  "CUSTOMER_NOT_FOUND",
  "CUSTOMER_ROLE_PROTECTED",
  "CUSTOMER_CONFIRMATION_MISMATCH",
  "CUSTOMER_HAS_STAFF_ACCESS",
  "CUSTOMER_OWNS_PROMO_CODE",
  "CUSTOMER_HAS_PROTECTED_PAYMENT",
  "CUSTOMER_HAS_CHECK_IN_HISTORY",
  "CUSTOMER_HAS_REDEMPTION_HISTORY",
  "CUSTOMER_HAS_PROTECTED_AUTHORIZATION",
  "CUSTOMER_HAS_UNRESOLVED_RECOVERY",
] as const;

function safeCleanupError(error: unknown, fallback: string) {
  const message = error && typeof error === "object" && "message" in error
    ? String((error as { message?: unknown }).message || "")
    : "";
  return SAFE_CODES.find((code) => message.includes(code)) || fallback;
}

export async function removeNormalizedTestTicket(input: {
  actorId: string;
  ticketId: string;
  reason: string;
  confirmation: string;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc("skie_admin_remove_test_ticket", {
    p_actor_id: input.actorId,
    p_ticket_id: input.ticketId,
    p_reason: input.reason,
    p_confirmation: input.confirmation,
    p_idempotency_key: `test-ticket-remove:${input.ticketId}:${randomUUID()}`,
  });
  if (error) throw new Error(safeCleanupError(error, "TEST_TICKET_REMOVE_FAILED"));
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("TEST_TICKET_REMOVE_FAILED");
  return {
    ticketId: String(row.ticket_id),
    deletedAt: String(row.deleted_at),
  };
}

export async function removeNormalizedTestCustomer(input: {
  actorId: string;
  customerId: string;
  reason: string;
  confirmation: string;
}) {
  const { data, error } = await createSupabaseAdminClient().rpc("skie_admin_remove_test_customer", {
    p_actor_id: input.actorId,
    p_customer_id: input.customerId,
    p_reason: input.reason,
    p_confirmation: input.confirmation,
    p_idempotency_key: `test-customer-remove:${input.customerId}:${randomUUID()}`,
  });
  if (error) throw new Error(safeCleanupError(error, "TEST_CUSTOMER_REMOVE_FAILED"));
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("TEST_CUSTOMER_REMOVE_FAILED");
  return {
    customerId: String(row.customer_id),
    deletedAt: String(row.deleted_at),
    hiddenTickets: Number(row.hidden_tickets || 0),
  };
}
