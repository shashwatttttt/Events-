import "server-only";
import { cookies } from "next/headers";
import { config } from "@/lib/config";
import { hmac, safeEqual } from "@/lib/security/crypto";
import type { EventItem } from "@/types/site";

function cookieName(eventId: string) {
  return `skie_event_${eventId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function accessValue(event: EventItem) {
  return hmac(`${event.id}:${event.password || ""}`, config.authSecret);
}

export async function hasEventPasswordAccess(event: EventItem) {
  if (event.visibility !== "password") return true;
  if (!event.password) return false;
  const store = await cookies();
  const value = store.get(cookieName(event.id))?.value || "";
  return safeEqual(value, accessValue(event));
}

export async function grantEventPasswordAccess(event: EventItem) {
  const store = await cookies();
  store.set(cookieName(event.id), accessValue(event), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.siteUrl.startsWith("https://"),
    path: `/events/${event.slug}`,
    maxAge: 60 * 60 * 24,
  });
}

export function eventPasswordMatches(event: EventItem, supplied: string) {
  if (!event.password) return false;
  return safeEqual(
    hmac(supplied, config.authSecret),
    hmac(event.password, config.authSecret),
  );
}
