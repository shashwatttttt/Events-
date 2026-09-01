"use client";

import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

type DialogOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
};

type PromptOptions = DialogOptions & {
  inputLabel: string;
  defaultValue?: string;
};

type DialogRequest = (DialogOptions & { kind: "confirm" }) | (PromptOptions & { kind: "prompt" });

type DialogApi = {
  confirm: (options: DialogOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
};

const DialogContext = createContext<DialogApi | null>(null);

export function AccessibleDialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<DialogRequest | null>(null);
  const [inputValue, setInputValue] = useState("");
  const resolver = useRef<((value: boolean | string | null) => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const inputId = useId();

  useEffect(() => {
    if (!request) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    queueMicrotask(() => (request.kind === "prompt" ? inputRef.current : cancelRef.current)?.focus());
    return () => { document.body.style.overflow = previousOverflow; };
  }, [request]);

  function open(next: DialogRequest) {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setInputValue(next.kind === "prompt" ? next.defaultValue || "" : "");
    setRequest(next);
  }

  function finish(value: boolean | string | null) {
    const resolve = resolver.current;
    resolver.current = null;
    setRequest(null);
    resolve?.(value);
    queueMicrotask(() => returnFocus.current?.focus());
  }

  function confirm(options: DialogOptions) {
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve as (value: boolean | string | null) => void;
      open({ ...options, kind: "confirm" });
    });
  }

  function prompt(options: PromptOptions) {
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve as (value: boolean | string | null) => void;
      open({ ...options, kind: "prompt" });
    });
  }

  function handleKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      finish(request?.kind === "confirm" ? false : null);
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const controls = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
    ));
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      {children}
      {request && (
        <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) finish(request.kind === "confirm" ? false : null); }}>
          <div
            aria-describedby={descriptionId}
            aria-labelledby={titleId}
            aria-modal="true"
            className="accessible-dialog"
            onKeyDown={handleKeys}
            ref={dialogRef}
            role="dialog"
          >
            <h2 id={titleId}>{request.title}</h2>
            <p id={descriptionId}>{request.description}</p>
            {request.kind === "prompt" && (
              <label htmlFor={inputId}>
                {request.inputLabel}
                <input id={inputId} ref={inputRef} value={inputValue} onChange={(event) => setInputValue(event.target.value)} />
              </label>
            )}
            <div className="dialog-actions">
              <button className="button button-ghost" onClick={() => finish(request.kind === "confirm" ? false : null)} ref={cancelRef} type="button">Cancel</button>
              <button className={request.danger ? "button danger-button" : "button button-primary"} disabled={request.kind === "prompt" && !inputValue.trim()} onClick={() => finish(request.kind === "confirm" ? true : inputValue.trim())} type="button">{request.confirmLabel || "Confirm"}</button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
}

export function useAccessibleDialog() {
  const context = useContext(DialogContext);
  if (!context) throw new Error("useAccessibleDialog must be used within AccessibleDialogProvider");
  return context;
}
