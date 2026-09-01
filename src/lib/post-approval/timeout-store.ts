import "server-only";

import { config } from "@/lib/config";
import { PostCheckoutStoreError } from "@/lib/post-approval/store";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export type PostCheckoutTimeoutCandidate = {
  id: string;
};

function boundedLimit(limit: number) {
  return Math.max(1, Math.min(limit, 25));
}

function mapCandidates(rows: Array<{ id: string }> | null): PostCheckoutTimeoutCandidate[] {
  return (rows || []).map((row) => ({ id: String(row.id) }));
}

export async function listPostCheckoutCaptureSafetyTimeouts(limit = 25) {
  const cutoff = new Date(
    Date.now() + config.postCheckoutCaptureSafetyMinutes * 60_000,
  ).toISOString();
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select("id")
    .in("status", ["awaiting_form", "draft", "submitted", "under_review"])
    .eq("payment_status", "authorized")
    .not("capture_before", "is", null)
    .lte("capture_before", cutoff)
    .order("capture_before", { ascending: true })
    .limit(boundedLimit(limit));
  if (error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  return mapCandidates(data);
}

export async function listPostCheckoutReviewTimeouts(limit = 25) {
  const { data, error } = await createSupabaseAdminClient()
    .from("post_checkout_applications")
    .select("id")
    .in("status", ["submitted", "under_review"])
    .eq("payment_status", "authorized")
    .not("review_due_at", "is", null)
    .lte("review_due_at", new Date().toISOString())
    .order("review_due_at", { ascending: true })
    .limit(boundedLimit(limit));
  if (error) throw new PostCheckoutStoreError("POST_APPROVAL_STORE_UNAVAILABLE");
  return mapCandidates(data);
}
