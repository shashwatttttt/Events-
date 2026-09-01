import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const config = readFileSync(join(process.cwd(), "src/lib/config.ts"), "utf8");
const route = readFileSync(
  join(process.cwd(), "src/app/api/internal/post-checkout/process/route.ts"),
  "utf8",
);

describe("production operations health normalization", () => {
  it("normalizes provider environment values before selecting live integrations", () => {
    expect(config).toContain("function normalizedEnv");
    expect(config).toContain('emailProvider: normalizedEnv("EMAIL_PROVIDER") === "resend"');
    expect(config).toContain('smsProvider: normalizedEnv("SMS_PROVIDER") === "twilio"');
    expect(config).toContain('muxDefaultPlaybackPolicy: normalizedEnv("MUX_DEFAULT_PLAYBACK_POLICY")');
  });

  it("uses the current successful heartbeat instead of a stale immediate health read", () => {
    const successWrite = route.indexOf('recordProductionOperationsHeartbeat("succeeded")');
    const healthRead = route.indexOf("readPostCheckoutOperationsHealth()");
    expect(successWrite).toBeGreaterThan(-1);
    expect(healthRead).toBeGreaterThan(successWrite);
    expect(route).toContain("workerHeartbeatHealthy: true");
    expect(route).toContain("workerLastSucceededAt: succeededAt");
  });
});
