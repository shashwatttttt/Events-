"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { safeRedirectPath } from "@/lib/security/redirects";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const search = useSearchParams();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formElement = event.currentTarget;

    setBusy(true);
    setError("");
    setMessage("");

    try {
      const form = new FormData(formElement);
      const payload = Object.fromEntries(form.entries());

      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const body = (await response.json()) as {
        error?: string;
        redirect?: string;
        requiresEmailConfirmation?: boolean;
      };

      if (!response.ok) {
        setError(body.error || "Could not continue.");
        return;
      }

      if (body.requiresEmailConfirmation) {
        setMessage("Account created. Check your email to confirm your address, then log in.");
        formElement.reset();
        return;
      }

      const requestedPath = search.get("next");
      router.replace(safeRedirectPath(requestedPath, safeRedirectPath(body.redirect)));
      router.refresh();
    } catch {
      setError("The request could not be completed. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-busy={busy} aria-describedby={error ? "auth-form-error" : message ? "auth-form-status" : undefined} className="auth-form panel-form" onSubmit={submit}>
      {mode === "signup" && (
        <>
          <div className="form-grid-two">
            <label>
              First name
              <input name="firstName" required maxLength={80} autoComplete="given-name" />
            </label>

            <label>
              Last name
              <input name="lastName" required maxLength={80} autoComplete="family-name" />
            </label>
          </div>

          <div className="form-grid-two">
            <label>
              Phone
              <input name="phone" required placeholder="+61..." maxLength={30} autoComplete="tel" />
            </label>

            <label>
              Instagram
              <input name="instagram" required placeholder="@yourhandle" maxLength={80} autoCapitalize="none" spellCheck={false} />
            </label>
          </div>

          <p className="form-note">Your name, phone and Instagram are required so SKIE can verify applications and contact you about your ticket.</p>

          <label className="checkbox-row">
            <input name="transactionalSmsConsent" type="checkbox" />
            <span>Send me transactional SMS updates about applications, payments, tickets and event changes. Message rates may apply. I can turn this off in my account.</span>
          </label>
        </>
      )}

      <label>
        Email
        <input name="email" type="email" required autoComplete="email" />
      </label>

      <label>
        Password
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />
      </label>

      <button className="button button-primary" disabled={busy} type="submit">
        {busy ? "Working..." : mode === "login" ? "Log in" : "Create account"}
        <span>↗</span>
      </button>

      {error && (
        <p className="form-message is-error" id="auth-form-error" role="alert">
          {error}
        </p>
      )}

      {message && (
        <p className="form-message" id="auth-form-status" role="status">
          {message}
        </p>
      )}

      <p className="auth-switch">
        {mode === "login" ? (
          <>
            No account? <Link href={search.get("next") ? `/signup?next=${encodeURIComponent(safeRedirectPath(search.get("next")))}` : "/signup"}>Create one</Link>
          </>
        ) : (
          <>
            Already registered? <Link href={search.get("next") ? `/login?next=${encodeURIComponent(safeRedirectPath(search.get("next")))}` : "/login"}>Log in</Link>
          </>
        )}
      </p>
    </form>
  );
}
