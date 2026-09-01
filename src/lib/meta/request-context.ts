import { config } from "@/lib/config";
import type { MetaRequestContext } from "@/lib/meta/types";

const META_COOKIE_PATTERN = /^fb\.[0-9]+\.[0-9]+\.[A-Za-z0-9._-]+$/;

function cookieMap(header: string | null) {
  const result = new Map<string, string>();
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = decodeURIComponent(part.slice(index + 1).trim());
    if (key) result.set(key, value);
  }
  return result;
}

function safeMetaCookie(value: string | undefined) {
  return value && META_COOKIE_PATTERN.test(value) ? value.slice(0, 220) : undefined;
}

function safeSourceUrl(value: string | null) {
  if (!value) return config.siteUrl;
  try {
    const source = new URL(value);
    const site = new URL(config.siteUrl);
    if (source.origin !== site.origin) return config.siteUrl;
    source.username = "";
    source.password = "";
    source.hash = "";
    for (const key of [...source.searchParams.keys()]) {
      if (!["utm_source", "utm_medium", "utm_campaign"].includes(key)) source.searchParams.delete(key);
    }
    return source.toString().slice(0, 1000);
  } catch {
    return config.siteUrl;
  }
}

export function readMetaRequestContext(request: Request): MetaRequestContext {
  const cookies = cookieMap(request.headers.get("cookie"));
  const consentGranted = cookies.get("skie_ad_consent") === `granted.${config.metaAdsConsentVersion}`;
  if (!consentGranted) return { consentGranted: false };
  return {
    consentGranted: true,
    fbp: safeMetaCookie(cookies.get("_fbp")),
    fbc: safeMetaCookie(cookies.get("_fbc")),
    eventSourceUrl: safeSourceUrl(request.headers.get("referer")),
  };
}
