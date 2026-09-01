"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function EventPasswordGate({ slug, title }: { slug: string; title: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/events/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, password: form.get("password") }),
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(body.error || "Access could not be verified.");
      setBusy(false);
      return;
    }
    router.refresh();
  }

  return (
    <section className="auth-page event-password-page">
      <div className="auth-orbit" />
      <div className="auth-panel">
        <p className="eyebrow"><span />Private release</p>
        <h1>{title}</h1>
        <p>This event requires the access password shared by Skie Events.</p>
        <form className="panel-form" onSubmit={submit}>
          <label>
            Event password
            <input type="password" name="password" required autoComplete="off" />
          </label>
          <button className="button button-primary" disabled={busy} type="submit">
            {busy ? "Checking..." : "Enter event"}<span>↗</span>
          </button>
          {error && <p className="form-message is-error" role="alert">{error}</p>}
        </form>
      </div>
    </section>
  );
}
