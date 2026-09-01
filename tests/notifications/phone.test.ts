import { describe, expect, it } from "vitest";
import { normalizePhoneToE164, redactPhone } from "@/lib/phone";

describe("transactional phone handling", () => {
  it.each([
    ["0412 345 678", "AU", "+61412345678"],
    ["+61 (0) 412 345 678", "AU", "+61412345678"],
    ["0044 7700 900123", "GB", "+447700900123"],
  ])("normalizes %s", (input, country, expected) => {
    expect(normalizePhoneToE164(input, country)).toBe(expected);
  });

  it.each(["", "123", "+012345678", "+1234567890123456"])("rejects invalid number %s", (input) => {
    expect(() => normalizePhoneToE164(input)).toThrow("INVALID_PHONE_NUMBER");
  });

  it("redacts all but a small routing prefix and final digits", () => {
    expect(redactPhone("+61412345678")).toBe("+61***678");
    expect(redactPhone("12")).toBe("redacted");
  });
});
