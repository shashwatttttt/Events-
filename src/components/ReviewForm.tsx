"use client";

import { FormEvent, useState } from "react";
import { GoogleCaptcha } from "@/components/GoogleCaptcha";

export function ReviewForm() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        rating: Number(form.get("rating")),
        body: form.get("body"),
        recaptchaToken: captchaToken || undefined,
      }),
    });
    const result = await response.json();
    setMessage(
      response.ok
        ? "Review submitted for moderation."
        : result.error || "Could not submit review."
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
          <input name="name" required maxLength={80} placeholder="Your name" />
        </label>
        <label>
          Rating
          <select name="rating" defaultValue="5">
            <option value="5">5 — Unreal</option>
            <option value="4">4 — Loved it</option>
            <option value="3">3 — Solid</option>
            <option value="2">2 — Needs work</option>
            <option value="1">1 — Not for me</option>
          </select>
        </label>
      </div>

      <label>
        Review
        <textarea
          name="body"
          required
          minLength={10}
          maxLength={1000}
          placeholder="Tell us what the night felt like..."
        />
      </label>

      <p className="form-note">
        Reviews enter moderation first. Only approved reviews appear publicly.
      </p>

      <GoogleCaptcha onVerify={setCaptchaToken} action="review" />

      <button className="button button-primary" type="submit" disabled={busy}>
        {busy ? "Submitting..." : "Submit review"}
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

