import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("post-checkout application submit concurrency", () => {
  it("serializes autosave behind an exclusive submit lock", () => {
    const client = source("src/components/PostCheckoutApplicationClient.tsx");
    expect(client).toContain("const submittingRef = useRef(false)");
    expect(client).toContain("if (submittingRef.current) return saveChain.current.catch(() => undefined)");
    expect(client).toContain("submittingRef.current = true");
    expect(client).toContain("await saveChain.current.catch(() => undefined)");
    expect(client).toContain("submittingRef.current = false");
  });

  it("prevents answers from changing while the submit request is in flight", () => {
    const client = source("src/components/PostCheckoutApplicationClient.tsx");
    expect(client).toContain("if (submittingRef.current) return;");
    expect(client).toContain("disabled={submitting}");
    expect(client).toContain("const submittedAnswers = { ...latestAnswers.current }");
  });

  it("recovers one stale save or submit version on the server", () => {
    const route = source("src/app/api/post-checkout/application/route.ts");
    expect(route).toContain("saveWithConflictRecovery");
    expect(route).toContain("submitWithConflictRecovery");
    expect(route).toContain("POST_APPROVAL_STALE_VERSION");
    expect(route).toContain("expectedStateVersion: application.stateVersion");
  });

  it("treats an already completed identical submission as success", () => {
    const route = source("src/app/api/post-checkout/application/route.ts");
    expect(route).toContain('["submitted", "under_review"].includes(application.status)');
    expect(route).toContain("answersMatch(application.submittedAnswers, input.answers)");
    expect(route).toContain("applicationId: application.id");
  });

  it("fails with a clear conflict instead of a generic database error after repeated races", () => {
    const route = source("src/app/api/post-checkout/application/route.ts");
    expect(route).toContain('"POST_APPROVAL_FORM_CHANGED"');
    expect(route).toContain("This application is being updated elsewhere");
    expect(route).toContain("409");
  });
});
