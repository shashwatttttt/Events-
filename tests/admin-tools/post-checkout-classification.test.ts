import { describe, expect, it } from "vitest";
import {
  canSupersedeQueuedFormTimeout,
  postCheckoutAdminBucket,
} from "@/lib/post-approval/admin-classification";
import type { PostCheckoutAdminItem } from "@/lib/post-approval/types";

function item(overrides: Partial<PostCheckoutAdminItem> = {}): PostCheckoutAdminItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    orderId: "00000000-0000-4000-8000-000000000002",
    reservationId: "00000000-0000-4000-8000-000000000003",
    checkoutAttemptId: "00000000-0000-4000-8000-000000000004",
    customerId: "00000000-0000-4000-8000-000000000005",
    eventId: "00000000-0000-4000-8000-000000000006",
    formId: "00000000-0000-4000-8000-000000000007",
    formVersion: 1,
    formSnapshot: { id: "form", name: "Form", intro: "", version: 1, fields: [] },
    draftAnswers: {},
    consentSnapshot: {},
    status: "awaiting_form",
    paymentStatus: "authorized",
    completionPercentage: 0,
    currency: "AUD",
    formDueAt: "2026-07-30T00:00:00.000Z",
    reminderCount: 0,
    lastActivityAt: "2026-07-27T00:00:00.000Z",
    overrideUsed: false,
    stateVersion: 1,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    customer: { firstName: "Test", lastName: "Customer", email: "test@example.com", phone: "", instagram: "" },
    event: { title: "HOUSE ARREST", slug: "house" },
    order: {
      status: "pending",
      workflowStatus: "post_checkout_authorized",
      subtotalCents: 1499,
      discountCents: 0,
      totalCents: 1499,
      pricingIntegrity: true,
      currency: "AUD",
      createdAt: "2026-07-27T00:00:00.000Z",
      items: [],
    },
    ...overrides,
  };
}

describe("post-checkout admin classification", () => {
  it("keeps approved captures in Active until capture and fulfilment finish", () => {
    const current = item({
      status: "approved",
      paymentStatus: "capture_requested",
      paymentAction: {
        id: "action",
        actionType: "capture",
        status: "requested",
        attemptCount: 0,
        availableAt: "2026-07-27T00:00:00.000Z",
      },
    });

    expect(postCheckoutAdminBucket(current)).toBe("active");
  });

  it("moves failed captures and captured-but-unfulfilled orders to Needs attention", () => {
    expect(postCheckoutAdminBucket(item({
      status: "approved",
      paymentStatus: "capture_requested",
      paymentAction: {
        id: "action",
        actionType: "capture",
        status: "manual_review",
        attemptCount: 5,
        availableAt: "2026-07-27T00:00:00.000Z",
      },
    }))).toBe("attention");

    expect(postCheckoutAdminBucket(item({
      status: "approved",
      paymentStatus: "captured",
      order: { ...item().order, status: "paid_unfulfilled" },
    }))).toBe("attention");
  });

  it("marks only captured-and-fulfilled approvals as Completed", () => {
    expect(postCheckoutAdminBucket(item({
      status: "approved_override",
      paymentStatus: "captured",
      order: { ...item().order, status: "fulfilled" },
    }))).toBe("completed");
  });

  it("keeps cancellation work active until Stripe cancellation is confirmed", () => {
    expect(postCheckoutAdminBucket(item({
      status: "rejected",
      paymentStatus: "cancel_requested",
      paymentAction: {
        id: "action",
        actionType: "cancel",
        status: "processing",
        attemptCount: 1,
        availableAt: "2026-07-27T00:00:00.000Z",
      },
    }))).toBe("active");

    expect(postCheckoutAdminBucket(item({
      status: "rejected",
      paymentStatus: "cancelled",
      order: { ...item().order, status: "cancelled" },
    }))).toBe("completed");
  });

  it("recognises only an unclaimed form-timeout cancellation as safely supersedable", () => {
    const queued = item({
      status: "form_expired",
      paymentStatus: "cancel_requested",
      paymentAction: {
        id: "action",
        actionType: "cancel",
        status: "requested",
        attemptCount: 0,
        availableAt: "2026-07-27T00:00:00.000Z",
      },
    });
    expect(canSupersedeQueuedFormTimeout(queued)).toBe(true);
    expect(canSupersedeQueuedFormTimeout({
      ...queued,
      paymentAction: { ...queued.paymentAction!, attemptCount: 1 },
    })).toBe(false);
  });
});
