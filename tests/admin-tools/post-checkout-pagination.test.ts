import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("post-checkout admin pagination", () => {
  it("classifies and pages records in the database", () => {
    const migration = source("supabase/migrations/20260727000032_post_checkout_admin_pagination.sql");

    expect(migration).toContain("skie_list_post_checkout_admin_page");
    expect(migration).toContain("left join lateral");
    expect(migration).toContain("order by action.created_at desc,action.id desc");
    expect(migration).toContain("admin_bucket");
    expect(migration).toContain("p_cursor_created_at");
    expect(migration).toContain("p_cursor_id");
    expect(migration).toContain("limit greatest(1,least(coalesce(p_limit,50),100))");
  });

  it("hydrates only the IDs returned by the page RPC", () => {
    const store = source("src/lib/post-approval/admin-page-store.ts");

    expect(store).toContain('rpc("skie_list_post_checkout_admin_page"');
    expect(store).toContain('.in("id", ids)');
    expect(store).toContain("p_limit: limit + 1");
    expect(store).toContain("nextCursor");
    expect(store).toContain("base64url");
  });

  it("keeps only a rollout fallback on the old capped loader", () => {
    const store = source("src/lib/post-approval/admin-page-store.ts");
    const legacy = source("src/lib/post-approval/store.ts");

    expect(store).toContain("if (rpcUnavailable(pageResult.error)) return fallbackPage(options)");
    expect(legacy).toContain('.limit(500)');
    expect(store).not.toContain('.limit(500)');
  });

  it("loads filtered pages and exposes Load more in the admin UI", () => {
    const route = source("src/app/api/admin/post-checkout/route.ts");
    const panel = source("src/components/admin/PostCheckoutApplicationsPanel.tsx");

    expect(route).toContain("listSchema.parse(Object.fromEntries(url.searchParams.entries()))");
    expect(route).toContain("nextCursor: page.nextCursor");
    expect(panel).toContain('limit: "50"');
    expect(panel).toContain('query.set("cursor", options.cursor)');
    expect(panel).toContain("mergeUnique");
    expect(panel).toContain("Load more");
    expect(panel).not.toContain("useMemo");
  });

  it("sends reminders by exact application ID instead of searching a 500-row list", () => {
    const service = source("src/lib/post-approval/admin-service.ts");
    const route = source("src/app/api/admin/post-checkout/route.ts");

    expect(service).toContain("getPostCheckoutAdminItemById(applicationId)");
    expect(route).toContain("sendPostCheckoutFormReminderById");
    expect(route).not.toContain("sendPostCheckoutFormReminder,");
  });
});
