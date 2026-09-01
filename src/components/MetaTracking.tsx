"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ensureMetaPixel, trackMetaBrowserEvent } from "@/lib/meta/browser";
import {
  META_CONSENT_EVENT,
  privacySignalBlocksAdvertising,
  readAdvertisingConsent,
  writeAdvertisingConsent,
  type AdvertisingConsentChoice,
} from "@/lib/meta/consent";

export function MetaTracking({ pixelId, consentVersion }: { pixelId: string; consentVersion: string }) {
  const pathname = usePathname();
  const [choice, setChoice] = useState<AdvertisingConsentChoice | null>(null);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [privacyLocked, setPrivacyLocked] = useState(false);
  const lastPageView = useRef("");
  const excluded = pathname.startsWith("/skie-control");

  useEffect(() => {
    setPrivacyLocked(privacySignalBlocksAdvertising());
    const existing = readAdvertisingConsent(consentVersion);
    if (existing?.choice) {
      setChoice(existing.choice);
    }
    const onConsent = (event: Event) => {
      const detail = (event as CustomEvent<{ choice?: AdvertisingConsentChoice }>).detail;
      if (detail?.choice) {
        setChoice(detail.choice);
      } else {
        setChoice(readAdvertisingConsent(consentVersion)?.choice || null);
      }
    };
    window.addEventListener(META_CONSENT_EVENT, onConsent);
    return () => {
      window.removeEventListener(META_CONSENT_EVENT, onConsent);
    };
  }, [consentVersion]);

  useEffect(() => {
    if (excluded || choice !== "granted" || !pixelId) return;
    let cancelled = false;
    void ensureMetaPixel(pixelId).then(() => {
      if (cancelled) return;
      const key = `${pathname}:${window.location.search}`;
      if (lastPageView.current === key) return;
      lastPageView.current = key;
      trackMetaBrowserEvent("PageView", {}, undefined, consentVersion);
      const segments = pathname.split("/").filter(Boolean);
      if (segments.length === 2 && segments[0] === "events") {
        trackMetaBrowserEvent("ViewContent", {
          content_ids: [segments[1]],
          content_type: "product",
          content_name: segments[1],
        }, undefined, consentVersion);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [choice, consentVersion, excluded, pathname, pixelId]);

  if (excluded || !pixelId) return null;
  const showBanner = choice === null || preferencesOpen;

  function decide(next: AdvertisingConsentChoice) {
    try {
      const effective = writeAdvertisingConsent(next, consentVersion);
      setChoice(effective || next);
    } catch {
      setChoice(next);
    }
    setPreferencesOpen(false);
  }

  return (
    <>
      {showBanner && (
        <section className="tracking-consent" aria-label="Privacy choices" role="dialog" aria-live="polite">
          <div>
            <p className="eyebrow"><span />Privacy choices</p>
            <h2>{privacyLocked ? "Advertising tracking is off" : "Help SKIE improve its ads"}</h2>
            <p>
              Essential login, checkout and ticket functions always work. Optional Meta advertising tracking helps us measure which Instagram and Facebook ads lead to event views, applications and completed ticket purchases. We never send application answers, passwords or card details to Meta.
            </p>
            <p><Link href="/privacy">Read the Privacy Policy</Link></p>
          </div>
          <div className="tracking-consent-actions">
            {!privacyLocked && (
              <button
                className="button button-primary"
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  decide("granted");
                }}
              >
                Accept advertising
              </button>
            )}
            <button
              className="button button-ghost"
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                decide("denied");
              }}
            >
              {privacyLocked ? "Keep tracking off" : "Reject optional tracking"}
            </button>
          </div>
        </section>
      )}
      {!showBanner && (
        <button className="tracking-preferences-button" type="button" onClick={() => setPreferencesOpen(true)}>
          Privacy choices
        </button>
      )}
    </>
  );
}
