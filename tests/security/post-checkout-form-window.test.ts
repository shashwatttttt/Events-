import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("post-checkout form timing", () => {
  it("uses a long actual form window and a short customer target", () => {
    const config = source("src/lib/config.ts");
    const types = source("src/lib/post-approval/types.ts");
    const client = source("src/components/PostCheckoutApplicationClient.tsx");
    const admin = source("src/components/admin/PostCheckoutApplicationsPanel.tsx");

    expect(config).toContain('POST_CHECKOUT_ACTUAL_FORM_HOURS", 5 * 24');
    expect(config).toContain("postCheckoutFormMinutes: actualFormHours * 60");
    expect(config).toContain("postCheckoutCustomerUrgencyMinutes");
    expect(types).toContain("customerFormTargetAt");
    expect(types).toContain("Math.min(formDueAt, captureBefore, urgencyAt)");
    expect(client).toContain("Complete by:");
    expect(client).toContain("may remain available after the completion target");
    expect(admin).toContain("Customer target");
    expect(admin).toContain("Actual form availability");
    expect(admin).toContain("Stripe capture deadline");
  });

  it("keeps approve-without-form tied to authorised payment state", () => {
    const admin = source("src/components/admin/PostCheckoutApplicationsPanel.tsx");
    const service = source("src/lib/post-approval/service.ts");

    expect(admin).toContain('item.paymentStatus === "authorized"');
    expect(admin).toContain("Approve without form");
    expect(admin).toContain("while the card authorisation is safely capturable");
    expect(service).toContain("config.postCheckoutCaptureSafetyMinutes");
    expect(service).toContain("This payment authorisation is too close to expiry");
  });
});
