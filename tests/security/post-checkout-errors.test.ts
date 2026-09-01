import { describe, expect, it } from "vitest";
import { apiError } from "@/lib/http";

describe("post-checkout public error mapping", () => {
  it("reports a disabled server feature without exposing internal details", async () => {
    const response = apiError(
      new Error("Post-checkout approval is not currently enabled."),
      400,
      "correlation-disabled",
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Application checkout is not active on the server yet. No payment authorisation was created.",
      code: "POST_APPROVAL_DISABLED",
      correlationId: "correlation-disabled",
    });
  });

  it("gives an actionable response for an existing unfinished application", async () => {
    const response = apiError(
      new Error("You already have an active application for this event. Open your account to continue it."),
      400,
      "correlation-active",
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "You already started an application checkout for this event. Open My Account to continue it.",
      code: "POST_APPROVAL_ALREADY_ACTIVE",
      correlationId: "correlation-active",
    });
  });

  it("distinguishes Stripe session creation failure from an unknown request failure", async () => {
    const response = apiError(
      new Error("CHECKOUT_SESSION_CREATION_FAILED"),
      400,
      "correlation-stripe",
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Stripe could not start the card authorisation. No charge was created.",
      code: "STRIPE_CHECKOUT_SESSION_FAILED",
      correlationId: "correlation-stripe",
    });
  });
});
