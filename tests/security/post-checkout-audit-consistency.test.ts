import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("post-checkout supplemental audit consistency", () => {
  it("does not report durable form submission or decision failure when supplemental audit storage is unavailable", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/post-approval/service.ts"), "utf8");
    expect(source).toContain('action: "post_checkout.form_submitted"');
    expect(source).toContain('action: `post_checkout.${input.decision}`');
    const nonBlocking = source.match(/addPostCheckoutAudit\([\s\S]*?\}\)\.catch\(\(\) => undefined\)/g) || [];
    expect(nonBlocking.length).toBeGreaterThanOrEqual(3);
  });
});
