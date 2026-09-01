export type AdvertisingConsentChoice = "granted" | "denied";

export const META_CONSENT_STORAGE_KEY = "skie_advertising_consent";
export const META_CONSENT_COOKIE = "skie_ad_consent";
export const META_CONSENT_EVENT = "skie:advertising-consent";

export type AdvertisingConsentRecord = {
  choice: AdvertisingConsentChoice;
  version: string;
  updatedAt: string;
};

export function privacySignalBlocksAdvertising() {
  if (typeof navigator === "undefined") return false;
  const extended = navigator as Navigator & { globalPrivacyControl?: boolean };
  return extended.globalPrivacyControl === true || navigator.doNotTrack === "1";
}

export function readAdvertisingConsent(version: string): AdvertisingConsentRecord | null {
  if (typeof window === "undefined") return null;
  if (privacySignalBlocksAdvertising()) {
    return { choice: "denied", version, updatedAt: new Date().toISOString() };
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(META_CONSENT_STORAGE_KEY) || "null") as AdvertisingConsentRecord | null;
    if (parsed && parsed.version === version && ["granted", "denied"].includes(parsed.choice)) {
      return parsed;
    }
  } catch {
    // Ignore localStorage access failures in restricted iframes
  }

  try {
    if (typeof document !== "undefined" && document.cookie) {
      const match = document.cookie.match(new RegExp(`(?:^|; )${META_CONSENT_COOKIE}=([^;]*)`));
      if (match) {
        const [cookieChoice, cookieVer] = decodeURIComponent(match[1]).split(".");
        if (cookieVer === version && (cookieChoice === "granted" || cookieChoice === "denied")) {
          return { choice: cookieChoice, version, updatedAt: new Date().toISOString() };
        }
      }
    }
  } catch {
    // Ignore cookie read failures
  }

  return null;
}

function expireMetaCookies() {
  try {
    const hostname = typeof location !== "undefined" ? location.hostname : "";
    const skieDomain = hostname === "skieevents.com" || hostname.endsWith(".skieevents.com")
      ? ".skieevents.com"
      : "";
    for (const name of ["_fbp", "_fbc"]) {
      document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
      if (skieDomain) document.cookie = `${name}=; Max-Age=0; Path=/; Domain=${skieDomain}; SameSite=Lax`;
    }
  } catch {
    // Ignore cookie expiration failures
  }
}

function consentCookieValue(choice: AdvertisingConsentChoice, version: string) {
  return `${choice}.${version}`;
}

export function writeAdvertisingConsent(choice: AdvertisingConsentChoice, version: string) {
  if (typeof window === "undefined") return "denied" as const;
  const effectiveChoice = privacySignalBlocksAdvertising() ? "denied" : choice;
  const record: AdvertisingConsentRecord = {
    choice: effectiveChoice,
    version,
    updatedAt: new Date().toISOString(),
  };

  try {
    localStorage.setItem(META_CONSENT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Ignore localStorage write failures in restricted contexts
  }

  try {
    const isHttps = typeof location !== "undefined" && location.protocol === "https:";
    const secureFlag = isHttps ? "; Secure" : "";
    document.cookie = `${META_CONSENT_COOKIE}=${consentCookieValue(effectiveChoice, version)}; Max-Age=${180 * 24 * 60 * 60}; Path=/; SameSite=Lax${secureFlag}`;
  } catch {
    // Ignore cookie write failures
  }

  try {
    if (effectiveChoice === "denied") {
      expireMetaCookies();
      window.fbq?.("consent", "revoke");
    } else {
      window.fbq?.("consent", "grant");
    }
  } catch {
    // Ignore fbq failures
  }

  try {
    window.dispatchEvent(new CustomEvent(META_CONSENT_EVENT, { detail: record }));
  } catch {
    // Ignore event dispatch failures
  }

  return effectiveChoice;
}

export function advertisingConsentCookieGranted(version: string) {
  if (typeof document === "undefined" || privacySignalBlocksAdvertising()) return false;
  const expected = `${META_CONSENT_COOKIE}=${consentCookieValue("granted", version)}`;
  return document.cookie.split(";").some((part) => part.trim() === expected);
}

export function advertisingConsentGranted(version: string) {
  return readAdvertisingConsent(version)?.choice === "granted" && advertisingConsentCookieGranted(version);
}
