import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("signup identity requirements", () => {
  it("requires Instagram in the browser and server schema", () => {
    const form = source("src/components/AuthForm.tsx");
    const validation = source("src/lib/validate.ts");

    expect(form).toContain('name="instagram" required');
    expect(form).toContain('name="phone" required');
    expect(form).toContain('name="firstName" required');
    expect(form).toContain('name="lastName" required');
    expect(validation).toContain('min(2, "Instagram is required.")');
    expect(validation).toContain("instagram: instagramSchema");
    expect(validation).not.toContain("instagramSchema.optional()");
  });

  it("keeps transactional message consent optional", () => {
    const form = source("src/components/AuthForm.tsx");
    const validation = source("src/lib/validate.ts");

    expect(form).toContain('name="transactionalSmsConsent" type="checkbox"');
    expect(form).not.toContain('name="transactionalSmsConsent" type="checkbox" required');
    expect(validation).toContain("transactionalSmsConsent:");
    expect(validation).toContain(".optional()");
  });
});
