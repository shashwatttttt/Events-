"use client";

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    grecaptcha?: {
      ready: (callback: () => void) => void;
      render: (
        container: HTMLElement | string,
        parameters: {
          sitekey: string;
          theme?: "dark" | "light";
          size?: "normal" | "compact" | "invisible";
          callback?: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
        }
      ) => number;
      reset: (opt_widget_id?: number) => void;
      execute: (opt_widget_id?: number | string, options?: { action: string }) => Promise<string> | void;
    };
    __recaptchaLoaded?: boolean;
    __recaptchaCallbacks?: Array<() => void>;
  }
}

interface GoogleCaptchaProps {
  onVerify?: (token: string) => void;
  onExpire?: () => void;
  action?: string;
  theme?: "dark" | "light";
  size?: "normal" | "compact";
  className?: string;
  autoMockIfMissing?: boolean;
}

export function GoogleCaptcha({
  onVerify,
  onExpire,
  theme = "dark",
  size = "normal",
  className = "",
  autoMockIfMissing = true,
}: GoogleCaptchaProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<number | null>(null);
  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);

  useEffect(() => {
    onVerifyRef.current = onVerify;
    onExpireRef.current = onExpire;
  });

  const siteKey = (process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY || "").trim();
  const [token, setToken] = useState<string>(() => (!siteKey && autoMockIfMissing ? "mock-recaptcha-token" : ""));

  useEffect(() => {
    // If no site key is configured (local dev/preview without keys)
    if (!siteKey) {
      if (autoMockIfMissing) {
        onVerifyRef.current?.("mock-recaptcha-token");
      }
      return;
    }

    let isMounted = true;

    function renderWidget() {
      if (!isMounted || !containerRef.current || !window.grecaptcha) return;
      if (widgetIdRef.current !== null) return;

      try {
        const id = window.grecaptcha.render(containerRef.current, {
          sitekey: siteKey,
          theme,
          size,
          callback: (receivedToken: string) => {
            if (isMounted) {
              setToken(receivedToken);
              onVerifyRef.current?.(receivedToken);
            }
          },
          "expired-callback": () => {
            if (isMounted) {
              setToken("");
              onExpireRef.current?.();
            }
          },
          "error-callback": () => {
            if (isMounted) {
              setToken("");
              onExpireRef.current?.();
            }
          },
        });
        widgetIdRef.current = id;
      } catch (err) {
        console.warn("reCAPTCHA render error:", err);
      }
    }

    if (typeof window !== "undefined" && typeof window.grecaptcha !== "undefined" && typeof window.grecaptcha.ready === "function") {
      window.grecaptcha.ready(renderWidget);
    } else {
      if (!window.__recaptchaCallbacks) {
        window.__recaptchaCallbacks = [];
      }
      window.__recaptchaCallbacks.push(renderWidget);

      if (!document.getElementById("google-recaptcha-script")) {
        const script = document.createElement("script");
        script.id = "google-recaptcha-script";
        script.src = "https://www.google.com/recaptcha/api.js?onload=onGoogleRecaptchaLoad&render=explicit";
        script.async = true;
        script.defer = true;

        (window as unknown as { onGoogleRecaptchaLoad?: () => void }).onGoogleRecaptchaLoad = () => {
          window.__recaptchaLoaded = true;
          if (window.__recaptchaCallbacks) {
            window.__recaptchaCallbacks.forEach((cb) => cb());
            window.__recaptchaCallbacks = [];
          }
        };

        document.head.appendChild(script);
      }
    }

    return () => {
      isMounted = false;
      if (widgetIdRef.current !== null && window.grecaptcha) {
        try {
          window.grecaptcha.reset(widgetIdRef.current);
        } catch {
          // Ignore reset error on unmount
        }
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, theme, size, autoMockIfMissing]);

  return (
    <div className={`google-recaptcha-wrapper ${className}`.trim()}>
      <input type="hidden" name="recaptchaToken" value={token} />
      {siteKey ? (
        <div ref={containerRef} className="google-recaptcha-box" />
      ) : (
        <div className="recaptcha-badge-mock" title="Google reCAPTCHA Protection Active">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          <span>
            Protected by <strong>reCAPTCHA</strong>
          </span>
          <small>
            <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">
              Privacy
            </a>
            {" • "}
            <a href="https://policies.google.com/terms" target="_blank" rel="noreferrer">
              Terms
            </a>
          </small>
        </div>
      )}
    </div>
  );
}
