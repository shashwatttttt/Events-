"use client";

import { FormEvent, useState } from "react";
import { GoogleCaptcha } from "@/components/GoogleCaptcha";

export function NewsletterForm() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/newsletter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: form.get("email"),
        recaptchaToken: captchaToken || undefined,
      }),
    });
    const body = await response.json();
    setMessage(
      response.ok ? "You are on the list." : body.error || "Could not subscribe."
    );
    if (response.ok) {
      event.currentTarget.reset();
    }
    setBusy(false);
  }

  return (
    <form className="newsletter-form" onSubmit={submit}>
      <label>
        <span>Skie updates</span>
        <div>
          <input type="email" name="email" required placeholder="Email address" />
          <button type="submit" disabled={busy}>
            {busy ? "…" : "JOIN ↗"}
          </button>
        </div>
      </label>
      <GoogleCaptcha onVerify={setCaptchaToken} action="newsletter" size="compact" />
      {message && <small role="status">{message}</small>}
    </form>
  );
}

