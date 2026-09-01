import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("notification provider reliability", () => {
  it("uses Resend API idempotency rather than a message header", () => {
    const provider = source("src/lib/notifications/provider.ts");
    expect(provider).toContain("}, {\n        idempotencyKey: input.idempotencyKey,");
    expect(provider).not.toContain("X-SKIE-Idempotency-Key");
  });

  it("does not automatically repeat an SMS after an ambiguous network outcome", () => {
    const provider = source("src/lib/notifications/provider.ts");
    expect(provider).toContain("SMS_PROVIDER_OUTCOME_UNKNOWN");
    expect(provider).not.toContain('"Idempotency-Key": input.idempotencyKey');
  });

  it("never silently dry-runs live notification channels when providers are disabled", () => {
    const provider = source("src/lib/notifications/provider.ts");
    expect(provider).toContain("new DisabledEmailProvider()");
    expect(provider).toContain("new DisabledTextProvider()");
    expect(provider).toContain('if (config.appMode === "live")');
  });

  it("gives every notification channel a claim opportunity before using spare capacity", () => {
    const worker = source("src/lib/notifications/worker.ts");
    expect(worker).toContain("claimFairNotificationBatch");
    expect(worker).toContain("initialShare");
    expect(worker).toContain("orderedChannels");
    expect(worker).toContain("for (const channel of orderedChannels)");
    expect(worker).toContain("items.length < batchSize");
  });
});
