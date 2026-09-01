import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("promo admin and usage hardening", () => {
  it("preserves the original creator when a promo is edited", () => {
    const service = source("src/lib/promos/service.ts");
    expect(service).toContain('client.from("promo_codes").update(mutableRecord).eq("id", input.id)');
    expect(service).toContain('client.from("promo_codes").insert({ ...mutableRecord, created_by: actor.id })');
    expect(service).not.toContain('status: input.status, created_by: actor.id');
  });

  it("uses aggregate usage with a complete paged fallback", () => {
    const service = source("src/lib/promos/service.ts");
    const migration = source("supabase/migrations/20260727000029_promo_usage_aggregates.sql");
    expect(service).toContain('rpc("skie_promo_usage_snapshot"');
    expect(service).toContain("pagedPromoUsage");
    expect(service).toContain(".range(from, from + PROMO_PAGE_SIZE - 1)");
    expect(migration).toContain("promo_redemptions_usage_lookup_idx");
  });

  it("validates numeric fields before saving", () => {
    const panel = source("src/components/admin/PromoCodesPanel.tsx");
    expect(panel).toContain("validateDraft(nextDraft)");
    expect(panel).toContain("positive whole number or left blank");
    expect(panel).toContain('type="number" min="1" step="1"');
    expect(panel).toContain("finally {");
    expect(panel).toContain("setBusy(false)");
  });

  it("reports completed value separately from pending, refunded and disputed attribution", () => {
    const panel = source("src/components/admin/PromoCodesPanel.tsx");
    expect(panel).toContain('item.status === "finalized"');
    expect(panel).toContain('item.status === "reserved"');
    expect(panel).toContain('item.status === "refunded"');
    expect(panel).toContain('item.status === "disputed"');
    expect(panel).toContain("Captured/approved value:");
    expect(panel).toContain("Pending attribution:");
    expect(panel).not.toContain("Attributed revenue:");
  });
});
