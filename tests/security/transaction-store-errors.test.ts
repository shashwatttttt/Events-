import { describe, expect, it } from "vitest";
import { apiError } from "@/lib/http";

function transactionError(code: string) {
  return Object.assign(new Error("opaque database wrapper"), {
    name: "TransactionStoreError",
    code,
  });
}

describe("transaction store API errors", () => {
  it("preserves a customer ticket limit failure from the structured error code", async () => {
    const response = apiError(
      transactionError("CUSTOMER_TICKET_LIMIT_EXCEEDED"),
      400,
      "correlation-limit",
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This account has reached its ticket limit for the event.",
      code: "CUSTOMER_TICKET_LIMIT_EXCEEDED",
      correlationId: "correlation-limit",
    });
  });

  it("reports event capacity without exposing database details", async () => {
    const response = apiError(
      transactionError("EVENT_CAPACITY_EXCEEDED"),
      400,
      "correlation-capacity",
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "The remaining public event capacity is not enough for this order.",
      code: "EVENT_CAPACITY_EXCEEDED",
      correlationId: "correlation-capacity",
    });
  });

  it("keeps unknown transaction failures generic", async () => {
    const response = apiError(
      transactionError("UNEXPECTED_PRIVATE_DATABASE_DETAIL"),
      400,
      "correlation-private",
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "The request could not be completed.",
      code: "REQUEST_FAILED",
      correlationId: "correlation-private",
    });
  });
});
