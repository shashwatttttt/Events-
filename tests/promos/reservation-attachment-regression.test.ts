import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260726000024_promo_reservation_attachment.sql"),
  "utf8",
);

describe("promo reservation attachment guard", () => {
  it("allows only the atomic first promo attachment backed by a reserved redemption", () => {
    expect(migration).toContain("old.promo_code_id is null");
    expect(migration).toContain("new.promo_code_id is not null");
    expect(migration).toContain("old.status = 'reserved'");
    expect(migration).toContain("new.status = 'reserved'");
    expect(migration).toContain("redemption.reservation_id = old.id");
    expect(migration).toContain("redemption.promo_code_id = new.promo_code_id");
    expect(migration).toContain("redemption.status = 'reserved'");
  });

  it("keeps commercial snapshots and reservation expiry protections immutable", () => {
    expect(migration).toContain("new.expected_subtotal_cents");
    expect(migration).toContain("new.expected_discount_cents");
    expect(migration).toContain("new.expected_total_cents");
    expect(migration).toContain("RESERVATION_SNAPSHOT_IMMUTABLE");
    expect(migration).toContain("new.expires_at < old.expires_at");
    expect(migration).toContain("RESERVATION_EXPIRY_EXTENSION_INVALID");
  });
});
