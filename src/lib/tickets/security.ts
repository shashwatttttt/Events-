import "server-only";
import { config } from "@/lib/config";
import { hmac, safeEqual, sha256 } from "@/lib/security/crypto";
import type { Ticket } from "@/types/site";

export function createTicketToken(ticket: Pick<Ticket, "id" | "eventId" | "userId">) {
  return hmac(`${ticket.id}:${ticket.eventId}:${ticket.userId}`, config.ticketSecret);
}

export function createTicketTokenHash(ticket: Pick<Ticket, "id" | "eventId" | "userId">) {
  return sha256(createTicketToken(ticket));
}

export function verifyTicketToken(ticket: Pick<Ticket, "id" | "eventId" | "userId" | "tokenHash">, token: string) {
  return safeEqual(ticket.tokenHash, sha256(token));
}

export function createTicketUrl(ticket: Pick<Ticket, "id" | "eventId" | "userId">) {
  const token = createTicketToken(ticket);
  return `${config.siteUrl}/ticket/verify?ticket=${encodeURIComponent(ticket.id)}&token=${encodeURIComponent(token)}`;
}
