import { describe, expect, it } from "vitest";
import { normalizeMetaEmail, normalizeMetaPhone } from "@/lib/meta/conversions";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Meta ads privacy and lifecycle boundaries", () => {
  it("normalizes matching data before SHA-256 hashing", () => {
    expect(normalizeMetaEmail("  Person@Example.COM ")).toBe("person@example.com");
    expect(normalizeMetaPhone("0412 345 678")).toBe("61412345678");
    expect(normalizeMetaPhone("+61 412 345 678")).toBe("61412345678");
  });

  it("never includes application answers or raw contact details in the durable ledger", () => {
    const migration = source("supabase/migrations/20260730000038_meta_ads_tracking.sql");
    expect(migration).not.toContain("submitted_answers");
    expect(migration).not.toContain("draft_answers");
    expect(migration).not.toContain("email text");
    expect(migration).not.toContain("phone text");
    expect(migration).toContain("meta_conversion_no_sensitive_metadata");
    expect(migration).toContain("Advertising measurement and Meta Business Tools");
  });

  it("loads the browser Pixel only after current-version advertising consent", () => {
    const tracking = source("src/components/MetaTracking.tsx");
    const browser = source("src/lib/meta/browser.ts");
    const requestContext = source("src/lib/meta/request-context.ts");
    expect(tracking).toContain('choice !== "granted"');
    expect(browser).toContain("advertisingConsentCookieGranted(consentVersion)");
    expect(requestContext).toContain("granted.${config.metaAdsConsentVersion}");
    expect(browser).toContain("connect.facebook.net/en_US/fbevents.js");
    expect(browser).toContain('fbq("set", "autoConfig", false');
  });

  it("creates Meta purchases only after fulfilment completes", () => {
    const webhook = source("src/lib/payments/webhook-processor.ts");
    const normalFulfilment = webhook.indexOf("await fulfillStripeOrder");
    const normalPurchase = webhook.indexOf("await queueMetaPurchaseForOrder", normalFulfilment);
    const postFulfilment = webhook.indexOf("await handlePostCheckoutPaymentSucceeded");
    const postPurchase = webhook.indexOf("await queueMetaPurchaseForOrder", postFulfilment);
    expect(normalFulfilment).toBeGreaterThan(-1);
    expect(normalPurchase).toBeGreaterThan(normalFulfilment);
    expect(postFulfilment).toBeGreaterThan(-1);
    expect(postPurchase).toBeGreaterThan(postFulfilment);
  });

  it("requires a consented checkout record before a server Purchase is queued", () => {
    const conversions = source("src/lib/meta/conversions.ts");
    expect(conversions).toContain('.eq("event_name", "InitiateCheckout")');
    expect(conversions).toContain("if (!attribution.data)");
    expect(conversions).toContain("fulfilmentVerified: true");
  });
});
