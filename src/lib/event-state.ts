import type { EventItem, EventProduct, EventTicketType } from "@/types/site";
import { POST_CHECKOUT_MODE } from "@/lib/post-approval/types";

export const MELBOURNE_TIMEZONE = "Australia/Melbourne";

export type CanonicalEventState =
  | "draft"
  | "preview"
  | "coming_soon"
  | "applications_open"
  | "sales_open"
  | "closed"
  | "cancelled"
  | "archived";

export function canonicalEventState(event: EventItem): CanonicalEventState {
  if (event.lifecycle === "draft") return "draft";
  if (event.lifecycle === "preview") return "preview";
  if (event.lifecycle === "archived") return "archived";
  if (event.lifecycle === "cancelled") return "cancelled";
  if (event.visibility === "coming_soon" || event.ticketMode === "coming_soon") return "coming_soon";
  if (event.ticketMode === "invite_only") return "applications_open";
  if (["direct_purchase", "free_rsvp", POST_CHECKOUT_MODE].includes(String(event.ticketMode))) return "sales_open";
  return "closed";
}

export function isEventPubliclyListed(event: EventItem) {
  if (event.lifecycle !== "published") return false;
  return event.visibility === "public" || event.visibility === "coming_soon";
}

export function canViewEvent(event: EventItem, options: { isAdmin?: boolean } = {}) {
  if (event.lifecycle === "draft" || event.lifecycle === "cancelled") return false;
  if (event.lifecycle === "preview") return Boolean(options.isAdmin);
  if (event.lifecycle === "archived") return event.visibility === "archived";
  return !["hidden", "archived"].includes(event.visibility);
}

export function canApplyToEvent(event: EventItem) {
  return canonicalEventState(event) === "applications_open";
}

export function canStartCheckout(event: EventItem) {
  return canonicalEventState(event) === "sales_open" || canonicalEventState(event) === "applications_open";
}

export function isSalesWindowOpen(
  item: Pick<EventTicketType | EventProduct, "active" | "salesStartAt" | "salesEndAt">,
  now = new Date(),
) {
  if (!item.active) return false;
  const timestamp = now.getTime();
  if (item.salesStartAt && new Date(item.salesStartAt).getTime() > timestamp) return false;
  if (item.salesEndAt && new Date(item.salesEndAt).getTime() <= timestamp) return false;
  return true;
}

export function eventSalesEnabled(event: EventItem) {
  return canStartCheckout(event);
}

export function assertCanonicalEventConfiguration(event: EventItem) {
  const title = event.title || "Event";
  const closedShape = event.visibility === "hidden" && event.ticketMode === "closed";
  const ticketMode = String(event.ticketMode);

  if (event.lifecycle === "draft" && !closedShape) {
    throw new Error(`${title} drafts must be hidden with ticket mode closed.`);
  }
  if (event.lifecycle === "preview" && !closedShape) {
    throw new Error(`${title} previews must be hidden with ticket mode closed.`);
  }
  if (event.lifecycle === "archived" && (event.visibility !== "archived" || event.ticketMode !== "closed")) {
    throw new Error(`${title} archived events must use archived visibility and closed ticket mode.`);
  }
  if (event.lifecycle === "cancelled" && !closedShape) {
    throw new Error(`${title} cancelled events must be hidden with ticket mode closed.`);
  }
  if (event.lifecycle !== "published") return;

  if (event.visibility === "archived") {
    throw new Error(`${title} cannot use archived visibility while published.`);
  }
  if (event.visibility === "hidden" && event.ticketMode !== "closed") {
    throw new Error(`${title} hidden events must have ticket mode closed.`);
  }
  if (event.visibility === "coming_soon" && event.ticketMode !== "coming_soon") {
    throw new Error(`${title} coming-soon visibility requires coming-soon ticket mode.`);
  }
  if (event.ticketMode === "coming_soon" && event.visibility !== "coming_soon") {
    throw new Error(`${title} coming-soon ticket mode requires coming-soon visibility.`);
  }
  if (["direct_purchase", "free_rsvp", "invite_only", POST_CHECKOUT_MODE].includes(ticketMode)
    && !["public", "private_link", "password"].includes(event.visibility)) {
    throw new Error(`${title} cannot sell or accept applications with its current visibility.`);
  }
  if (event.ticketMode === "free_rsvp"
    && event.ticketTypes.some((ticketType) => ticketType.active && ticketType.priceCents !== 0)) {
    throw new Error(`${title} free RSVP ticket types must have a zero price.`);
  }
  if (ticketMode === POST_CHECKOUT_MODE) {
    if (!event.formId) throw new Error(`${title} post-checkout approval requires an application form.`);
    if (event.ticketTypes.some((ticketType) => ticketType.active && ticketType.priceCents <= 0)) {
      throw new Error(`${title} post-checkout approval requires paid active ticket types.`);
    }
  }
}
