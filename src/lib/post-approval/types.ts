export const POST_CHECKOUT_MODE = "post_checkout_approval" as const;
export const DEFAULT_POST_CHECKOUT_CUSTOMER_URGENCY_MINUTES = 60;

export type PostCheckoutApplicationStatus =
  | "awaiting_authorization"
  | "awaiting_form"
  | "draft"
  | "submitted"
  | "under_review"
  | "capture_pending"
  | "approved"
  | "approved_override"
  | "rejection_pending"
  | "rejected"
  | "form_expired"
  | "authorization_expired"
  | "withdrawn"
  | "manual_review";

export type PostCheckoutPaymentStatus =
  | "authorization_pending"
  | "authorized"
  | "not_required"
  | "capture_requested"
  | "captured"
  | "cancel_requested"
  | "cancelled"
  | "expired"
  | "failed"
  | "reconciliation_required";

export type PostCheckoutApplication = {
  id: string;
  orderId: string;
  reservationId: string;
  checkoutAttemptId: string;
  customerId: string;
  eventId: string;
  formId: string;
  formVersion: number;
  formSnapshot: PostCheckoutFormSnapshot;
  draftAnswers: Record<string, string | boolean | number>;
  submittedAnswers?: Record<string, string | boolean | number>;
  consentSnapshot: Record<string, unknown>;
  status: PostCheckoutApplicationStatus;
  paymentStatus: PostCheckoutPaymentStatus;
  completionPercentage: number;
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  authorizedAmountCents?: number;
  capturableAmountCents?: number;
  currency: string;
  formDueAt: string;
  reviewDueAt?: string;
  captureBefore?: string;
  nextReminderAt?: string;
  reminderCount: number;
  lastReminderAt?: string;
  lastActivityAt: string;
  submittedAt?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  overrideUsed: boolean;
  overrideReason?: string;
  failureCode?: string;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
};

export function customerFormTargetAt(
  application: Pick<PostCheckoutApplication, "createdAt" | "formDueAt" | "captureBefore">,
  urgencyMinutes = DEFAULT_POST_CHECKOUT_CUSTOMER_URGENCY_MINUTES,
) {
  const createdAt = new Date(application.createdAt).getTime();
  const formDueAt = new Date(application.formDueAt).getTime();
  const captureBefore = application.captureBefore ? new Date(application.captureBefore).getTime() : Number.POSITIVE_INFINITY;
  const urgencyAt = createdAt + Math.max(15, urgencyMinutes) * 60_000;
  const target = Math.min(formDueAt, captureBefore, urgencyAt);
  return new Date(Number.isFinite(target) ? target : formDueAt).toISOString();
}

export type PostCheckoutFormFieldSnapshot = {
  id: string;
  key: string;
  label: string;
  type: "text" | "email" | "phone" | "textarea" | "select" | "radio" | "checkbox";
  required: boolean;
  placeholder: string;
  options: string[];
  maxLength?: number;
};

export type PostCheckoutFormSnapshot = {
  id: string;
  name: string;
  intro: string;
  version: number;
  fields: PostCheckoutFormFieldSnapshot[];
};

export type PostCheckoutAdminItem = PostCheckoutApplication & {
  customer: { firstName: string; lastName: string; email: string; phone: string; instagram: string };
  event: { title: string; slug: string };
  order: {
    status: string;
    workflowStatus: string;
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
    pricingIntegrity: boolean;
    currency: string;
    createdAt: string;
    items: Array<{ kind: string; referenceId: string; name: string; quantity: number; unitPriceCents: number }>;
  };
  promo?: {
    id: string;
    code: string;
    internalName: string;
    discountType: "percentage" | "fixed" | "tracking" | "guestlist";
    trackingOnly: boolean;
    guestlistApplication?: boolean;
  };
  decision?: {
    id: string;
    decision: string;
    internalReason: string;
    customerMessage?: string;
    actorId: string;
    createdAt: string;
  };
  paymentAction?: {
    id: string;
    actionType: "capture" | "cancel" | "reconcile";
    status: string;
    attemptCount: number;
    safeErrorCode?: string;
    availableAt: string;
    lastAttemptAt?: string;
  };
};

export type PostCheckoutDecision = "approve" | "approve_without_form" | "reject" | "withdraw";

export type PostCheckoutDecisionResult = {
  decisionId: string;
  actionId?: string;
  actionType: "capture" | "cancel" | "fulfil" | "release";
  paymentIntentId?: string;
  guestlistApplication?: boolean;
};

export type PostCheckoutWorkerResult = {
  remindersQueued: number;
  expiriesRequested: number;
  formExpiriesRequested: number;
  reviewExpiriesRequested: number;
  authorizationExpiriesRequested: number;
  paymentActionsProcessed: number;
  paymentActionsFailed: number;
};
