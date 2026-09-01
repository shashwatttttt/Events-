import "server-only";
import { readOperationsData, readSiteData } from "@/lib/data/documents";
import { canViewEvent, isEventPubliclyListed } from "@/lib/event-state";
import type { EventItem, SiteData } from "@/types/site";

export async function readPublicSiteData(): Promise<SiteData> {
  const site = await readSiteData();
  return {
    ...site,
    events: site.events.filter(isEventPubliclyListed),
    products: site.products.filter((product) => product.active),
    sponsors: site.sponsors.filter((sponsor) => sponsor.active),
    media: site.media.filter((item) => item.published),
    reviews: site.reviews.filter((review) => review.status === "approved")
  };
}

export async function readEventBySlug(slug: string): Promise<EventItem | null> {
  const site = await readSiteData();
  const event = site.events.find((item) => item.slug === slug);
  if (!event || !canViewEvent(event)) return null;
  return event;
}

export async function readEventSales(eventId: string) {
  const [site, ops] = await Promise.all([readSiteData(), readOperationsData()]);
  const event = site.events.find((item) => item.id === eventId);
  if (!event) return null;
  const validTickets = ops.tickets.filter((ticket) => ticket.eventId === eventId && !["cancelled", "refunded", "expired"].includes(ticket.status));
  const approvedAllocations = ops.allocations.filter((allocation) => allocation.eventId === eventId && !["cancelled", "expired"].includes(allocation.status));
  return {
    paidTickets: validTickets.length,
    approvedCapacity: approvedAllocations.reduce((total, item) => total + item.maxQuantity, 0),
    remainingPublic: Math.max(0, event.publicCapacity - validTickets.length)
  };
}

export async function readLegalPage(slug: string) {
  const site = await readSiteData();
  return site.legalPages.find((page) => page.slug === slug) || null;
}
