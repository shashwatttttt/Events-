import type { PostCheckoutAdminItem } from "@/lib/post-approval/types";

const ACTIVE_PAYMENT_ACTIONS = new Set(["requested", "processing", "retry"]);
const ATTENTION_PAYMENT_ACTIONS = new Set(["failed", "manual_review"]);
const TERMINAL_APPLICATIONS = new Set(["rejected", "form_expired", "authorization_expired", "withdrawn"]);

export type PostCheckoutAdminBucket = "active" | "attention" | "completed";

export function canSupersedeQueuedFormTimeout(item: PostCheckoutAdminItem) {
  return item.status === "form_expired"
    && item.paymentStatus === "cancel_requested"
    && item.paymentAction?.actionType === "cancel"
    && item.paymentAction.status === "requested"
    && item.paymentAction.attemptCount === 0;
}

export function hasActivePaymentAction(item: PostCheckoutAdminItem) {
  return Boolean(item.paymentAction && ACTIVE_PAYMENT_ACTIONS.has(item.paymentAction.status));
}

export function postCheckoutNeedsAttention(item: PostCheckoutAdminItem) {
  if (!item.order.pricingIntegrity) return true;
  if (item.status === "manual_review") return true;
  if (["failed", "reconciliation_required"].includes(item.paymentStatus)) return true;
  if (item.paymentAction && ATTENTION_PAYMENT_ACTIONS.has(item.paymentAction.status)) return true;
  if (item.paymentStatus === "captured" && item.order.status !== "fulfilled") return true;
  if (["approved", "approved_override"].includes(item.status)
    && item.paymentStatus === "not_required"
    && item.order.status !== "fulfilled") return true;
  if (["approved", "approved_override"].includes(item.status)
    && !["captured", "not_required"].includes(item.paymentStatus)
    && !hasActivePaymentAction(item)) return true;
  if (TERMINAL_APPLICATIONS.has(item.status)
    && !["cancelled", "expired"].includes(item.paymentStatus)
    && !hasActivePaymentAction(item)
    && !canSupersedeQueuedFormTimeout(item)) return true;
  return false;
}

export function postCheckoutCompleted(item: PostCheckoutAdminItem) {
  const fulfilledApproval = ["approved", "approved_override"].includes(item.status)
    && ["captured", "not_required"].includes(item.paymentStatus)
    && item.order.status === "fulfilled";
  const confirmedCancellation = TERMINAL_APPLICATIONS.has(item.status)
    && ["cancelled", "expired"].includes(item.paymentStatus);
  return fulfilledApproval || confirmedCancellation;
}

export function postCheckoutAdminBucket(item: PostCheckoutAdminItem): PostCheckoutAdminBucket {
  if (postCheckoutNeedsAttention(item)) return "attention";
  if (postCheckoutCompleted(item)) return "completed";
  return "active";
}
