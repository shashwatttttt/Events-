import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { PostCheckoutStoreError } from "@/lib/post-approval/store";

export type ClaimedPostCheckoutPaymentAction = {
  id: string;
  applicationId: string;
  orderId: string;
  decisionId?: string;
  paymentIntentId: string;
  actionType: "capture" | "cancel" | "reconcile";
  status: string;
  idempotencyKey: string;
  attemptCount: number;
  requestedBy?: string;
};

type RawPaymentAction = Record<string, unknown>;

const PAYMENT_ACTION_COLUMNS = [
  "id",
  "application_id",
  "order_id",
  "decision_id",
  "stripe_payment_intent_id",
  "action_type",
  "status",
  "idempotency_key",
  "attempt_count",
  "available_at",
  "requested_by",
  "created_at",
  "lease_expires_at",
  "updated_at",
].join(",");

function mapClaimedAction(row: RawPaymentAction): ClaimedPostCheckoutPaymentAction {
  return {
    id: String(row.id),
    applicationId: String(row.application_id),
    orderId: String(row.order_id),
    decisionId: row.decision_id ? String(row.decision_id) : undefined,
    paymentIntentId: String(row.stripe_payment_intent_id),
    actionType: String(row.action_type) as ClaimedPostCheckoutPaymentAction["actionType"],
    status: String(row.status),
    idempotencyKey: String(row.idempotency_key),
    attemptCount: Number(row.attempt_count || 0),
    requestedBy: row.requested_by ? String(row.requested_by) : undefined,
  };
}

async function claimCandidate(
  candidate: RawPaymentAction,
  workerId: string,
): Promise<ClaimedPostCheckoutPaymentAction | null> {
  const client = createSupabaseAdminClient();
  const now = new Date();
  const status = String(candidate.status);
  const attemptCount = Number(candidate.attempt_count || 0);
  const missingLeaseBefore = new Date(now.getTime() - 2 * 60_000).toISOString();

  let query = client
    .from("post_checkout_payment_actions")
    .update({
      status: "processing",
      lease_owner: workerId,
      lease_expires_at: new Date(now.getTime() + 60_000).toISOString(),
      attempt_count: attemptCount + 1,
      last_attempt_at: now.toISOString(),
      safe_error_code: null,
    })
    .eq("id", String(candidate.id))
    .eq("status", status)
    .eq("attempt_count", attemptCount);

  if (status === "retry") {
    query = query.lte("available_at", now.toISOString());
  } else if (status === "processing") {
    query = candidate.lease_expires_at
      ? query.lte("lease_expires_at", now.toISOString())
      : query.is("lease_expires_at", null).lte("updated_at", missingLeaseBefore);
  } else if (status !== "requested") {
    return null;
  }

  const { data, error } = await query
    .select(PAYMENT_ACTION_COLUMNS)
    .maybeSingle();

  if (error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  return data ? mapClaimedAction(data as unknown as RawPaymentAction) : null;
}

async function fallbackClaimPostCheckoutPaymentActions(
  workerId: string,
  limit: number,
  excludedIds: Set<string>,
) {
  if (limit <= 0) return [];

  const client = createSupabaseAdminClient();
  const now = new Date();
  const staleRequestedBefore = new Date(now.getTime() - 2 * 60_000).toISOString();
  const missingLeaseBefore = staleRequestedBefore;
  const bounded = Math.max(1, Math.min(limit, 25));

  const [requested, retries, expiredLeases, missingLeases] = await Promise.all([
    client
      .from("post_checkout_payment_actions")
      .select(PAYMENT_ACTION_COLUMNS)
      .eq("status", "requested")
      .lte("created_at", staleRequestedBefore)
      .order("created_at", { ascending: true })
      .limit(bounded),
    client
      .from("post_checkout_payment_actions")
      .select(PAYMENT_ACTION_COLUMNS)
      .eq("status", "retry")
      .lte("available_at", now.toISOString())
      .order("created_at", { ascending: true })
      .limit(bounded),
    client
      .from("post_checkout_payment_actions")
      .select(PAYMENT_ACTION_COLUMNS)
      .eq("status", "processing")
      .lte("lease_expires_at", now.toISOString())
      .order("created_at", { ascending: true })
      .limit(bounded),
    client
      .from("post_checkout_payment_actions")
      .select(PAYMENT_ACTION_COLUMNS)
      .eq("status", "processing")
      .is("lease_expires_at", null)
      .lte("updated_at", missingLeaseBefore)
      .order("created_at", { ascending: true })
      .limit(bounded),
  ]);

  if (requested.error || retries.error || expiredLeases.error || missingLeases.error) {
    throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  }

  const candidates = [
    ...((requested.data || []) as unknown as RawPaymentAction[]),
    ...((retries.data || []) as unknown as RawPaymentAction[]),
    ...((expiredLeases.data || []) as unknown as RawPaymentAction[]),
    ...((missingLeases.data || []) as unknown as RawPaymentAction[]),
  ]
    .filter((row, index, rows) => {
      const id = String(row.id);
      return !excludedIds.has(id) && rows.findIndex((item) => String(item.id) === id) === index;
    })
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));

  const claimed: ClaimedPostCheckoutPaymentAction[] = [];
  for (const candidate of candidates) {
    if (claimed.length >= bounded) break;
    const action = await claimCandidate(candidate, workerId);
    if (action) claimed.push(action);
  }
  return claimed;
}

export type PostCheckoutTimeoutReason =
  | "form_expired"
  | "review_expired"
  | "authorization_expired";

export async function claimPostCheckoutPaymentActions(workerId: string, limit = 10) {
  const bounded = Math.max(1, Math.min(limit, 25));
  const { data, error } = await createSupabaseAdminClient().rpc("skie_claim_post_checkout_payment_actions", {
    p_worker_id: workerId,
    p_limit: bounded,
    p_lease_seconds: 60,
  });

  const rpcClaimed: ClaimedPostCheckoutPaymentAction[] = error
    ? []
    : (data || []).map((row: RawPaymentAction) => mapClaimedAction(row));

  if (rpcClaimed.length >= bounded) return rpcClaimed;

  try {
    const fallback = await fallbackClaimPostCheckoutPaymentActions(
      workerId,
      bounded - rpcClaimed.length,
      new Set(rpcClaimed.map((action: ClaimedPostCheckoutPaymentAction) => action.id)),
    );
    return [...rpcClaimed, ...fallback];
  } catch (fallbackError) {
    if (error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
    throw fallbackError;
  }
}

export async function claimPostCheckoutPaymentActionById(actionId: string, workerId: string) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_payment_actions")
    .select(PAYMENT_ACTION_COLUMNS)
    .eq("id", actionId)
    .maybeSingle();
  if (error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  if (!data) return null;
  return claimCandidate(data as unknown as RawPaymentAction, workerId);
}

export async function requestPostCheckoutTimeout(
  applicationId: string,
  reason: PostCheckoutTimeoutReason,
  idempotencyKey: string,
  captureSafetyMinutes: number,
) {
  const { data, error } = await createSupabaseAdminClient().rpc("skie_request_post_checkout_timeout", {
    p_application_id: applicationId,
    p_reason: reason,
    p_idempotency_key: idempotencyKey,
    p_capture_safety_minutes: Math.max(30, Math.min(captureSafetyMinutes, 24 * 60)),
  });
  if (error) {
    const message = String(error.message || "");
    if (
      message.includes("POST_APPROVAL_TIMEOUT_NOT_DUE")
      || message.includes("POST_APPROVAL_TIMEOUT_NOT_ALLOWED")
      || message.includes("POST_APPROVAL_PAYMENT_NOT_AUTHORIZED")
    ) {
      return null;
    }
    throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  }
  const row = Array.isArray(data) ? data[0] : data;
  return row ? { actionId: String(row.action_id), paymentIntentId: String(row.payment_intent_id) } : null;
}

export async function requestPostCheckoutExpiry(applicationId: string, idempotencyKey: string) {
  return requestPostCheckoutTimeout(applicationId, "form_expired", idempotencyKey, 60);
}
