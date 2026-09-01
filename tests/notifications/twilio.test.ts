import { afterEach, describe, expect, it, vi } from "vitest";
import { TwilioTextProvider } from "@/lib/notifications/provider";
import { mapTwilioDeliveryStatus, twilioSignature, verifyTwilioSignature } from "@/lib/notifications/twilio";

describe("Twilio notification adapter", () => {
  afterEach(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_FROM_NUMBER;
  });

  it("does not call Twilio without complete configuration", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const result = await new TwilioTextProvider().send({ channel: "sms", to: "+61412345678", message: { text: "Fixture" }, idempotencyKey: "fixture" });
    expect(result).toEqual({ status: "permanent_failure", safeErrorCode: "SMS_PROVIDER_CONFIGURATION" });
    expect(network).not.toHaveBeenCalled();
  });

  it("constructs a form request and retains only the provider identifier", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACfixture";
    process.env.TWILIO_AUTH_TOKEN = "test-token-not-live";
    process.env.TWILIO_FROM_NUMBER = "+15005550006";
    const network = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      void _input; void _init;
      return new Response(JSON.stringify({ sid: "SM12345678901234567890123456789012", ignored_secret: "never-returned" }), { status: 201 });
    });
    vi.stubGlobal("fetch", network);
    const result = await new TwilioTextProvider().send({ channel: "sms", to: "+61412345678", message: { text: "Fixture" }, idempotencyKey: "fixture-key" });
    expect(result).toEqual({ status: "accepted", providerMessageId: "SM12345678901234567890123456789012" });
    expect(network).toHaveBeenCalledOnce();
    const [, init] = network.mock.calls[0];
    expect(String(init?.body)).toContain("To=%2B61412345678");
    expect(String(init?.body)).toContain("Body=Fixture");
    expect(init?.headers).toMatchObject({
      Authorization: expect.stringMatching(/^Basic /),
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(init?.headers).not.toHaveProperty("Idempotency-Key");
  });

  it("stops automatic retries when the provider outcome is ambiguous", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACfixture";
    process.env.TWILIO_AUTH_TOKEN = "test-token-not-live";
    process.env.TWILIO_FROM_NUMBER = "+15005550006";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("timeout"); }));

    await expect(new TwilioTextProvider().send({
      channel: "sms",
      to: "+61412345678",
      message: { text: "Fixture" },
      idempotencyKey: "fixture-key",
    })).resolves.toEqual({ status: "permanent_failure", safeErrorCode: "SMS_PROVIDER_OUTCOME_UNKNOWN" });
  });

  it("verifies signatures without exposing the signing token", () => {
    const url = "https://staging.example.test/api/webhooks/twilio/status";
    const params = { MessageSid: "SMfixture", MessageStatus: "delivered" };
    const signature = twilioSignature(url, params, "test-token");
    expect(verifyTwilioSignature(url, params, signature, "test-token")).toBe(true);
    expect(verifyTwilioSignature(url, params, "invalid", "test-token")).toBe(false);
    expect(mapTwilioDeliveryStatus("delivered")).toBe("delivered");
    expect(mapTwilioDeliveryStatus("undelivered")).toBe("failed");
  });
});
