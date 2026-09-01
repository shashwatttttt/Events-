import type { AnalyticsEvent } from "@/types/site";

const prohibitedKey = /(email|phone|address|card|secret|token|password|provider.?payload|raw.?payload|ip.?address|user.?agent)/i;

export function sanitizeAnalyticsText(value: unknown, maximum = 100) {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().replace(/[^A-Za-z0-9 ._:/-]+/g, "").slice(0, maximum);
  return clean || undefined;
}

export function sanitizeAnalyticsMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
    if (prohibitedKey.test(key) || !/^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(key)) continue;
    if (typeof entry === "string") safe[key] = sanitizeAnalyticsText(entry, 200) || "";
    else if (typeof entry === "number" && Number.isFinite(entry)) safe[key] = entry;
    else if (typeof entry === "boolean" || entry === null) safe[key] = entry;
  }
  return safe;
}

export function categorizeReferrer(value: unknown, siteOrigin?: string): AnalyticsEvent["referrerCategory"] {
  if (typeof value !== "string" || !value.trim()) return "direct";
  try {
    const url = new URL(value);
    if (siteOrigin && url.origin === new URL(siteOrigin).origin) return "internal";
    const host = url.hostname.toLowerCase();
    if (/(google|bing|duckduckgo|yahoo)\./.test(host)) return "search";
    if (/(instagram|facebook|tiktok|twitter|x\.com|linkedin)\./.test(host)) return "social";
    if (/(mail|email|newsletter)/.test(host)) return "email";
    return "other";
  } catch { return "other"; }
}

export function categorizeDevice(userAgent: string): AnalyticsEvent["deviceCategory"] {
  if (/ipad|tablet/i.test(userAgent)) return "tablet";
  if (/mobile|iphone|android/i.test(userAgent)) return "mobile";
  return userAgent ? "desktop" : "other";
}

export function categorizeBrowser(userAgent: string): AnalyticsEvent["browserFamily"] {
  if (/edg\//i.test(userAgent)) return "edge";
  if (/firefox\//i.test(userAgent)) return "firefox";
  if (/chrome\//i.test(userAgent)) return "chrome";
  if (/safari\//i.test(userAgent)) return "safari";
  return "other";
}

export function melbourneDate(value: string | Date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}
