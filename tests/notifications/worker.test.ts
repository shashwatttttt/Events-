import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  finish: vi.fn(),
  claimEnqueueJobs: vi.fn(),
  finishEnqueueJob: vi.fn(),
  enqueueOrder: vi.fn(),
  render: vi.fn(),
  renderOther: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@/lib/notifications/store", () => ({ claimNotifications: mocks.claim, finishNotification: mocks.finish }));
vi.mock("@/lib/notifications/enqueue-jobs", () => ({
  claimNotificationEnqueueJobs: mocks.claimEnqueueJobs,
  finishNotificationEnqueueJob: mocks.finishEnqueueJob,
}));
vi.mock("@/lib/notifications/service", () => ({
  enqueueOrderFulfilmentNotifications: mocks.enqueueOrder,
  renderOutboxEmail: mocks.render,
  renderOutboxNotification: mocks.renderOther,
}));
vi.mock("@/lib/notifications/provider", () => ({
  configuredEmailProvider: () => ({ name: "local", send: mocks.send }),
  configuredTextProvider: () => ({ name: "local", send: mocks.send }),
}));

const item = {
  id: "notification_fixture", channel: "email" as const, templateKey: "application_received",
  recipientAddress: "fixture@example.test", payload: { variables: {} }, idempotencyKey: "fixture-key",
  status: "claimed" as const, attemptCount: 1, maxAttempts: 3, availableAt: "2026-01-01T00:00:00.000Z",
  leaseOwner: "worker-fixture", correlationId: "corr-fixture", createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("notification worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue([item]);
    mocks.claimEnqueueJobs.mockResolvedValue([]);
    mocks.render.mockResolvedValue({ subject: "Fixture", html: "<p>Fixture</p>", text: "Fixture", attachments: [] });
  });

  it("records local dry-run delivery without invoking a provider", async () => {
    const { processNotificationBatch } = await import("@/lib/notifications/worker");
    const result = await processNotificationBatch({ dryRun: true, workerId: "worker-fixture" });
    expect(result).toMatchObject({ claimed: 1, processed: 1, enqueueJobs: { claimed: 0 } });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.finish).toHaveBeenCalledWith(item, "worker-fixture_0", expect.objectContaining({ status: "dry_run" }));
  });

  it("retains only a safe retryable render code", async () => {
    mocks.render.mockRejectedValue(new Error("database password and recipient token"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { processNotificationBatch } = await import("@/lib/notifications/worker");
    const result = await processNotificationBatch({ workerId: "worker-fixture" });
    expect(result.results[0]).toMatchObject({ status: "temporary_failure", code: "NOTIFICATION_RENDER_FAILED" });
    expect(mocks.finish).toHaveBeenCalledWith(item, "worker-fixture_0", { status: "temporary_failure", safeErrorCode: "NOTIFICATION_RENDER_FAILED" });
    expect(log).not.toHaveBeenCalled();
  });

  it("marks invalid ticket state terminal", async () => {
    mocks.render.mockRejectedValue(new Error("NOTIFICATION_NO_VALID_TICKETS"));
    const { processNotificationBatch } = await import("@/lib/notifications/worker");
    await processNotificationBatch({ workerId: "worker-fixture" });
    expect(mocks.finish).toHaveBeenCalledWith(item, "worker-fixture_0", { status: "permanent_failure", safeErrorCode: "NOTIFICATION_NO_VALID_TICKETS" });
  });

  it("completes a durable fulfilment enqueue job after idempotent outbox creation", async () => {
    mocks.claim.mockResolvedValue([]);
    mocks.claimEnqueueJobs.mockResolvedValue([{ id: "job", orderId: "order", attemptCount: 1 }]);
    mocks.enqueueOrder.mockResolvedValue({});
    const { processNotificationBatch } = await import("@/lib/notifications/worker");
    const result = await processNotificationBatch({ workerId: "worker-fixture" });
    expect(mocks.enqueueOrder).toHaveBeenCalledWith("order");
    expect(mocks.finishEnqueueJob).toHaveBeenCalledWith(
      { id: "job", orderId: "order", attemptCount: 1 },
      "worker-fixture_enqueue",
      "completed",
    );
    expect(result.enqueueJobs).toMatchObject({ claimed: 1, failed: 0 });
  });
});
