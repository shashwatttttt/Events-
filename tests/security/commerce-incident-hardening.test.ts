import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("commerce incident hardening", () => {
  it("prevents fulfilled payment state from moving backwards", () => {
    const migration = source("supabase/migrations/20260805000041_fulfilment_recovery_hardening.sql");
    expect(migration).toContain("skie_preserve_fulfilled_reservation_state");
    expect(migration).toContain("skie_preserve_fulfilled_order_state");
    expect(migration).toContain("skie_preserve_fulfilled_checkout_attempt_state");
    expect(migration).toContain("old.status = 'fulfilled'");
    expect(migration).toContain("new.status := 'fulfilled'");
  });

  it("deduplicates guest-list payment, ticket, entitlement and allocation retries", () => {
    const migration = source("supabase/migrations/20260805000041_fulfilment_recovery_hardening.sql");
    expect(migration).toContain("skie_ignore_duplicate_offline_payment");
    expect(migration).toContain("new.provider in ('free','test')");
    expect(migration).toContain("skie_ignore_complete_ticket_retry");
    expect(migration).toContain("v_existing >= v_expected");
    expect(migration).toContain("skie_ignore_duplicate_entitlement_retry");
    expect(migration).toContain("skie_prevent_allocation_double_increment");
  });

  it("repairs complete paid orders and closes their stale recovery records", () => {
    const migration = source("supabase/migrations/20260805000041_fulfilment_recovery_hardening.sql");
    expect(migration).toContain("skie_fulfilment_repair_orders");
    expect(migration).toContain("set status = 'fulfilled'");
    expect(migration).toContain("set status = 'processed'");
    expect(migration).toContain("set status = 'completed'");
    expect(migration).toContain("FULFILMENT_RETRY_REQUIRED");
  });

  it("does not endlessly replay deterministic fulfilment failures", () => {
    const processor = source("src/lib/payments/webhook-processor.ts");
    expect(processor).toContain('"FULFILMENT_FAILED"');
    expect(processor).toContain('"TICKET_FULFILMENT_INCOMPLETE"');
    expect(processor).toContain("MANUAL_REVIEW_CODES.has(candidate)");
  });

  it("bounds Stripe and Twilio callback request bodies", () => {
    const stripe = source("src/app/api/stripe/webhook/route.ts");
    const twilio = source("src/app/api/webhooks/twilio/status/route.ts");
    expect(stripe).toContain("STRIPE_WEBHOOK_MAX_BYTES");
    expect(stripe).toContain("request.arrayBuffer()");
    expect(stripe).toContain("WEBHOOK_PAYLOAD_TOO_LARGE");
    expect(twilio).toContain("TWILIO_CALLBACK_MAX_BYTES");
    expect(twilio).toContain("request.arrayBuffer()");
    expect(twilio).toContain('contentType !== "application/x-www-form-urlencoded"');
  });

  it("publishes CSP and HSTS security headers", () => {
    const config = source("next.config.ts");
    expect(config).toContain("Content-Security-Policy");
    expect(config).toContain("Strict-Transport-Security");
    expect(config).toContain("frame-ancestors 'none'");
    expect(config).toContain("object-src 'none'");
    expect(config).toContain("dangerouslyAllowSVG: false");
  });
});
