import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/20260727000026_post_checkout_override_provider_safety.sql"), "utf8");
const panel = readFileSync(join(process.cwd(), "src/components/admin/PostCheckoutApplicationsPanel.tsx"), "utf8");
const classification = readFileSync(join(process.cwd(), "src/lib/post-approval/admin-classification.ts"), "utf8");
const route = readFileSync(join(process.cwd(), "src/app/api/admin/post-checkout/route.ts"), "utf8");

describe("approve-without-form timeout recovery", () => {
  it("supersedes only a pristine automatic form-timeout cancellation", () => {
    expect(migration).toContain("v_application.status = 'form_expired'");
    expect(migration).toContain("v_application.payment_status = 'cancel_requested'");
    expect(migration).toContain("v_timeout_action.status <> 'requested'");
    expect(migration).toContain("v_timeout_action.attempt_count <> 0");
    expect(migration).toContain("POST_APPROVAL_TIMEOUT_SUPERSEDED_BY_ADMIN");
    expect(migration).not.toContain("action.status in ('requested','retry')");
  });

  it("retains capture-window safety checks", () => {
    expect(migration).toContain("POST_APPROVAL_CAPTURE_DEADLINE_MISSING");
    expect(migration).toContain("POST_APPROVAL_AUTHORIZATION_TOO_CLOSE_TO_EXPIRY");
    expect(migration).toContain("v_application.capture_before <= now() + interval '60 minutes'");
  });

  it("shows an override only before a cancellation attempt", () => {
    expect(panel).toContain("canSupersedeQueuedFormTimeout");
    expect(classification).toContain('item.paymentAction.status === "requested"');
    expect(classification).toContain("item.paymentAction.attemptCount === 0");
    expect(panel).toContain("Stripe cancellation is still queued and has not started");
    expect(panel).toContain("await load();");
  });

  it("returns actionable admin errors", () => {
    expect(route).toContain("POST_APPROVAL_OVERRIDE_NOT_ALLOWED");
    expect(route).toContain("automatic cancellation has already started");
    expect(route).toContain("POST_APPROVAL_PAYMENT_NOT_AUTHORIZED");
    expect(route).toContain("POST_APPROVAL_AUTHORIZATION_TOO_CLOSE_TO_EXPIRY");
  });
});
