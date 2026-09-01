import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("post-checkout authorization currency normalization", () => {
  it("normalizes the Stripe currency before return-page reconciliation", () => {
    const statusSource = source("src/lib/post-approval/status.ts");

    expect(statusSource).toContain("paymentIntent.currency.trim().toUpperCase()");
    expect(statusSource).toContain("recordPostCheckoutAuthorization({");
  });

  it("normalizes and validates currency inside the durable database transition", () => {
    const migration = source(
      "supabase/migrations/20260724000014_post_checkout_authorization_currency.sql",
    );

    expect(migration).toContain("v_currency text := upper(trim(coalesce(p_currency,'')))");
    expect(migration).toContain("currency = v_currency");
    expect(migration).toContain("POST_APPROVAL_CURRENCY_INVALID");
    expect(migration).toContain("to service_role");
  });
});
