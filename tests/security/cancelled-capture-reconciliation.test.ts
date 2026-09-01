import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const worker = readFileSync(join(process.cwd(), "src/lib/post-approval/worker.ts"), "utf8");

describe("cancelled payment action reconciliation", () => {
  it("never sends a Stripe capture request after Stripe reports cancellation", () => {
    expect(worker).toContain('if (current.status === "canceled")');
    expect(worker).toContain("await finaliseCancelledCapture(current.id, reason)");
    expect(worker).toContain("markPostCheckoutCancelled");
    expect(worker).toContain('current.status === "requires_capture"');
  });

  it("uses durable application state without letting optional notification reads block finalisation", () => {
    expect(worker).toContain("cancellationReasonForApplication");
    expect(worker).toContain('if (error) return "rejected"');
    expect(worker).toContain("sendCancellationNotificationBestEffort");
    expect(worker).toContain(".catch(() => undefined)");
    expect(worker).toContain("POST_APPROVAL_CANCEL_FINALIZATION_FAILED");
  });

  it("requeues every action type only after Stripe confirms terminal cancellation", () => {
    expect(worker).toContain("requeueCancelledManualReviewActions");
    expect(worker).toContain('.eq("status", "manual_review")');
    expect(worker).toContain('.in("action_type", ["capture", "cancel", "reconcile"])');
    expect(worker).toContain('current.status !== "canceled"');
    expect(worker).toContain('safe_error_code: "POST_APPROVAL_TERMINAL_RECONCILIATION"');
  });

  it("directly finalises ordinary cancel actions before best-effort notification", () => {
    expect(worker).toContain("await finaliseCancelledCapture(result.id, reason)");
    expect(worker).toContain("await sendCancellationNotificationBestEffort(result as Stripe.PaymentIntent, reason)");
  });

  it("still fulfils only PaymentIntents Stripe reports as succeeded", () => {
    expect(worker).toContain('if (result.status !== "succeeded")');
    expect(worker).toContain("handlePostCheckoutPaymentSucceeded");
  });
});
