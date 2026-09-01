export type AdminApplicationMetrics = {
  invitePendingReview: number;
  inviteTotal: number;
  postCheckoutPendingReview: number;
  postCheckoutTotal: number;
  pendingReviewTotal: number;
  applicationTotal: number;
  updatedAt: string;
};

export function buildAdminApplicationMetrics(input: {
  invitePendingReview: number;
  inviteTotal: number;
  postCheckoutPendingReview: number;
  postCheckoutTotal: number;
  updatedAt?: string;
}): AdminApplicationMetrics {
  const invitePendingReview = Math.max(0, Number(input.invitePendingReview || 0));
  const inviteTotal = Math.max(0, Number(input.inviteTotal || 0));
  const postCheckoutPendingReview = Math.max(0, Number(input.postCheckoutPendingReview || 0));
  const postCheckoutTotal = Math.max(0, Number(input.postCheckoutTotal || 0));

  return {
    invitePendingReview,
    inviteTotal,
    postCheckoutPendingReview,
    postCheckoutTotal,
    pendingReviewTotal: invitePendingReview + postCheckoutPendingReview,
    applicationTotal: inviteTotal + postCheckoutTotal,
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}
