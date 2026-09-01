import "server-only";

import { buildAdminApplicationMetrics, type AdminApplicationMetrics } from "@/lib/admin/application-metric-values";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { OperationsData } from "@/types/site";

type PostCheckoutCountRow = {
  total_count?: number | string | null;
  pending_review_count?: number | string | null;
};

function firstCountRow(value: unknown): PostCheckoutCountRow {
  if (Array.isArray(value)) return (value[0] || {}) as PostCheckoutCountRow;
  return (value || {}) as PostCheckoutCountRow;
}

export async function readAdminApplicationMetrics(
  operations: OperationsData,
  includePostCheckout: boolean,
): Promise<AdminApplicationMetrics> {
  const invitePendingReview = operations.applications.filter((application) => application.status === "pending").length;
  const inviteTotal = operations.applications.length;

  if (!includePostCheckout) {
    return buildAdminApplicationMetrics({
      invitePendingReview,
      inviteTotal,
      postCheckoutPendingReview: 0,
      postCheckoutTotal: 0,
    });
  }

  const { data, error } = await createSupabaseAdminClient().rpc("skie_get_post_checkout_application_counts");
  if (error) throw new Error("ADMIN_APPLICATION_METRICS_UNAVAILABLE");
  const row = firstCountRow(data);

  return buildAdminApplicationMetrics({
    invitePendingReview,
    inviteTotal,
    postCheckoutPendingReview: Number(row.pending_review_count || 0),
    postCheckoutTotal: Number(row.total_count || 0),
  });
}
