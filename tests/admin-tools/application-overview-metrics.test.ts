import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAdminApplicationMetrics } from "../../src/lib/admin/application-metric-values";

describe("admin application overview metrics", () => {
  it("combines invite and post-checkout review counts without double counting", () => {
    const metrics = buildAdminApplicationMetrics({
      invitePendingReview: 2,
      inviteTotal: 15,
      postCheckoutPendingReview: 3,
      postCheckoutTotal: 8,
      updatedAt: "2026-07-29T05:00:00.000Z",
    });

    expect(metrics.pendingReviewTotal).toBe(5);
    expect(metrics.applicationTotal).toBe(23);
    expect(metrics.invitePendingReview).toBe(2);
    expect(metrics.postCheckoutPendingReview).toBe(3);
  });

  it("keeps the overview wired to the combined server metric", () => {
    const overview = readFileSync("src/components/admin/OverviewPanel.tsx", "utf8");
    const snapshotRoute = readFileSync("src/app/api/admin/snapshot/route.ts", "utf8");

    expect(overview).toContain("applicationMetrics.pendingReviewTotal");
    expect(overview).toContain("applicationMetrics.postCheckoutPendingReview");
    expect(snapshotRoute).toContain("readAdminApplicationMetrics");
    expect(snapshotRoute).toContain("applicationMetrics,");
  });

  it("counts only review-ready post-checkout states and excludes removed test customers", () => {
    const migration = readFileSync(
      "supabase/migrations/20260729000037_post_checkout_overview_counts.sql",
      "utf8",
    );

    expect(migration).toContain("'submitted', 'under_review', 'manual_review'");
    expect(migration).toContain("customer.admin_deleted_at is null");
    expect(migration).toContain("grant execute on function public.skie_get_post_checkout_application_counts() to service_role");
  });
});
