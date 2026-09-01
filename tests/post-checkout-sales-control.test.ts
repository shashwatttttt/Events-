import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../supabase/migrations/20260724000013_post_checkout_sales_control.sql", import.meta.url),
  "utf8",
);

describe("post-checkout atomic sales control migration", () => {
  it("recognises post-checkout approval as a sale-enabled ticket mode", () => {
    expect(migration).toContain("'post_checkout_approval'");
    expect(migration).toContain("create or replace function public.skie_event_sales_enabled");
  });

  it("reconciles existing controls from the authoritative site document", () => {
    expect(migration).toContain("update public.event_sale_controls");
    expect(migration).toContain("public.platform_documents");
    expect(migration).toContain("document.key = 'site'");
  });
});
