"use client";

import { FormEvent, useRef, useState } from "react";
import { isSalesWindowOpen } from "@/lib/event-state";
import { moneyCents, safeUrl } from "@/lib/format";
import { POST_CHECKOUT_MODE } from "@/lib/post-approval/types";
import type { EventItem, EventProduct, EventTicketType, TicketAllocation } from "@/types/site";

type CheckoutFailure = {
  code?: string;
  correlationId?: string;
};

type AppliedPromoQuote = {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  code: string;
  trackingOnly: boolean;
  guestlistApplication: boolean;
};

export function CheckoutBuilder({
  event,
  allocation,
  products,
}: {
  event: EventItem;
  allocation?: TicketAllocation;
  products: EventProduct[];
}) {
  const availableTicketTypes = event.ticketTypes.filter((item) => (
    isSalesWindowOpen(item)
    && (!allocation || item.id === allocation.ticketTypeId)
  ));
  const [selectedTicketTypeId, setSelectedTicketTypeId] = useState(
    allocation?.ticketTypeId || availableTicketTypes[0]?.id || "",
  );
  const ticketType = availableTicketTypes.find((item) => item.id === selectedTicketTypeId)
    || availableTicketTypes[0];

  function maximumForTicketType(type: EventTicketType) {
    if (allocation) {
      return Math.max(0, allocation.maxQuantity - allocation.purchasedQuantity);
    }
    return Math.max(0, Math.min(event.defaultTicketLimit, type.defaultMaxPerCustomer));
  }

  const max = ticketType ? maximumForTicketType(ticketType) : 0;
  const postCheckoutApproval = String(event.ticketMode) === POST_CHECKOUT_MODE;
  const [quantity, setQuantity] = useState(1);
  const [extras, setExtras] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState("");
  const [failure, setFailure] = useState<CheckoutFailure>({});
  const [promoCode, setPromoCode] = useState("");
  const [appliedPromo, setAppliedPromo] = useState("");
  const [promoBusy, setPromoBusy] = useState(false);
  const [quote, setQuote] = useState<AppliedPromoQuote | null>(null);
  const [approvalConsents, setApprovalConsents] = useState({
    authorization: false,
    terms: false,
    privacy: false,
    entry: false,
    age: false,
  });
  const ticketPriceCents = ticketType?.priceCents || 0;
  const subtotal = quantity * ticketPriceCents + products.reduce(
    (sum, product) => sum + (extras[product.id] || 0) * product.priceCents,
    0,
  );
  const normalizedPromoCode = promoCode.trim().toUpperCase();
  const promoNeedsApply = Boolean(normalizedPromoCode)
    && (!quote || appliedPromo !== normalizedPromoCode || quote.code !== normalizedPromoCode);
  const totalCents = quote?.totalCents ?? subtotal;
  const guestlistApplication = quote?.guestlistApplication === true;
  const guestlistNoPayment = guestlistApplication && totalCents === 0;

  if (!ticketType) {
    return <p className="form-message is-error" role="status">Ticket type unavailable.</p>;
  }

  if (max < 1) {
    return <p className="form-message is-error" role="status">This ticket allocation has been used in full.</p>;
  }

  function clearFailure() {
    setError("");
    setFailure({});
  }

  function selectTicketType(type: EventTicketType) {
    const nextMaximum = maximumForTicketType(type);
    setSelectedTicketTypeId(type.id);
    setQuantity((current) => Math.max(1, Math.min(current, nextMaximum)));
    setQuote(null);
    setAppliedPromo("");
    clearFailure();
  }

  function checkoutPayload(code?: string) {
    return {
      eventId: event.id,
      allocationId: allocation?.id,
      ticketTypeId: ticketType!.id,
      ticketQuantity: quantity,
      products: Object.entries(extras)
        .filter(([, value]) => value > 0)
        .map(([productId, value]) => ({ productId, quantity: value })),
      expectedSubtotalCents: subtotal,
      ...(code && quote ? {
        promoCode: code,
        promoExpectation: {
          code: quote.code,
          subtotalCents: quote.subtotalCents,
          discountCents: quote.discountCents,
          totalCents: quote.totalCents,
          trackingOnly: quote.trackingOnly,
          guestlistApplication: quote.guestlistApplication,
        },
      } : {}),
      ...(postCheckoutApproval ? {
        authorizationAccepted: approvalConsents.authorization,
        termsAccepted: approvalConsents.terms,
        privacyAccepted: approvalConsents.privacy,
        entryAccepted: approvalConsents.entry,
        ageAccepted: approvalConsents.age,
      } : {}),
    };
  }

  async function applyPromo() {
    if (busy || promoBusy || submittingRef.current) return;
    setPromoBusy(true);
    clearFailure();
    try {
      const response = await fetch("/api/promos/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventId: event.id,
          allocationId: allocation?.id,
          ticketTypeId: ticketType!.id,
          ticketQuantity: quantity,
          products: Object.entries(extras)
            .filter(([, value]) => value > 0)
            .map(([productId, value]) => ({ productId, quantity: value })),
          ...(normalizedPromoCode ? { promoCode: normalizedPromoCode } : {}),
        }),
      });
      const body = await response.json() as {
        error?: string;
        code?: string;
        correlationId?: string;
        subtotalCents?: number;
        discountCents?: number;
        totalCents?: number;
        trackingOnly?: boolean;
        guestlistApplication?: boolean;
      };
      if (!response.ok) {
        setQuote(null);
        setAppliedPromo("");
        setError(body.error || "Promo code could not be applied.");
        setFailure({ code: body.code, correlationId: body.correlationId });
        return;
      }
      const nextQuote = {
        subtotalCents: Number(body.subtotalCents || 0),
        discountCents: Number(body.discountCents || 0),
        totalCents: Number(body.totalCents || 0),
        code: normalizedPromoCode,
        trackingOnly: body.trackingOnly === true,
        guestlistApplication: body.guestlistApplication === true,
      };
      if (nextQuote.subtotalCents !== subtotal
        || nextQuote.discountCents < 0
        || nextQuote.trackingOnly !== (nextQuote.discountCents === 0)
        || (nextQuote.guestlistApplication && nextQuote.trackingOnly)
        || nextQuote.totalCents !== nextQuote.subtotalCents - nextQuote.discountCents) {
        setQuote(null);
        setAppliedPromo("");
        setError("The promo quote could not be verified. Refresh the page and apply it again.");
        setFailure({ code: "PROMO_QUOTE_INVALID" });
        return;
      }
      setQuote(nextQuote);
      setAppliedPromo(normalizedPromoCode);
      setPromoCode(normalizedPromoCode);
    } catch {
      setQuote(null);
      setAppliedPromo("");
      setError("The promo code could not be checked. Try again shortly.");
      setFailure({ code: "PROMO_QUOTE_UNAVAILABLE" });
    } finally {
      setPromoBusy(false);
    }
  }

  async function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (submittingRef.current) return;
    if (promoBusy || promoNeedsApply) {
      setError("Apply the promo code and wait for the confirmed total before continuing.");
      setFailure({ code: "PROMO_QUOTE_REQUIRED" });
      return;
    }
    if (postCheckoutApproval && Object.values(approvalConsents).some((accepted) => !accepted)) {
      setError("Accept every required application, age and policy acknowledgement before continuing.");
      setFailure({ code: "CONSENT_REQUIRED" });
      return;
    }

    submittingRef.current = true;
    setBusy(true);
    clearFailure();
    let redirecting = false;
    try {
      const response = await fetch("/api/checkout/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(checkoutPayload(appliedPromo || undefined)),
      });
      const body = await response.json() as {
        error?: string;
        code?: string;
        correlationId?: string;
        checkout?: { url?: string };
      };
      if (response.ok && body.checkout?.url) {
        redirecting = true;
        window.location.assign(body.checkout.url);
        return;
      }
      setError(body.error || "Could not start checkout.");
      setFailure({ code: body.code, correlationId: body.correlationId });
    } catch {
      setError("Checkout could not reach the server. Check your connection and try once more.");
      setFailure({ code: "NETWORK_ERROR" });
    } finally {
      if (!redirecting) {
        submittingRef.current = false;
        setBusy(false);
      }
    }
  }

  function consent(key: keyof typeof approvalConsents, label: string) {
    return (
      <label className="check-field">
        <input
          type="checkbox"
          checked={approvalConsents[key]}
          disabled={busy || promoBusy}
          onChange={(change) => setApprovalConsents((current) => ({
            ...current,
            [key]: change.target.checked,
          }))}
          required
        />
        <span>{label}</span>
      </label>
    );
  }

  return (
    <form aria-busy={busy || promoBusy} className="checkout-builder" onSubmit={submit}>
      {!allocation && availableTicketTypes.length > 1 && (
        <fieldset className="ticket-type-options" disabled={busy || promoBusy}>
          <legend>Choose ticket type</legend>
          <div>
            {availableTicketTypes.map((type) => {
              const typeMaximum = maximumForTicketType(type);
              const selected = type.id === ticketType.id;
              return (
                <label className={selected ? "is-selected" : ""} key={type.id}>
                  <input
                    checked={selected}
                    name="ticketTypeId"
                    onChange={() => selectTicketType(type)}
                    type="radio"
                    value={type.id}
                  />
                  <span>
                    <strong>{type.name}</strong>
                    <small>{type.description || `Maximum ${typeMaximum} per customer`}</small>
                  </span>
                  <b>{moneyCents(type.priceCents)}</b>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="checkout-ticket-row">
        <div>
          <span className="eyebrow compact"><i />{ticketType.name}</span>
          <h2>{event.title}</h2>
          <p>{ticketType.description}</p>
        </div>
        <strong>{moneyCents(ticketType.priceCents)}</strong>
      </div>

      <label className="quantity-control">
        <span>Tickets</span>
        <select
          aria-describedby="ticket-quantity-help"
          disabled={busy || promoBusy}
          value={quantity}
          onChange={(changeEvent) => {
            setQuantity(Number(changeEvent.target.value));
            setQuote(null);
            setAppliedPromo("");
            clearFailure();
          }}
        >
          {Array.from({ length: max }, (_, index) => index + 1).map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        <small id="ticket-quantity-help">
          Your maximum is {max} ticket{max === 1 ? "" : "s"} for {ticketType.name}.
        </small>
      </label>

      {products.length > 0 && (
        <div className="extras-list">
          <h3 className="eyebrow"><span aria-hidden="true" />Event extras</h3>
          {products.map((product) => {
            const image = safeUrl(product.imageUrl);
            return (
              <article className="extra-item" key={product.id}>
                {image && (
                  <span
                    aria-hidden="true"
                    className="extra-item-image"
                    style={{ backgroundImage: `url(${JSON.stringify(image).slice(1, -1)})` }}
                  />
                )}
                <div>
                  <strong>{product.name}</strong>
                  <p>{product.description}</p>
                  <small>
                    {moneyCents(product.priceCents)} - Max {Math.min(product.maxPerOrder, product.maxPerCustomer)}
                  </small>
                </div>
                <select
                  aria-label={`${product.name} quantity`}
                  disabled={busy || promoBusy}
                  value={extras[product.id] || 0}
                  onChange={(changeEvent) => {
                    setExtras((current) => ({
                      ...current,
                      [product.id]: Number(changeEvent.target.value),
                    }));
                    setQuote(null);
                    setAppliedPromo("");
                    clearFailure();
                  }}
                >
                  <option value={0}>0</option>
                  {Array.from(
                    { length: Math.min(product.maxPerOrder, product.maxPerCustomer) },
                    (_, index) => index + 1,
                  ).map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </article>
            );
          })}
        </div>
      )}

      <div className="promo-entry">
        <label>
          <span>Promo code</span>
          <input
            autoComplete="off"
            disabled={busy || promoBusy}
            maxLength={40}
            value={promoCode}
            onChange={(changeEvent) => {
              setPromoCode(changeEvent.target.value.toUpperCase());
              setQuote(null);
              setAppliedPromo("");
              clearFailure();
            }}
          />
        </label>
        <button
          className="button button-ghost"
          disabled={busy || promoBusy || !normalizedPromoCode}
          onClick={() => void applyPromo()}
          type="button"
        >
          {promoBusy ? "Checking..." : quote && !promoNeedsApply ? "Applied" : "Apply"}
        </button>
      </div>

      <div className="checkout-total">
        <span>Subtotal</span>
        <strong aria-label={`Subtotal ${moneyCents(subtotal)}`}>{moneyCents(subtotal)}</strong>
      </div>
      {quote && (
        <div className="checkout-total is-discount" role="status">
          <span>{quote.guestlistApplication ? "Guest-list application" : quote.trackingOnly ? "Tracking code" : "Promo"} {quote.code}</span>
          {!quote.trackingOnly && (
            <strong aria-label={`Discount ${moneyCents(quote.discountCents)}`}>
              -{moneyCents(quote.discountCents)}
            </strong>
          )}
        </div>
      )}
      {guestlistApplication && (
        <p className="form-note" role="status">
          Eligible tickets are free only if SKIE approves the application. Drink passes and other add-ons remain payable at their displayed prices.
        </p>
      )}
      <div className="checkout-total" aria-live="polite">
        <span>{guestlistApplication && totalCents > 0 ? "Add-ons payable if approved" : "Total"}</span>
        <strong aria-label={`Total ${moneyCents(totalCents)}`}>
          {moneyCents(totalCents)}
        </strong>
      </div>

      {postCheckoutApproval && (
        <div className="post-checkout-disclosure" role="group" aria-labelledby="checkout-consent-title">
          <h3 id="checkout-consent-title">Accept the terms and conditions below.</h3>
          <div className="consent-stack">
            {consent(
              "authorization",
              guestlistNoPayment
                ? "I understand the guest-list ticket is not issued unless SKIE approves my completed application, and no payment is required for this ticket-only request."
                : guestlistApplication
                  ? `I authorise ${moneyCents(totalCents)} for the selected add-ons and understand it is charged only if SKIE approves my application.`
                  : "I authorise the displayed amount and understand it is charged only if SKIE approves my application.",
            )}
            {consent("age", "I confirm I meet the event age requirement and will bring valid photo ID.")}
            {consent("terms", "I agree to the Terms & Conditions.")}
            {consent("privacy", "I acknowledge the Privacy Policy and application-data handling.")}
            {consent("entry", "I agree to the Entry Policy and venue/security instructions.")}
          </div>
        </div>
      )}

      <button className="button button-primary" disabled={busy || promoBusy || promoNeedsApply}>
        {busy ? "Checking out..." : guestlistNoPayment ? "Continue to application" : "Checkout"}
      </button>

      {error && (
        <div className="form-message is-error" role="alert">
          <p>{error}</p>
          {failure.code === "POST_APPROVAL_ALREADY_ACTIVE" && (
            <p><a href="/account">Open My Account</a></p>
          )}
          {(failure.code || failure.correlationId) && (
            <small>
              {failure.code ? `Code: ${failure.code}` : ""}
              {failure.code && failure.correlationId ? " · " : ""}
              {failure.correlationId ? `Reference: ${failure.correlationId}` : ""}
            </small>
          )}
        </div>
      )}

      {!postCheckoutApproval && (
        <p className="form-note">
          Your ticket and QR are issued only after verified payment. In test mode, no real charge is made.
        </p>
      )}
    </form>
  );
}
