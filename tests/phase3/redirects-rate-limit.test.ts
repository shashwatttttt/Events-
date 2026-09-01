import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enforceRateLimit, requestKey, resetLocalRateLimitsForTests } from "@/lib/rate-limit";
import { safeRedirectPath } from "@/lib/security/redirects";
import { assertRequestOrigin } from "@/lib/http";

describe("safe login redirects", () => {
  it.each(["//outside.example/path", "/\\outside", "https://outside.example", "/api/private", "/%2f%2foutside"])(
    "rejects unsafe next path %s",
    (value) => expect(safeRedirectPath(value)).toBe("/account"),
  );

  it("preserves a safe checkout path and query", () => {
    expect(safeRedirectPath("/checkout/test?order=fixture#pay")).toBe("/checkout/test?order=fixture#pay");
  });
});

describe("request identity and local limiter parity", () => {
  const previousVercel = process.env.VERCEL;

  beforeEach(() => {
    delete process.env.VERCEL;
    resetLocalRateLimitsForTests();
  });

  afterEach(() => {
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  });

  it("ignores spoofable forwarding headers outside the trusted Vercel boundary", () => {
    const first = new Request("http://localhost", { headers: { "x-forwarded-for": "198.51.100.10" } });
    const second = new Request("http://localhost", { headers: { "x-forwarded-for": "203.0.113.11" } });
    expect(requestKey(first, "login")).toBe(requestKey(second, "login"));
  });

  it("uses the platform-authenticated forwarding header only on Vercel", () => {
    process.env.VERCEL = "1";
    const first = new Request("https://example.test", { headers: { "x-vercel-forwarded-for": "198.51.100.10" } });
    const second = new Request("https://example.test", { headers: { "x-vercel-forwarded-for": "203.0.113.11" } });
    expect(requestKey(first, "login")).not.toBe(requestKey(second, "login"));
  });

  it("returns a stable 429 with Retry-After after the final local slot", async () => {
    await expect(enforceRateLimit("fixture-final-slot", 1, 60_000)).resolves.toMatchObject({ allowed: true });
    await expect(enforceRateLimit("fixture-final-slot", 1, 60_000)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
      headers: { "Retry-After": expect.any(String) },
    });
  });
});

describe("same-origin enforcement", () => {
  const previousVercel = process.env.VERCEL;

  afterEach(() => {
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  });

  it("does not trust a client-supplied forwarded host outside Vercel", () => {
    delete process.env.VERCEL;
    const request = new Request("http://local.test/api", {
      headers: { host: "local.test", origin: "https://outside.test", "x-forwarded-host": "outside.test" },
    });
    expect(() => assertRequestOrigin(request)).toThrow(/origin was rejected/i);
  });
});
