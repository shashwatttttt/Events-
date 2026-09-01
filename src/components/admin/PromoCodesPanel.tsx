"use client";

import { useEffect, useMemo, useState } from "react";
import { moneyCents } from "@/lib/format";
import { melbourneLocalToIso, PROMO_TIMEZONE } from "@/lib/promos/policy";
import type { EventItem, EventProduct, PromoCode, PromoRedemption } from "@/types/site";

type Draft = {
  id?: string;
  code: string;
  internalName: string;
  description: string;
  active: boolean;
  discountType: "percentage" | "fixed" | "tracking" | "guestlist";
  percentOff: string;
  amountOffDollars: string;
  validFrom: string;
  expiresAt: string;
  maxRedemptions: string;
  maxDiscountedTicketUnits: string;
  maxUsesPerCustomer: string;
  minimumOrderDollars: string;
  firstPurchaseOnly: boolean;
  eventIds: string[];
  ticketTypeIds: string[];
  productIds: string[];
  status: "draft" | "active" | "inactive";
};

const blank: Draft = {
  code: "",
  internalName: "",
  description: "",
  active: false,
  discountType: "tracking",
  percentOff: "",
  amountOffDollars: "",
  validFrom: "",
  expiresAt: "",
  maxRedemptions: "",
  maxDiscountedTicketUnits: "",
  maxUsesPerCustomer: "1",
  minimumOrderDollars: "0",
  firstPurchaseOnly: false,
  eventIds: [],
  ticketTypeIds: [],
  productIds: [],
  status: "draft",
};

const numberOrNull = (value: string) => value.trim() ? Number(value) : null;
const cents = (value: string) => Math.round(Number(value || 0) * 100);
const splitSelection = (event: React.ChangeEvent<HTMLSelectElement>) =>
  Array.from(event.currentTarget.selectedOptions, (option) => option.value);

function positiveInteger(value: string) {
  if (!value.trim()) return true;
  return /^\d+$/.test(value.trim()) && Number(value) > 0 && Number.isSafeInteger(Number(value));
}

function nonNegativeMoney(value: string) {
  const parsed = Number(value);
  return value.trim().length > 0 && Number.isFinite(parsed) && parsed >= 0;
}

function positiveMoney(value: string) {
  const parsed = Number(value);
  return value.trim().length > 0 && Number.isFinite(parsed) && parsed > 0;
}

function validateDraft(draft: Draft) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(draft.code.trim())) {
    return "Code must start with a letter or number and contain only letters, numbers, underscores or hyphens.";
  }
  if (!draft.internalName.trim()) return "Internal name / promoter is required.";
  if (draft.discountType === "percentage") {
    const value = Number(draft.percentOff);
    if (!Number.isFinite(value) || value <= 0 || value > 100) return "Percentage discount must be greater than 0 and no more than 100.";
  }
  if (draft.discountType === "fixed" && !positiveMoney(draft.amountOffDollars)) {
    return "Fixed AUD discount must be greater than 0.";
  }
  if (draft.discountType === "guestlist" && draft.productIds.length) {
    return "Guest-list application codes make eligible tickets free only. Remove all selected products/add-ons.";
  }
  if (!nonNegativeMoney(draft.minimumOrderDollars)) return "Minimum order must be 0 or greater.";
  for (const [label, value] of [
    ["Per-customer uses", draft.maxUsesPerCustomer],
    ["Maximum attributed orders", draft.maxRedemptions],
    ["Maximum attributed ticket units", draft.maxDiscountedTicketUnits],
  ] as const) {
    if (!positiveInteger(value)) return `${label} must be a positive whole number or left blank.`;
  }
  if (draft.validFrom && !Number.isFinite(new Date(melbourneLocalToIso(draft.validFrom)).getTime())) return "Start date is invalid.";
  if (draft.expiresAt && !Number.isFinite(new Date(melbourneLocalToIso(draft.expiresAt)).getTime())) return "Expiry date is invalid.";
  if (draft.validFrom && draft.expiresAt
    && new Date(melbourneLocalToIso(draft.expiresAt)) <= new Date(melbourneLocalToIso(draft.validFrom))) {
    return "Expiry must be after the start date.";
  }
  return "";
}

function melbourneInput(iso?: string) {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PROMO_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

function draftFrom(item: PromoCode): Draft {
  return {
    id: item.id,
    code: item.code,
    internalName: item.internalName,
    description: item.description,
    active: item.active,
    discountType: String(item.discountType) as Draft["discountType"],
    percentOff: item.percentOff?.toString() || "",
    amountOffDollars: item.amountOffCents !== undefined ? (item.amountOffCents / 100).toFixed(2) : "",
    validFrom: melbourneInput(item.validFrom),
    expiresAt: melbourneInput(item.expiresAt),
    maxRedemptions: item.maxRedemptions?.toString() || "",
    maxDiscountedTicketUnits: item.maxDiscountedTicketUnits?.toString() || "",
    maxUsesPerCustomer: item.maxUsesPerCustomer?.toString() || "",
    minimumOrderDollars: (item.minimumOrderCents / 100).toFixed(2),
    firstPurchaseOnly: item.firstPurchaseOnly,
    eventIds: item.eventIds,
    ticketTypeIds: item.ticketTypeIds,
    productIds: String(item.discountType) === "guestlist" ? [] : item.productIds,
    status: item.status === "expired" || item.status === "provider_error" ? "inactive" : item.status,
  };
}

export function PromoCodesPanel({ events, products }: { events: EventItem[]; products: EventProduct[] }) {
  const [promos, setPromos] = useState<PromoCode[]>([]);
  const [redemptions, setRedemptions] = useState<PromoRedemption[]>([]);
  const [draft, setDraft] = useState<Draft>(blank);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const ticketTypes = useMemo(() => events.flatMap((event) => event.ticketTypes.map((ticket) => ({
    ...ticket,
    eventTitle: event.title,
  }))), [events]);

  async function load() {
    try {
      const response = await fetch("/api/admin/promos", { cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { promos?: PromoCode[]; redemptions?: PromoRedemption[]; error?: string };
      if (!response.ok) {
        setStatus(body.error || "Promo data could not be loaded.");
        return;
      }
      setPromos(body.promos || []);
      setRedemptions(body.redemptions || []);
    } catch {
      setStatus("Promo data could not reach the server. Check the connection and refresh.");
    }
  }

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/promos", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : null)
      .then((body) => {
        if (!cancelled && body) {
          setPromos(body.promos || []);
          setRedemptions(body.redemptions || []);
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("Promo data could not be loaded. Refresh to try again.");
      });
    return () => { cancelled = true; };
  }, []);

  async function save(nextDraft = draft) {
    const validationError = validateDraft(nextDraft);
    if (validationError) {
      setStatus(validationError);
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const active = nextDraft.status === "active";
      const response = await fetch("/api/admin/promos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          promo: {
            ...(nextDraft.id ? { id: nextDraft.id } : {}),
            code: nextDraft.code,
            internalName: nextDraft.internalName,
            description: nextDraft.description,
            active,
            status: nextDraft.status,
            discountType: nextDraft.discountType,
            percentOff: nextDraft.discountType === "percentage" ? numberOrNull(nextDraft.percentOff) : null,
            amountOffCents: nextDraft.discountType === "fixed" ? cents(nextDraft.amountOffDollars) : null,
            validFrom: nextDraft.validFrom ? melbourneLocalToIso(nextDraft.validFrom) : null,
            expiresAt: nextDraft.expiresAt ? melbourneLocalToIso(nextDraft.expiresAt) : null,
            maxRedemptions: numberOrNull(nextDraft.maxRedemptions),
            maxDiscountedTicketUnits: numberOrNull(nextDraft.maxDiscountedTicketUnits),
            maxUsesPerCustomer: numberOrNull(nextDraft.maxUsesPerCustomer),
            minimumOrderCents: cents(nextDraft.minimumOrderDollars),
            firstPurchaseOnly: nextDraft.firstPurchaseOnly,
            eventIds: nextDraft.eventIds,
            ticketTypeIds: nextDraft.ticketTypeIds,
            productIds: nextDraft.discountType === "guestlist" ? [] : nextDraft.productIds,
          },
        }),
      });
      const body = await response.json().catch(() => ({})) as PromoCode & { error?: string };
      if (!response.ok) {
        setStatus(body.error || "Code could not be saved.");
        return;
      }
      setStatus("Code saved.");
      setDraft(draftFrom(body));
      await load();
    } catch {
      setStatus("The code could not reach the server. Its current state has not been changed. Refresh and try again.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  return <section className="admin-section admin-stack">
    <div className="admin-section-title">
      <div>
        <h2>Promo and tracking codes</h2>
        <p>Server-calculated discounts, guest-list applications and promoter attribution. Schedule fields use {PROMO_TIMEZONE}.</p>
      </div>
      <button className="button button-ghost" onClick={() => { setDraft(blank); setStatus(""); }} type="button">New code</button>
    </div>

    <div className="admin-card admin-stack">
      <div className="admin-grid-three">
        <label className="admin-field"><span>Code</span><input value={draft.code} maxLength={40} onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })} /></label>
        <label className="admin-field"><span>Internal name / promoter</span><input value={draft.internalName} maxLength={120} onChange={(event) => setDraft({ ...draft, internalName: event.target.value })} /></label>
        <label className="admin-field"><span>Status</span><select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as Draft["status"] })}><option value="draft">Draft</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
      </div>
      <label className="admin-field"><span>Description</span><textarea maxLength={500} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>

      <div className="admin-grid-three">
        <label className="admin-field"><span>Code purpose</span><select value={draft.discountType} onChange={(event) => {
          const discountType = event.target.value as Draft["discountType"];
          setDraft({
            ...draft,
            discountType,
            ...(discountType === "guestlist" ? { percentOff: "", amountOffDollars: "", productIds: [] } : {}),
          });
        }}><option value="tracking">Tracking only — no discount</option><option value="guestlist">Guest-list application — eligible tickets free after approval</option><option value="percentage">Percentage discount</option><option value="fixed">Fixed AUD discount</option></select></label>
        {draft.discountType === "percentage"
          ? <label className="admin-field"><span>Percent off</span><input type="number" min="0.01" max="100" step="0.01" value={draft.percentOff} onChange={(event) => setDraft({ ...draft, percentOff: event.target.value })} /></label>
          : draft.discountType === "fixed"
            ? <label className="admin-field"><span>AUD off</span><input type="number" min="0.01" step="0.01" value={draft.amountOffDollars} onChange={(event) => setDraft({ ...draft, amountOffDollars: event.target.value })} /></label>
            : draft.discountType === "guestlist"
              ? <div className="admin-field"><span>Customer pricing</span><strong>Eligible tickets 100% off · add-ons remain payable</strong></div>
              : <div className="admin-field"><span>Customer discount</span><strong>None — attribution only</strong></div>}
        <label className="admin-field"><span>Minimum order AUD</span><input type="number" min="0" step="0.01" value={draft.minimumOrderDollars} onChange={(event) => setDraft({ ...draft, minimumOrderDollars: event.target.value })} /></label>
      </div>
      {draft.discountType === "guestlist" && <p className="admin-field-note">A guest-list code never issues a ticket immediately. The customer must submit the event form, and an admin must approve or reject the application. If add-ons are selected, Stripe handles only the add-on total.</p>}

      <div className="admin-grid-three">
        <label className="admin-field"><span>Starts (Melbourne)</span><input type="datetime-local" value={draft.validFrom} onChange={(event) => setDraft({ ...draft, validFrom: event.target.value })} /></label>
        <label className="admin-field"><span>Expires (Melbourne)</span><input type="datetime-local" value={draft.expiresAt} onChange={(event) => setDraft({ ...draft, expiresAt: event.target.value })} /></label>
        <label className="admin-field"><span>Per-customer uses</span><input type="number" min="1" step="1" value={draft.maxUsesPerCustomer} onChange={(event) => setDraft({ ...draft, maxUsesPerCustomer: event.target.value })} /></label>
      </div>
      <div className="admin-grid-three">
        <label className="admin-field"><span>Maximum attributed orders</span><input type="number" min="1" step="1" value={draft.maxRedemptions} onChange={(event) => setDraft({ ...draft, maxRedemptions: event.target.value })} /></label>
        <label className="admin-field"><span>Maximum attributed ticket units</span><input type="number" min="1" step="1" value={draft.maxDiscountedTicketUnits} onChange={(event) => setDraft({ ...draft, maxDiscountedTicketUnits: event.target.value })} /></label>
        <label className="admin-field"><span><input checked={draft.firstPurchaseOnly} onChange={(event) => setDraft({ ...draft, firstPurchaseOnly: event.target.checked })} type="checkbox" /> First purchase only</span></label>
      </div>
      <div className="admin-grid-three">
        <label className="admin-field"><span>Events (blank = all)</span><select multiple value={draft.eventIds} onChange={(event) => setDraft({ ...draft, eventIds: splitSelection(event) })}>{events.map((event) => <option key={event.id} value={event.id}>{event.title}</option>)}</select></label>
        <label className="admin-field"><span>Ticket types (blank = all)</span><select multiple value={draft.ticketTypeIds} onChange={(event) => setDraft({ ...draft, ticketTypeIds: splitSelection(event) })}>{ticketTypes.map((ticket) => <option key={ticket.id} value={ticket.id}>{ticket.eventTitle}: {ticket.name}</option>)}</select></label>
        <label className="admin-field"><span>Products/add-ons {draft.discountType === "guestlist" ? "(not discounted)" : "(blank = all)"}</span><select disabled={draft.discountType === "guestlist"} multiple value={draft.productIds} onChange={(event) => setDraft({ ...draft, productIds: splitSelection(event) })}>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select>{draft.discountType === "guestlist" && <small>Guest-list codes never discount drink passes or other add-ons.</small>}</label>
      </div>
      <div className="application-actions">
        <button className="button" disabled={busy} onClick={() => void save()} type="button">{busy ? "Saving..." : "Save code"}</button>
        {draft.id && <button className="button button-ghost" disabled={busy} onClick={() => void save({ ...draft, active: false, status: "inactive" })} type="button">Disable</button>}
      </div>
      {status && <p className="admin-notice" role="status">{status}</p>}
    </div>

    <div className="account-list">
      {promos.map((promo) => {
        const attributed = redemptions.filter((item) => item.promoCodeId === promo.id && item.status !== "released");
        const pending = attributed.filter((item) => item.status === "reserved");
        const captured = attributed.filter((item) => item.status === "finalized");
        const refunded = attributed.filter((item) => item.status === "refunded");
        const disputed = attributed.filter((item) => item.status === "disputed");
        const remaining = promo.maxRedemptions === undefined ? "Unlimited" : Math.max(0, promo.maxRedemptions - attributed.length);
        const tickets = captured.reduce((sum, item) => sum + item.discountedTicketUnits, 0);
        const capturedRevenue = captured.reduce((sum, item) => sum + item.finalTotalCents, 0);
        const refundedValue = refunded.reduce((sum, item) => sum + item.finalTotalCents, 0);
        const disputedValue = disputed.reduce((sum, item) => sum + item.finalTotalCents, 0);
        const discountCost = captured.reduce((sum, item) => sum + item.discountCents, 0);
        const uniqueCustomers = new Set(captured.map((item) => item.customerId)).size;
        const discountType = String(promo.discountType);
        const purpose = discountType === "tracking"
          ? "tracking only"
          : discountType === "guestlist"
            ? "guest-list application"
            : discountType === "percentage"
              ? `${promo.percentOff}% off`
              : `${moneyCents(promo.amountOffCents || 0)} off`;
        return <details key={promo.id}>
          <summary>
            <div><span className={`status-pill status-${promo.status}`}>{promo.status}</span><h3>{promo.code}</h3><p>{promo.internalName} · {purpose}</p></div>
            <strong>{captured.length} captured/approved orders · {tickets} tickets · {remaining} remaining</strong>
          </summary>
          <div className="admin-card">
            <p><strong>Captured/approved value:</strong> {moneyCents(capturedRevenue)} · <strong>Discount cost:</strong> {moneyCents(discountCost)} · <strong>Unique customers:</strong> {uniqueCustomers}</p>
            <p><strong>Pending attribution:</strong> {pending.length} · <strong>Refunded value:</strong> {moneyCents(refundedValue)} · <strong>Disputed value:</strong> {moneyCents(disputedValue)}</p>
            <button className="button button-ghost" onClick={() => { setDraft(draftFrom(promo)); setStatus(""); }} type="button">Edit</button>
            {attributed.map((use) => <p key={use.id}>Order {use.orderId} · {use.status} · value {moneyCents(use.finalTotalCents)} · discount {moneyCents(use.discountCents)} · {use.discountedTicketUnits} ticket unit(s)</p>)}
          </div>
        </details>;
      })}
      {!promos.length && <div className="admin-empty">No promo or tracking codes configured.</div>}
    </div>
  </section>;
}
