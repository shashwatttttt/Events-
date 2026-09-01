"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { customerFormTargetAt, type PostCheckoutApplication } from "@/lib/post-approval/types";

function answerPresent(value: string | boolean | number | undefined) {
  return value === true || typeof value === "number" || (typeof value === "string" && value.trim().length > 0);
}

function initialAnswers(application: PostCheckoutApplication) {
  return { ...application.draftAnswers, ...(application.submittedAnswers || {}) };
}

function inputValue(value: string | boolean | number | undefined) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function PostCheckoutApplicationClient({
  initialApplication,
  eventTitle,
}: {
  initialApplication: PostCheckoutApplication;
  eventTitle: string;
}) {
  const router = useRouter();
  const [application, setApplication] = useState(initialApplication);
  const [answers, setAnswers] = useState<Record<string, string | boolean | number>>(() => initialAnswers(initialApplication));
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const latestAnswers = useRef(answers);
  const stateVersion = useRef(initialApplication.stateVersion);
  const submittingRef = useRef(false);
  const [lastSavedHash, setLastSavedHash] = useState(() => JSON.stringify(initialAnswers(initialApplication)));
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const paymentNotRequired = application.paymentStatus === "not_required";
  const editable = ["awaiting_form", "draft"].includes(application.status)
    && ["authorized", "not_required"].includes(application.paymentStatus);
  const customerTargetAt = useMemo(() => customerFormTargetAt(application), [application]);

  useEffect(() => { latestAnswers.current = answers; }, [answers]);

  useEffect(() => {
    if (application.paymentStatus !== "authorization_pending") return;
    const timer = window.setTimeout(() => window.location.reload(), 3_000);
    return () => window.clearTimeout(timer);
  }, [application.paymentStatus]);

  const completion = useMemo(() => {
    const required = application.formSnapshot.fields.filter((field) => field.required);
    const answered = required.filter((field) => answerPresent(answers[field.key])).length;
    return required.length ? Math.round((answered / required.length) * 100) : 100;
  }, [answers, application.formSnapshot.fields]);

  const requiredComplete = useMemo(
    () => application.formSnapshot.fields.every((field) => !field.required || answerPresent(answers[field.key])),
    [answers, application.formSnapshot.fields],
  );

  const dirty = editable && JSON.stringify(answers) !== lastSavedHash;

  const saveNow = useCallback(async (keepalive = false) => {
    if (!editable || submittingRef.current) return;
    const payloadAnswers = latestAnswers.current;
    const hash = JSON.stringify(payloadAnswers);
    if (hash === lastSavedHash) return;
    setSaving(true);
    try {
      const response = await fetch("/api/post-checkout/application", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        keepalive,
        body: JSON.stringify({
          action: "save",
          orderId: application.orderId,
          expectedStateVersion: stateVersion.current,
          answers: payloadAnswers,
        }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; saved?: { stateVersion?: number; savedAt?: string } };
      if (!response.ok) throw new Error(body.error || "Your application could not be saved.");
      if (body.saved?.stateVersion) stateVersion.current = body.saved.stateVersion;
      setLastSavedHash(hash);
      setMessage(body.saved?.savedAt ? `Saved ${new Date(body.saved.savedAt).toLocaleTimeString()}` : "Saved");
      setApplication((current) => ({ ...current, status: "draft", stateVersion: stateVersion.current, completionPercentage: completion }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Your application could not be saved.");
      throw error;
    } finally {
      setSaving(false);
    }
  }, [application.orderId, completion, editable, lastSavedHash]);

  const queueSave = useCallback((keepalive = false) => {
    if (submittingRef.current) return saveChain.current.catch(() => undefined);
    saveChain.current = saveChain.current.catch(() => undefined).then(() => saveNow(keepalive));
    return saveChain.current;
  }, [saveNow]);

  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => { void queueSave(); }, 900);
    return () => window.clearTimeout(timer);
  }, [answers, dirty, queueSave]);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!editable) return;
      event.preventDefault();
      event.returnValue = true;
    }
    function pageHide() {
      if (dirty) void queueSave(true);
    }
    function visibilityChange() {
      if (document.visibilityState === "hidden" && dirty) void queueSave(true);
    }
    function interceptInternalNavigation(event: MouseEvent) {
      if (!editable) return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(target instanceof HTMLAnchorElement)) return;
      const destination = new URL(target.href, window.location.href);
      if (destination.origin !== window.location.origin || destination.href === window.location.href) return;
      const leave = window.confirm("Your mandatory application is incomplete. No ticket can be issued until it is submitted and approved. Leave this page?");
      if (!leave) {
        event.preventDefault();
        event.stopPropagation();
      } else if (dirty) {
        void queueSave(true);
      }
    }
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", pageHide);
    document.addEventListener("visibilitychange", visibilityChange);
    document.addEventListener("click", interceptInternalNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", pageHide);
      document.removeEventListener("visibilitychange", visibilityChange);
      document.removeEventListener("click", interceptInternalNavigation, true);
    };
  }, [dirty, editable, queueSave]);

  function setAnswer(key: string, value: string | boolean) {
    if (submittingRef.current) return;
    setAnswers((current) => ({ ...current, [key]: value }));
    setMessage("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || !requiredComplete || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setMessage("");
    try {
      await saveChain.current.catch(() => undefined);
      const submittedAnswers = { ...latestAnswers.current };
      const response = await fetch("/api/post-checkout/application", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "submit",
          orderId: application.orderId,
          expectedStateVersion: stateVersion.current,
          answers: submittedAnswers,
        }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; submitted?: { stateVersion?: number } };
      if (!response.ok) throw new Error(body.error || "Your application could not be submitted.");
      if (body.submitted?.stateVersion) stateVersion.current = body.submitted.stateVersion;
      setLastSavedHash(JSON.stringify(submittedAnswers));
      setApplication((current) => ({ ...current, status: "submitted", completionPercentage: completion, stateVersion: stateVersion.current }));
      setMessage(paymentNotRequired
        ? "Application submitted. No ticket is issued unless SKIE approves it."
        : "Application submitted. Your payment remains authorised while SKIE reviews it.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Your application could not be submitted.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (application.paymentStatus === "authorization_pending") {
    return <div className="application-form panel-form" role="status"><h2>Confirming payment authorisation</h2><p>Keep this page open. The mandatory application will unlock after Stripe confirms the temporary card authorisation.</p><button className="button button-primary" type="button" onClick={() => window.location.reload()}>Check again</button></div>;
  }

  if (!editable) {
    return <div className="application-form panel-form" role="status"><p className="eyebrow"><span aria-hidden="true" />Application status</p><h2>{application.status === "submitted" || application.status === "under_review" ? "Application under review" : application.status.replaceAll("_", " ")}</h2><p>{paymentNotRequired
      ? "No payment is required for this ticket-only guest-list application. No ticket is available until SKIE approves the application and fulfilment completes."
      : <>Your payment status is <strong>{application.paymentStatus.replaceAll("_", " ")}</strong>. No ticket is available until approval, successful payment capture and fulfilment.</>}</p>{message && <p className="form-message">{message}</p>}</div>;
  }

  return (
    <form className="application-form panel-form post-checkout-application" onSubmit={submit} aria-busy={saving || submitting}>
      <div className="post-checkout-critical-note" role="alert">
        <p className="eyebrow"><span aria-hidden="true" />One final step required</p>
        <h2>Complete this mandatory application</h2>
        <p>{paymentNotRequired
          ? `No payment is required for this ticket-only guest-list request. No ${eventTitle} ticket or QR code will be issued until this form is submitted and SKIE approves your application.`
          : `Your payment is authorised, not yet captured. No ${eventTitle} ticket or QR code will be issued until this form is submitted and SKIE approves your application.`}</p>
      </div>
      <ol className="post-checkout-progress" aria-label="Ticket progress">
        <li className="is-complete">Ticket selected</li>
        <li className="is-complete">{paymentNotRequired ? "No payment required" : "Payment authorised"}</li>
        <li className="is-current">Mandatory application</li>
        <li>SKIE review</li>
        <li>Ticket issued</li>
      </ol>
      <div className="post-checkout-form-meta">
        <strong>{completion}% complete</strong>
        <span>Complete by: {new Date(customerTargetAt).toLocaleString("en-AU")}</span>
        <span aria-live="polite">{saving ? "Saving…" : message || "Answers save automatically"}</span>
      </div>
      <div className="post-checkout-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={completion}><span style={{ width: `${completion}%` }} /></div>
      <p className="form-intro">{application.formSnapshot.intro}</p>
      <p className="form-note">{paymentNotRequired
        ? "Fields marked with an asterisk are required. Submit the form as soon as possible so SKIE can approve or reject the guest-list request before the application window closes."
        : "Fields marked with an asterisk are required. Your saved form may remain available after the completion target while the payment authorisation is still valid, but submit it as soon as possible."}</p>

      {application.formSnapshot.fields.map((field) => {
        if (field.type === "radio") {
          return <fieldset className="radio-field" key={field.id} disabled={submitting}><legend>{field.label}{field.required ? " *" : ""}</legend>{field.placeholder && <small>{field.placeholder}</small>}<div>{field.options.map((option) => <label className="check-field" key={`${field.id}-${option}`}><input type="radio" name={field.key} value={option} checked={answers[field.key] === option} required={field.required} onChange={() => setAnswer(field.key, option)} /><span>{option}</span></label>)}</div></fieldset>;
        }
        return <label key={field.id} className={field.type === "checkbox" ? "check-field" : ""}>
          {field.type !== "checkbox" && <span>{field.label}{field.required ? " *" : ""}</span>}
          {field.type === "textarea" ? <textarea name={field.key} required={field.required} disabled={submitting} placeholder={field.placeholder} maxLength={field.maxLength} value={inputValue(answers[field.key])} onChange={(change) => setAnswer(field.key, change.target.value)} />
            : field.type === "select" ? <select name={field.key} required={field.required} disabled={submitting} value={inputValue(answers[field.key])} onChange={(change) => setAnswer(field.key, change.target.value)}><option value="" disabled>{field.placeholder || "Choose one"}</option>{field.options.map((option) => <option key={`${field.id}-${option}`} value={option}>{option}</option>)}</select>
              : field.type === "checkbox" ? <><input type="checkbox" name={field.key} required={field.required} disabled={submitting} checked={answers[field.key] === true} onChange={(change) => setAnswer(field.key, change.target.checked)} /><span>{field.placeholder || field.label}</span></>
                : <input name={field.key} type={field.type === "phone" ? "tel" : field.type} required={field.required} disabled={submitting} placeholder={field.placeholder} maxLength={field.maxLength} value={inputValue(answers[field.key])} onChange={(change) => setAnswer(field.key, change.target.value)} />}
        </label>;
      })}

      <button className="button button-primary" disabled={submitting || saving || !requiredComplete}>
        {submitting ? "Submitting…" : "Submit mandatory application"}<span aria-hidden="true">↗</span>
      </button>
      <p className="form-note">Submitting sends the application for review. It does not issue a ticket or guarantee entry.</p>
      {message && <p className={message.startsWith("Application submitted") || message.startsWith("Saved") ? "form-message" : "form-message is-error"} role="status">{message}</p>}
    </form>
  );
}
