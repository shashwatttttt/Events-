import { z } from "zod";

const countryCallingCodes: Record<string, string> = { AU: "61", NZ: "64", US: "1", CA: "1", GB: "44" };

export function normalizePhoneToE164(value: string, defaultCountry = "AU") {
  const raw = value.trim();
  if (!raw) throw new Error("INVALID_PHONE_NUMBER");
  const hasPlus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  let normalized: string;
  if (hasPlus) {
    const knownCode = Object.values(countryCallingCodes).sort((a, b) => b.length - a.length).find((code) => digits.startsWith(`${code}0`));
    normalized = knownCode ? `+${knownCode}${digits.slice(knownCode.length + 1)}` : `+${digits}`;
  }
  else if (digits.startsWith("00")) normalized = `+${digits.slice(2)}`;
  else {
    const callingCode = countryCallingCodes[defaultCountry.toUpperCase()];
    if (!callingCode) throw new Error("UNSUPPORTED_PHONE_COUNTRY");
    normalized = `+${callingCode}${digits.replace(/^0+/, "")}`;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error("INVALID_PHONE_NUMBER");
  return normalized;
}

export function redactPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return "redacted";
  return `+${digits.slice(0, Math.min(2, digits.length - 3))}***${digits.slice(-3)}`;
}

export const e164PhoneSchema = z.string().trim().max(30).transform((value, context) => {
  try {
    return normalizePhoneToE164(value, process.env.NOTIFICATION_DEFAULT_COUNTRY || "AU");
  } catch {
    context.addIssue({ code: "custom", message: "Enter a valid international phone number." });
    return z.NEVER;
  }
});
