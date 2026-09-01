import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("post-checkout authorisation availability", () => {
  it("keeps monitoring incidents structurally separate from payment safety", () => {
    const health = source("src/lib/post-approval/health.ts");
    const readiness = source("src/lib/post-approval/readiness.ts");

    expect(health).toContain("export function postCheckoutOperationsHealthy");
    expect(health).toContain("export function postCheckoutAuthorisationHealthy");
    expect(health).toContain("export function postCheckoutAuthorisationBlockers");
    expect(health).toContain("export function postCheckoutMonitoringOnlyBlockers");
    expect(health).toContain("&& health.workerHeartbeatHealthy");

    const blockerStart = health.indexOf("export function postCheckoutAuthorisationBlockers");
    const healthyStart = health.indexOf("export function postCheckoutAuthorisationHealthy");
    const monitoringStart = health.indexOf("export function postCheckoutMonitoringOnlyBlockers");
    const checkoutBlockers = health.slice(blockerStart, healthyStart);
    const authorisationPredicate = health.slice(healthyStart, monitoringStart);

    expect(checkoutBlockers).toContain("PAYMENT_ACTION_REVIEW_REQUIRED");
    expect(checkoutBlockers).toContain("PAYMENT_RECOVERY_REVIEW_REQUIRED");
    expect(checkoutBlockers).toContain("ORPHAN_STRIPE_SESSION");
    expect(checkoutBlockers).toContain("NOTIFICATION_PROVIDER_NOT_CONFIGURED");
    expect(checkoutBlockers).not.toContain("PAYMENT_ACTION_STALLED");
    expect(checkoutBlockers).not.toContain("WEBHOOK_REPLAY_STALLED");
    expect(checkoutBlockers).not.toContain("WEBHOOK_REVIEW_REQUIRED");
    expect(authorisationPredicate).toContain("postCheckoutAuthorisationBlockers(health).length === 0");

    expect(readiness).toContain("postCheckoutAuthorisationHealthy(health)");
    expect(readiness).toContain("postCheckoutAuthorisationBlockers(health)");
    expect(readiness).toContain("postCheckoutMonitoringOnlyBlockers(health)");
  });

  it("retries transient aggregate-health reads without making them a global outage", () => {
    const health = source("src/lib/post-approval/health.ts");
    const readiness = source("src/lib/post-approval/readiness.ts");
    expect(health).toContain("for (let attempt = 0; attempt < 3; attempt += 1)");
    expect(health).toContain("await wait(100 * (attempt + 1))");
    expect(readiness).toContain("readAuthorisationHealthBestEffort");
    expect(readiness).toContain("if (!health) return null");
  });
});
