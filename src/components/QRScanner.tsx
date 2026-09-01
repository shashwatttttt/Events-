"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EventItem } from "@/types/site";

type EntitlementSummary = {
  id: string;
  name: string;
  quantityRemaining: number;
  status: string;
};

type TicketSummary = {
  id: string;
  eventId: string;
  holderName: string;
  holderEmail?: string;
  ticketCode: string;
  status: string;
  checkedInAt?: string;
  entitlements?: EntitlementSummary[];
};

type ScanResult = {
  result: string;
  ticket?: TicketSummary | null;
  entitlements?: EntitlementSummary[];
};

function parsePayload(value: string) {
  try {
    const url = new URL(value);
    return {
      ticketId: url.searchParams.get("ticket") || "",
      token: url.searchParams.get("token") || "",
    };
  } catch {
    const [ticketId, token] = value.split("|");
    return { ticketId: ticketId || "", token: token || "" };
  }
}

export function QRScanner({ events }: { events: EventItem[] }) {
  const [eventId, setEventId] = useState(events[0]?.id || "");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [manual, setManual] = useState("");
  const [search, setSearch] = useState("");
  const [matches, setMatches] = useState<TicketSummary[]>([]);
  const [message, setMessage] = useState("");
  const [active, setActive] = useState(false);
  const scannerRef = useRef<{ clear: () => Promise<void> } | null>(null);

  const submit = useCallback(
    async (decoded: string) => {
      const parsed = parsePayload(decoded);
      if (!parsed.ticketId || !parsed.token) {
        setResult({ result: "invalid" });
        return;
      }
      const response = await fetch("/api/check-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...parsed, eventId }),
      });
      const body = (await response.json()) as ScanResult & { error?: string };
      setMessage(response.ok ? "" : body.error || "Could not verify ticket.");
      setResult(response.ok ? body : { result: "invalid" });
    },
    [eventId],
  );

  const searchTickets = useCallback(async () => {
    if (search.trim().length < 2) {
      setMatches([]);
      setMessage("Enter at least two characters.");
      return;
    }
    const response = await fetch(
      `/api/check-in?q=${encodeURIComponent(search.trim())}&eventId=${encodeURIComponent(eventId)}`,
      { cache: "no-store" },
    );
    const body = (await response.json()) as { tickets?: TicketSummary[]; error?: string };
    setMatches(body.tickets || []);
    setMessage(response.ok ? "" : body.error || "Search failed.");
  }, [eventId, search]);

  const manualCheckIn = useCallback(
    async (ticketId: string) => {
      const response = await fetch("/api/check-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId, eventId, manual: true }),
      });
      const body = (await response.json()) as ScanResult & { error?: string };
      setMessage(response.ok ? "" : body.error || "Manual check-in failed.");
      if (response.ok) {
        setResult(body);
        await searchTickets();
      }
    },
    [eventId, searchTickets],
  );

  const redeem = useCallback(async (entitlementId: string) => {
    const response = await fetch("/api/entitlements/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entitlementId, eventId, quantity: 1, operationId: crypto.randomUUID() }),
    });
    const body = (await response.json()) as EntitlementSummary & { error?: string };
    if (!response.ok) {
      setMessage(body.error || "Could not redeem this event extra.");
      return;
    }
    setResult((current) => current
      ? {
          ...current,
          entitlements: (current.entitlements || []).map((item) =>
            item.id === entitlementId
              ? { ...item, quantityRemaining: body.quantityRemaining, status: body.status }
              : item,
          ),
        }
      : current,
    );
    setMessage(`${body.name} redeemed. ${body.quantityRemaining} remaining.`);
  }, [eventId]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void import("html5-qrcode").then(({ Html5QrcodeScanner }) => {
      if (cancelled) return;
      const scanner = new Html5QrcodeScanner(
        "skie-qr-reader",
        { fps: 10, qrbox: { width: 260, height: 260 }, rememberLastUsedCamera: true },
        false,
      );
      scannerRef.current = scanner;
      scanner.render((decoded) => void submit(decoded), () => {});
    });
    return () => {
      cancelled = true;
      void scannerRef.current?.clear().catch(() => {});
      scannerRef.current = null;
    };
  }, [active, submit]);

  return (
    <div className="scanner-panel" aria-busy={active && !result}>
      <div className="scanner-controls">
        <label>
          Current event
          <select value={eventId} onChange={(changeEvent) => setEventId(changeEvent.target.value)}>
            {events.map((event) => <option value={event.id} key={event.id}>{event.title}</option>)}
          </select>
        </label>
        <button className="button button-primary" type="button" onClick={() => setActive((value) => !value)}>
          {active ? "Stop camera" : "Start camera"}
        </button>
      </div>

      {active && <div id="skie-qr-reader" className="qr-reader" aria-label="Camera QR scanner" />}

      <div className="manual-scan">
        <label>
          Manual QR URL or code
          <input aria-describedby="manual-scan-help" value={manual} onChange={(changeEvent) => setManual(changeEvent.target.value)} placeholder="Paste scanned QR value" />
        </label>
        <button className="button button-ghost" onClick={() => void submit(manual)} type="button">Verify manually</button>
        <small className="sr-only" id="manual-scan-help">Paste the full QR URL or the ticket ID and token separated by a vertical bar.</small>
      </div>

      <div className="manual-scan">
        <label>
          Search attendee
          <input value={search} onChange={(changeEvent) => setSearch(changeEvent.target.value)} placeholder="Name, email or ticket code" />
        </label>
        <button className="button button-ghost" onClick={() => void searchTickets()} type="button">Search</button>
      </div>

      {matches.length > 0 && (
        <div className="door-search-results">
          {matches.map((ticket) => (
            <article key={ticket.id}>
              <div>
                <strong>{ticket.holderName}</strong>
                <span>{ticket.holderEmail}</span>
                <small>{ticket.ticketCode} - {ticket.status.replaceAll("_", " ")}</small>
              </div>
              <button
                className="button button-ghost"
                type="button"
                disabled={ticket.status !== "valid"}
                onClick={() => void manualCheckIn(ticket.id)}
              >
                Manual check-in
              </button>
            </article>
          ))}
        </div>
      )}

      {result && (
        <div className={`scan-result scan-${result.result}`} role="status" aria-live="assertive" aria-atomic="true">
          <strong><span className="sr-only">Scan result: </span>{result.result.replaceAll("_", " ").toUpperCase()}</strong>
          {result.ticket && (
            <>
              <span>{result.ticket.holderName}</span>
              <small>{result.ticket.ticketCode}</small>
            </>
          )}
          {(result.entitlements || []).length > 0 && (
            <div className="scan-entitlements">
              <b>Event extras</b>
              {(result.entitlements || []).map((item) => (
                <div key={item.id}>
                  <span>{item.name}</span>
                  <small>{item.quantityRemaining} remaining</small>
                  <button
                    type="button"
                    disabled={item.quantityRemaining < 1}
                    onClick={() => void redeem(item.id)}
                  >
                    Redeem 1
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {message && <p className="form-message" role="alert">{message}</p>}
    </div>
  );
}
