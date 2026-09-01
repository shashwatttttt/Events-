import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function count(value: unknown) {
  const parsed = Number(value || 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("FULFILLED_WEBHOOK_RECONCILIATION_INVALID");
  }
  return parsed;
}

export async function reconcileFulfilledPostCheckoutWebhookHistory() {
  const { data, error } = await createSupabaseAdminClient().rpc(
    "skie_reconcile_fulfilled_post_checkout_webhook_history",
  );
  if (error) throw new Error("FULFILLED_WEBHOOK_RECONCILIATION_UNAVAILABLE");
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  if (!row) throw new Error("FULFILLED_WEBHOOK_RECONCILIATION_UNAVAILABLE");
  return {
    eventsCompleted: count(row.events_completed),
    replayActionsCompleted: count(row.replay_actions_completed),
  };
}
