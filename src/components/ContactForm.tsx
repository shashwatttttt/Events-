"use client";

import { FormEvent, useState } from "react";
import { GoogleCaptcha } from "@/components/GoogleCaptcha";

export function ContactForm() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    if (captchaToken) {
      payload.recaptchaToken = captchaToken;
    }

    const response = await fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    setMessage(
      response.ok
        ? "Message received. The Skie team will reply soon."
        : body.error || "Could not send message."
    );
    if (response.ok) {
      event.currentTarget.reset();
    }
    setBusy(false);
  }

  return (
    <form className="panel-form" onSubmit={submit}>
      <div className="form-grid-two">
        <label>
          Name
          <input name="name" required maxLength={120} placeholder="Your name" />
        </label>
        <label>
          Email
          <input name="email" type="email" required maxLength={254} placeholder="you@example.com" />
        </label>
      </div>

      <label>
        What is this about?
        <select name="subject" defaultValue="General">
          <option>General</option>
          <option>Sponsorship</option>
          <option>Artist / DJ</option>
          <option>Venue</option>
          <option>Press / media</option>
        </select>
      </label>

      <label>
        Message
        <textarea
          name="message"
          required
          minLength={10}
          maxLength={4000}
          placeholder="Tell the Skie team what you need..."
        />
      </label>

      <GoogleCaptcha onVerify={setCaptchaToken} action="contact" />

      <button className="button button-primary" type="submit" disabled={busy}>
        {busy ? "Sending..." : "Send message"}
        <span>↗</span>
      </button>

      {message && (
        <p className="form-message" role="status">
          {message}
        </p>
      )}
    </form>
  );
}

