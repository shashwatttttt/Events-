import "server-only";

import { canonicalEventState } from "@/lib/event-state";
import { readSiteData } from "@/lib/data/documents";
import type { EventItem } from "@/types/site";

const AVAILABLE_STATES = new Set(["sales_open", "application_open"]);

function isCustomerFacing(event: EventItem) {
  return event.lifecycle === "published"
    && ["public", "private_link", "password"].includes(event.visibility)
    && AVAILABLE_STATES.has(canonicalEventState(event));
}

function eventPriority(event: EventItem) {
  const identity = `${event.title} ${event.slug}`.toLowerCase();
  if (identity.includes("house arrest") || identity.includes("house-arrest")) return 0;
  if (event.featured) return 1;
  if (event.ticketMode === "direct_purchase" || event.ticketMode === "post_checkout_approval") return 2;
  return 3;
}

export function customerBookingPathForEvents(events: EventItem[]) {
  const event = [...events]
    .filter(isCustomerFacing)
    .sort((left, right) => {
      const priority = eventPriority(left) - eventPriority(right);
      if (priority !== 0) return priority;
      return left.date.localeCompare(right.date);
    })[0];
  return event ? `/events/${encodeURIComponent(event.slug)}` : "/events";
}

export async function customerBookingLandingPath() {
  try {
    const site = await readSiteData();
    return customerBookingPathForEvents(site.events);
  } catch {
    return "/events";
  }
}
