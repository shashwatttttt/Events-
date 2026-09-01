import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("customer critical paths", () => {
  it("keeps ticket checkout single-flight through provider redirect", () => {
    const checkout = source("src/components/CheckoutBuilder.tsx");
    expect(checkout).toContain("const submittingRef = useRef(false)");
    expect(checkout).toContain("if (submittingRef.current)");
    expect(checkout).toContain("submittingRef.current = true");
    expect(checkout).toContain("redirecting");
  });

  it("prevents duplicate invite-form submissions before React state updates", () => {
    const form = source("src/components/ApplicationFormClient.tsx");
    expect(form).toContain("const submittingRef = useRef(false)");
    expect(form).toContain("if (submittingRef.current) return");
    expect(form).toContain("submittingRef.current = true");
    expect(form).toContain("if (!redirecting)");
    expect(form).toContain("submittingRef.current = false");
  });

  it("recovers an identical server-side application retry idempotently", () => {
    const route = source("src/app/api/applications/route.ts");
    expect(route).toContain("recoverIdenticalApplication");
    expect(route).toContain("stableAnswers(item.answers) === stableAnswers(options.answers)");
    expect(route).toContain("for (let attempt = 0; attempt < 3; attempt += 1)");
    expect(route).toContain('error.message !== "You already have an active application for this event."');
    expect(route).toContain("if (!existing) throw error");
    expect(route).toContain("application = existing");
  });

  it("keeps the mandatory post-checkout form protected from autosave races", () => {
    const client = source("src/components/PostCheckoutApplicationClient.tsx");
    const route = source("src/app/api/post-checkout/application/route.ts");
    expect(client).toContain("const submittingRef = useRef(false)");
    expect(client).toContain("await saveChain.current.catch(() => undefined)");
    expect(route).toContain("submitWithConflictRecovery");
    expect(route).toContain("answersMatch(application.submittedAnswers, input.answers)");
  });

  it("shows recoverable network errors instead of leaving forms permanently busy", () => {
    const form = source("src/components/ApplicationFormClient.tsx");
    expect(form).toContain("await response.json().catch");
    expect(form).toContain("The connection was interrupted");
    expect(form).toContain("setBusy(false)");
  });
});
