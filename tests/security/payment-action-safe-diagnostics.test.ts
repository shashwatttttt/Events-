import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const worker = readFileSync(join(process.cwd(), "src/lib/post-approval/worker.ts"), "utf8");

describe("payment action safe diagnostics", () => {
  it("returns only bounded uppercase safe error codes", () => {
    expect(worker).toContain("safePaymentActionErrorCode");
    expect(worker).toContain("appendSafePaymentActionErrorCode");
    expect(worker).toContain("/^[A-Z0-9_]{3,120}$/");
    expect(worker).toContain("POST_APPROVAL_PAYMENT_ACTION_FAILED");
  });

  it("does not expose payment, order, application, or Stripe identifiers", () => {
    expect(worker).toContain("paymentActionErrorCodes");
    expect(worker).toContain("appendSafePaymentActionErrorCode(result.paymentActionErrorCodes, processed.errorCode)");
    expect(worker).toContain('.select("safe_error_code")');
    expect(worker).not.toContain("paymentActionFailures.push(action)");
    expect(worker).not.toContain("paymentActionErrorCodes.push(action.paymentIntentId)");
  });
});
