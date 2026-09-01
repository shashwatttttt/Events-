import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("durable Stripe webhook replay", () => {
  it("stores only immutable Stripe event IDs in the replay queue", () => {
    const migration = source("supabase/migrations/20260727000034_stripe_webhook_replay_queue.sql");

    expect(migration).toContain("stripe_webhook_replay_actions");
    expect(migration).toContain("stripe_event_id text not null unique");
    expect(migration).not.toContain("raw_payload");
    expect(migration).not.toContain("card_number");
    expect(migration).toContain("for update skip locked");
    expect(migration).toContain("WEBHOOK_REPLAY_LEASE_TIMEOUT");
  });

  it("queues every temporary inbox failure and retries with leases", () => {
    const migration = source("supabase/migrations/20260727000034_stripe_webhook_replay_queue.sql");
    const replay = source("src/lib/payments/webhook-replay.ts");

    expect(migration).toContain("skie_queue_temporary_stripe_webhook_replays");
    expect(migration).toContain("event.status = 'temporary_failure'");
    expect(replay).toContain('rpc("skie_claim_stripe_webhook_replays"');
    expect(replay).toContain('rpc("skie_finish_stripe_webhook_replay"');
    expect(replay).toContain("replay.attemptCount >= 5");
  });

  it("retrieves the signed event from Stripe and runs the same verified processor", () => {
    const route = source("src/app/api/stripe/webhook/route.ts");
    const replay = source("src/lib/payments/webhook-replay.ts");
    const processor = source("src/lib/payments/webhook-processor.ts");

    expect(route).toContain("processVerifiedStripeEvent(event)");
    expect(route).toContain("requestStripeWebhookReplay(event.id)");
    expect(replay).toContain("retrieveVerifiedStripeEvent(replay.stripeEventId)");
    expect(replay).toContain("processVerifiedStripeEvent(event)");
    expect(processor).toContain("fulfillStripeOrder");
    expect(processor).toContain("recordPostCheckoutAuthorizationFromSession");
    expect(processor).toContain("applyStripeRefundUpdate");
    expect(processor).toContain("applyStripeDisputeUpdate");
  });

  it("marks processed events idempotently and escalates exhausted work", () => {
    const replay = source("src/lib/payments/webhook-replay.ts");

    expect(replay).toContain('markStripeWebhookInboxResult(replay.stripeEventId, "processed")');
    expect(replay).toContain('terminal ? "manual_review" : "retry"');
    expect(replay).toContain('terminal ? "manual_review" : "temporary_failure"');
  });

  it("fails strict health closed when the replay health RPC is unavailable", () => {
    const replay = source("src/lib/payments/webhook-replay.ts");
    const healthStart = replay.indexOf("export async function readStripeWebhookReplayHealth");
    const batchStart = replay.indexOf("export async function processStripeWebhookReplayBatch");
    const healthFunction = replay.slice(healthStart, batchStart);

    expect(healthFunction).toContain('if (error) throw new Error("WEBHOOK_REPLAY_HEALTH_UNAVAILABLE")');
    expect(healthFunction).not.toContain('if (rpcUnavailable(error, "skie_stripe_webhook_replay_health"))');
  });

  it("runs replay before other scheduled payment work and monitors its backlog", () => {
    const route = source("src/app/api/internal/post-checkout/process/route.ts");
    const health = source("src/lib/post-approval/health.ts");
    const healthMigration = source("supabase/migrations/20260727000035_stripe_webhook_replay_health.sql");
    const replayInvocation = route.indexOf("const webhookReplay = await processStripeWebhookReplayBatch");
    const shutdownInvocation = route.indexOf("const eventShutdown = await processEventPaymentShutdownBatch");

    expect(replayInvocation).toBeGreaterThan(-1);
    expect(shutdownInvocation).toBeGreaterThan(-1);
    expect(replayInvocation).toBeLessThan(shutdownInvocation);
    expect(health).toContain("webhookReplayActionsRequiringReview");
    expect(health).toContain("stalledWebhookReplayActions");
    expect(healthMigration).toContain("skie_stripe_webhook_replay_health");
    expect(healthMigration).toContain("actions_requiring_review");
  });

  it("fails production monitoring on replay failures or backlog and publishes each counter", () => {
    const workflow = source(".github/workflows/post-checkout-worker.yml");

    expect(workflow).toContain("WEBHOOK_REPLAY_FAILURES");
    expect(workflow).toContain("UNRESOLVED_WEBHOOK_REPLAY");
    expect(workflow).toContain("STALLED_WEBHOOK_REPLAY");
    expect(workflow).toContain(".webhookReplay.failed // 0");
    expect(workflow).toContain(".health.webhookReplayActionsRequiringReview // 0");
    expect(workflow).toContain(".health.stalledWebhookReplayActions // 0");
    expect(workflow).toContain("Stripe webhook replay work requires recovery.");
    expect(workflow).toContain("Stripe webhook replay actions failed this run");
    expect(workflow).toContain("Stripe webhook replay actions requiring review");
    expect(workflow).toContain("Stalled Stripe webhook replay actions");
  });
});
