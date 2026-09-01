import { advertisingConsentCookieGranted } from "@/lib/meta/consent";
import type { MetaStandardEvent } from "@/lib/meta/types";

type MetaPixelFunction = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue?: unknown[][];
  loaded?: boolean;
  version?: string;
  push?: (...args: unknown[]) => void;
};

declare global {
  interface Window {
    fbq?: MetaPixelFunction;
    _fbq?: MetaPixelFunction;
    __skieMetaPixelPromise?: Promise<void>;
    __skieMetaPixelId?: string;
  }
}

function installQueue() {
  if (window.fbq) return window.fbq;
  const queue = function (...args: unknown[]) {
    if (queue.callMethod) queue.callMethod(...args);
    else queue.queue?.push(args);
  } as MetaPixelFunction;
  queue.queue = [];
  queue.loaded = true;
  queue.version = "2.0";
  queue.push = queue;
  window.fbq = queue;
  window._fbq = queue;
  return queue;
}

export function ensureMetaPixel(pixelId: string) {
  if (typeof window === "undefined" || !pixelId) return Promise.resolve();
  if (window.__skieMetaPixelPromise) return window.__skieMetaPixelPromise;
  window.__skieMetaPixelPromise = new Promise<void>((resolve, reject) => {
    const fbq = installQueue();
    fbq("consent", "grant");
    fbq("init", pixelId);
    fbq("set", "autoConfig", false, pixelId);
    window.__skieMetaPixelId = pixelId;
    const existing = document.querySelector<HTMLScriptElement>('script[data-skie-meta-pixel="true"]');
    if (existing) {
      if (existing.dataset.loaded === "true") resolve();
      else {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("META_PIXEL_LOAD_FAILED")), { once: true });
      }
      return;
    }
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://connect.facebook.net/en_US/fbevents.js";
    script.dataset.skieMetaPixel = "true";
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("META_PIXEL_LOAD_FAILED")), { once: true });
    document.head.appendChild(script);
  });
  return window.__skieMetaPixelPromise;
}

export function trackMetaBrowserEvent(
  eventName: MetaStandardEvent,
  parameters: Record<string, unknown> = {},
  eventId?: string,
  consentVersion = "2026-07-30",
) {
  if (typeof window === "undefined" || !advertisingConsentCookieGranted(consentVersion)) return;
  const pixelId = window.__skieMetaPixelId || process.env.NEXT_PUBLIC_META_PIXEL_ID || "";
  if (!pixelId) return;
  const send = () => {
    if (!window.fbq) return;
    if (eventId) window.fbq("track", eventName, parameters, { eventID: eventId });
    else window.fbq("track", eventName, parameters);
  };
  if (window.fbq) send();
  else void ensureMetaPixel(pixelId).then(send).catch(() => undefined);
}
