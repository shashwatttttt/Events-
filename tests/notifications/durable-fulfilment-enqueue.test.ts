import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("durable fulfilment notification enqueue", () => {
  it("creates a unique job in the same transaction that marks an order fulfilled", () => {
    const migration = source("supabase/migrations/20260727000030_durable_fulfilment_notifications.sql");

    expect(migration).toContain("notification_enqueue_jobs");
    expect(migration).toContain("unique (order_id, job_type)");
    expect(migration).toContain("after insert or update of status on public.orders");
    expect(migration).toContain("new.status = 'fulfilled'");
    expect(migration).toContain("on conflict (order_id, job_type) do nothing");
  });

  it("backfills only recent fulfilled orders missing a ticket notification", () => {
    const migration = source("supabase/migrations/20260727000030_durable_fulfilment_notifications.sql");

    expect(migration).toContain("o.updated_at >= now() - interval '30 days'");
    expect(migration).toContain("n.template_key = 'ticket_issued'");
    expect(migration).toContain("not exists");
  });

  it("claims, retries and terminally surfaces failed enqueue work", () => {
    const migration = source("supabase/migrations/20260727000030_durable_fulfilment_notifications.sql");
    const jobs = source("src/lib/notifications/enqueue-jobs.ts");
    const worker = source("src/lib/notifications/worker.ts");

    expect(migration).toContain("for update skip locked");
    expect(migration).toContain("NOTIFICATION_ENQUEUE_LEASE_TIMEOUT");
    expect(migration).toContain("NOTIFICATION_ENQUEUE_LEASE_LOST");
    expect(jobs).toContain('rpc("skie_claim_notification_enqueue_jobs"');
    expect(jobs).toContain('rpc("skie_finish_notification_enqueue_job"');
    expect(worker).toContain("enqueueOrderFulfilmentNotifications(job.orderId)");
    expect(worker).toContain('terminal ? "manual_review" : "retry"');
  });

  it("monitors missing enqueue work without using it to shut down new card authorisations", () => {
    const health = source("src/lib/post-approval/health.ts");
    const workflow = source(".github/workflows/post-checkout-worker.yml");

    expect(health).toContain("notificationEnqueueJobsRequiringReview");
    expect(health).toContain("stalledNotificationEnqueueJobs");
    expect(health).toContain("health.notificationEnqueueJobsRequiringReview === 0");
    expect(health).not.toContain('blockers.push("NOTIFICATION_ENQUEUE');
    expect(workflow).toContain("UNRESOLVED_ENQUEUE_JOBS");
    expect(workflow).toContain("STALLED_ENQUEUE_JOBS");
    expect(workflow).toContain("Notification enqueue jobs requiring review");
  });

  it("drains bounded parallel batches within the serverless runtime", () => {
    const worker = source("src/lib/notifications/worker.ts");
    const route = source("src/app/api/internal/post-checkout/process/route.ts");
    const workflow = source(".github/workflows/post-checkout-worker.yml");

    expect(worker).toContain("Math.min(options.maxBatches || 1, 4)");
    expect(worker).toContain("const deadline = Date.now() + 45_000");
    expect(worker).toContain("items.slice(from, from + 5)");
    expect(route).toContain("maxBatches: 4");
    expect(workflow).toContain("batchSize\":25");
  });
});
