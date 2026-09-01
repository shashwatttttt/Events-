import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("durable event payment shutdown", () => {
  it("queues both open Checkout Sessions and uncaptured PaymentIntents", () => {
    const migration = source("supabase/migrations/20260727000031_durable_event_payment_shutdown.sql");

    expect(migration).toContain("event_payment_shutdown_actions");
    expect(migration).toContain("'checkout_session'");
    expect(migration).toContain("'payment_intent'");
    expect(migration).toContain("'expire_session'");
    expect(migration).toContain("'cancel_intent'");
    expect(migration).toContain("application.payment_status in ('authorized','capture_requested','cancel_requested')");
    expect(migration).toContain("for update skip locked");
  });

  it("uses a durable queue with retries, leases and manual review", () => {
    const migration = source("supabase/migrations/20260727000031_durable_event_payment_shutdown.sql");
    const worker = source("src/lib/payments/event-shutdown.ts");

    expect(migration).toContain("EVENT_SHUTDOWN_LEASE_TIMEOUT");
    expect(migration).toContain("EVENT_SHUTDOWN_LEASE_LOST");
    expect(worker).toContain('rpc("skie_request_event_payment_shutdown"');
    expect(worker).toContain('rpc("skie_claim_event_payment_shutdown_actions"');
    expect(worker).toContain('rpc("skie_finish_event_payment_shutdown_action"');
    expect(worker).toContain('terminal ? "manual_review" : "retry"');
  });

  it("never automatically refunds a captured payment", () => {
    const worker = source("src/lib/payments/event-shutdown.ts");

    expect(worker).toContain('paymentIntent.status === "succeeded"');
    expect(worker).toContain("EVENT_SHUTDOWN_PAYMENT_ALREADY_CAPTURED");
    expect(worker).not.toContain("requestStripeFullRefund");
    expect(worker).not.toContain("refunds.create");
  });

  it("rechecks event state immediately before provider mutation", () => {
    const shutdownWorker = source("src/lib/payments/event-shutdown.ts");
    const paymentWorker = source("src/lib/post-approval/worker.ts");

    expect(shutdownWorker).toContain("eventPaymentShutdownStillRequired(action.eventId)");
    expect(shutdownWorker.indexOf("eventPaymentShutdownStillRequired(action.eventId)")).toBeLessThan(
      shutdownWorker.indexOf("await expireStripeCheckoutSession(action.providerObjectId)"),
    );
    expect(shutdownWorker.lastIndexOf("eventPaymentShutdownStillRequired(action.eventId)")).toBeLessThan(
      shutdownWorker.indexOf("const cancelled = await cancelStripePaymentIntent"),
    );
    expect(paymentWorker).toContain("postCheckoutApplicationEventOpen(action.applicationId)");
    expect(paymentWorker).toContain("closeCaptureForClosedEvent(action, current");
    expect(paymentWorker).toContain("event-shutdown-capture:${action.id}");
    expect(paymentWorker).toContain('errorCode === "EVENT_SHUTDOWN_PAYMENT_ALREADY_CAPTURED"');
    expect(paymentWorker).not.toContain("requestStripeFullRefund");
  });

  it("releases reopened-event work so a later closure can queue it again", () => {
    const worker = source("src/lib/payments/event-shutdown.ts");

    expect(worker).toContain("releaseEventPaymentShutdownAction");
    expect(worker).toContain('.from("event_payment_shutdown_actions")');
    expect(worker).toContain(".delete()");
    expect(worker).toContain("EVENT_SHUTDOWN_RELEASED_EVENT_REOPENED");
    expect(worker).toContain('if (outcome === "released")');
  });

  it("queues shutdown work during admin closure and retains a rollout fallback", () => {
    const route = source("src/app/api/admin/site/route.ts");

    expect(route).toContain("processEventPaymentShutdownBatch");
    expect(route).toContain("saved.closedEventIds");
    expect(route).toContain("legacyExpireClosedEventSessions");
    expect(route).toContain("if (!shutdownAvailable)");
    expect(route).toContain("EVENT_PAYMENT_SHUTDOWN_INCOMPLETE");
  });

  it("strictly monitors unresolved shutdown work without globally blocking unrelated checkout", () => {
    const health = source("src/lib/post-approval/health.ts");
    const workflow = source(".github/workflows/post-checkout-worker.yml");

    expect(health).toContain("eventShutdownActionsRequiringReview");
    expect(health).toContain("stalledEventShutdownActions");
    expect(health).toContain("health.eventShutdownActionsRequiringReview === 0");
    expect(health).not.toContain('blockers.push("EVENT_SHUTDOWN');
    expect(workflow).toContain("EVENT_SHUTDOWN_FAILURES");
    expect(workflow).toContain("UNRESOLVED_EVENT_SHUTDOWN");
    expect(workflow).toContain("STALLED_EVENT_SHUTDOWN");
  });
});
