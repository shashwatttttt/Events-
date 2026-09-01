import { describe, expect, it } from "vitest";
import { emailProviderResponseFixture, smsProviderResponseFixture } from "../fixtures";

describe("notification provider fixtures", () => {
  it("use safe synthetic provider identifiers", () => {
    expect(emailProviderResponseFixture()).toEqual({
      providerMessageId: "email_fixture",
      status: "accepted",
    });
    expect(smsProviderResponseFixture()).toEqual({
      providerMessageId: "sms_fixture",
      status: "accepted",
    });
  });

  it("represent retryable failures without raw provider errors", () => {
    expect(emailProviderResponseFixture({
      status: "temporary_failure",
      safeErrorCode: "PROVIDER_TEMPORARY",
    })).not.toHaveProperty("error");
  });
});
