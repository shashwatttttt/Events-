import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260724000015_post_checkout_submit_rpc_repair.sql"),
  "utf8",
);

describe("post-checkout submit RPC repair", () => {
  it("recreates the exact server RPC and preserves the authorized review workflow", () => {
    expect(migration).toContain("public.skie_submit_post_checkout_application(");
    expect(migration).toContain("p_expected_state_version integer");
    expect(migration).toContain("p_review_due_at timestamptz");
    expect(migration).toContain("payment_status <> 'authorized'");
    expect(migration).toContain("status = 'submitted'");
    expect(migration).toContain("workflow_status = 'under_review'");
  });

  it("keeps the RPC server-only and refreshes the PostgREST schema cache", () => {
    expect(migration).toContain("from public, anon, authenticated");
    expect(migration).toContain("to service_role");
    expect(migration).toContain("notify pgrst, 'reload schema'");
  });
});
