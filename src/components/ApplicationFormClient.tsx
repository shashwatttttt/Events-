"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ApplicationForm } from "@/types/site";
import { sendAnalytics } from "@/lib/analytics/client";

export function ApplicationFormClient({
  eventId,
  form,
}: {
  eventId: string;
  form: ApplicationForm;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const started = useRef(false);
  const submittingRef = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;

    submittingRef.current = true;
    setBusy(true);
    setMessage("");
    let redirecting = false;

    try {
      const data = new FormData(event.currentTarget);
      const answers: Record<string, string | boolean> = {};

      for (const field of form.fields) {
        answers[field.key] =
          field.type === "checkbox"
            ? data.get(field.key) === "on"
            : String(data.get(field.key) || "").trim();
      }

      const response = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId,
          formId: form.id,
          answers,
          termsAccepted: data.get("termsAccepted") === "on",
          privacyAccepted: data.get("privacyAccepted") === "on",
          entryAccepted: data.get("entryAccepted") === "on",
        }),
      });

      const body = await response.json().catch(() => ({} as { error?: string }));

      if (response.ok) {
        redirecting = true;
        router.push("/account?application=submitted");
        router.refresh();
        return;
      }

      setMessage(body.error || "Could not submit application. Please try again.");
    } catch {
      setMessage("The connection was interrupted. Your application was not lost. Please try again.");
    } finally {
      if (!redirecting) {
        submittingRef.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <form aria-busy={busy} aria-describedby={message ? "application-form-error" : "application-required-note"} className="application-form panel-form" onFocus={() => { if (!started.current) { started.current=true; sendAnalytics("application_started",{deduplicationKey:`${eventId}:${form.id}`,eventId}); } }} onSubmit={submit}>
      <p className="form-intro">{form.intro}</p>
      <p className="form-note" id="application-required-note">Fields marked with an asterisk are required.</p>

      {form.fields.map((field, index) => {
        const key = `${field.id || field.key || "field"}-${index}`;

        if (field.type === "radio") {
          return (
            <fieldset className="radio-field" disabled={busy} key={key}>
              <legend>
                {field.label}
                {field.required ? " *" : ""}
              </legend>
              {field.placeholder && <small>{field.placeholder}</small>}
              <div>
                {field.options.map((option, optionIndex) => (
                  <label className="check-field" key={`${field.key}-${option}-${optionIndex}`}>
                    <input
                      type="radio"
                      name={field.key}
                      value={option}
                      required={field.required}
                    />
                    <span>{option}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          );
        }

        return (
          <label
            key={key}
            className={field.type === "checkbox" ? "check-field" : ""}
          >
            {field.type !== "checkbox" && (
              <span>
                {field.label}
                {field.required ? " *" : ""}
              </span>
            )}

            {field.type === "textarea" ? (
              <textarea
                disabled={busy}
                name={field.key}
                required={field.required}
                placeholder={field.placeholder}
                maxLength={field.maxLength}
              />
            ) : field.type === "select" ? (
              <select disabled={busy} name={field.key} required={field.required} defaultValue="">
                <option value="" disabled>
                  {field.placeholder || "Choose one"}
                </option>

                {field.options.map((option, optionIndex) => (
                  <option key={`${field.key}-${option}-${optionIndex}`}>
                    {option}
                  </option>
                ))}
              </select>
            ) : field.type === "checkbox" ? (
              <>
                <input disabled={busy} type="checkbox" name={field.key} required={field.required} />
                <span>{field.placeholder || field.label}</span>
              </>
            ) : (
              <input
                disabled={busy}
                name={field.key}
                type={field.type === "phone" ? "tel" : field.type}
                required={field.required}
                placeholder={field.placeholder}
                maxLength={field.maxLength}
              />
            )}
          </label>
        );
      })}

      <div className="consent-stack">
        <label className="check-field">
          <input disabled={busy} type="checkbox" name="termsAccepted" required />
          <span>
            I agree to the current Terms & Conditions.
          </span>
        </label>

        <label className="check-field">
          <input disabled={busy} type="checkbox" name="privacyAccepted" required />
          <span>
            I acknowledge the Privacy Policy and how Skie Events handles my application data.
          </span>
        </label>

        <label className="check-field">
          <input disabled={busy} type="checkbox" name="entryAccepted" required />
          <span>I agree to the Entry Policy and venue/security instructions.</span>
        </label>
      </div>

      <button className="button button-primary" disabled={busy}>
        {busy ? "Submitting..." : "Submit application"}
        <span>↗</span>
      </button>

      {message && (
        <p className="form-message is-error" id="application-form-error" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}
