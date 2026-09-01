import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = join(process.cwd(), "supabase", "migrations");
const STRICT_VERSION_FROM = "20260724000016";

function migrationSource(name: string) {
  return readFileSync(join(migrationsDirectory, name), "utf8");
}

describe("production database migrations", () => {
  it("uses a unique numeric version and strict timestamps for new migrations", () => {
    const files = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith(".sql"));
    const versions = files.map((name) => {
      const match = /^(\d+)_/.exec(name);
      expect(match, `Migration ${name} must start with a numeric version`).not.toBeNull();
      return match![1];
    });

    expect(new Set(versions).size).toBe(versions.length);
    expect(
      versions
        .filter((version) => BigInt(version) >= BigInt(STRICT_VERSION_FROM))
        .every((version) => /^\d{14}$/.test(version)),
    ).toBe(true);
  });

  it("allows only monotonic expiry extensions for active reservations", () => {
    const source = migrationSource(
      "20260724000016_allow_post_checkout_reservation_expiry_extensions.sql",
    );

    expect(source).toContain("new.expires_at < old.expires_at");
    expect(source).toContain("old.status not in ('reserved','session_active')");
    expect(source).toContain("new.status not in ('reserved','session_active')");
    expect(source).toContain("RESERVATION_EXPIRY_EXTENSION_INVALID");

    const immutableSnapshot = source.slice(
      source.indexOf("if row("),
      source.indexOf("if new.expires_at"),
    );
    expect(immutableSnapshot).not.toContain("expires_at");
    expect(immutableSnapshot).toContain("expected_total_cents");
    expect(immutableSnapshot).toContain("customer_id");
    expect(immutableSnapshot).toContain("event_id");
  });
});
