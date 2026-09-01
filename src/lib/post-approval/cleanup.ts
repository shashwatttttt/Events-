import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function failPostCheckoutInitialization(orderId: string, failureCode: string) {
  const { error } = await createSupabaseAdminClient().rpc("skie_fail_post_checkout_initialization", {
    p_order_id: orderId,
    p_failure_code: failureCode.slice(0, 120),
  });
  if (error) throw new Error("POST_APPROVAL_CLEANUP_FAILED");
}

export async function restartUnpaidPostCheckout(orderId: string, failureCode: string) {
  const { error } = await createSupabaseAdminClient().rpc("skie_restart_unpaid_post_checkout", {
    p_order_id: orderId,
    p_failure_code: failureCode.slice(0, 120),
  });
  if (error) throw new Error("POST_APPROVAL_RESTART_CLEANUP_FAILED");
}
