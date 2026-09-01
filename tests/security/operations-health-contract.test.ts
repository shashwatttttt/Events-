import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("operations health contract", () => {
  it("keeps direct checkout available while post-checkout approval fails closed", () => {
    const route = source("src/app/api/health/commerce/route.ts");
    expect(route).toContain("direct: true");
    expect(route).toContain("postApproval: postApprovalReady");
    expect(route).toContain("const ready = schemaReady && automationHealthy");
  });

  it("checks unresolved fulfilment, orphan sessions, webhooks and lifecycle deadlines", () => {
    const migration = source("supabase/migrations/20260725000021_deep_operations_reliability.sql");
    expect(migration).toContain("paid_unfulfilled");
    expect(migration).toContain("orphan_session");
    expect(migration).toContain("stripe_webhook_events");
    expect(migration).toContain("overdue_post_checkout_lifecycle");
  });
});
