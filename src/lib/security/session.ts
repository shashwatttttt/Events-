import "server-only";
import { cookies } from "next/headers";
import { config } from "@/lib/config";
import { hmac, safeEqual } from "@/lib/security/crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SessionUser, UserRole } from "@/types/site";

const COOKIE_NAME = "skie_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;

type SignedPayload = SessionUser & { exp: number };

function encode(payload: SignedPayload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body)}`;
}

function decode(raw: string | undefined): SignedPayload | null {
  if (!raw) return null;
  const [body, signature] = raw.split(".");
  if (!body || !signature || !safeEqual(signature, hmac(body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SignedPayload;
    return payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}

export async function setLocalSession(user: SessionUser) {
  const store = await cookies();
  store.set(COOKIE_NAME, encode({ ...user, exp: Date.now() + SESSION_SECONDS * 1000 }), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.siteUrl.startsWith("https://"),
    path: "/",
    maxAge: SESSION_SECONDS
  });
}

export async function clearSession() {
  const store = await cookies();
  store.set(COOKIE_NAME, "", { httpOnly: true, sameSite: "lax", secure: config.siteUrl.startsWith("https://"), path: "/", maxAge: 0 });
  if (config.dataProvider === "supabase" && process.env.NEXT_PUBLIC_SUPABASE_URL) {
    const client = await createSupabaseServerClient();
    await client.auth.signOut();
  }
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  if (config.dataProvider === "supabase" && process.env.NEXT_PUBLIC_SUPABASE_URL) {
    const client = await createSupabaseServerClient();
    const { data: { user } } = await client.auth.getUser();
    if (!user?.email) return null;
    const { data: profile } = await client.from("profiles").select("id, first_name, last_name, email, role, admin_deleted_at").eq("id", user.id).maybeSingle();
    if (profile?.admin_deleted_at) return null;
    return {
      id: user.id,
      firstName: profile?.first_name || String(user.user_metadata?.first_name || ""),
      lastName: profile?.last_name || String(user.user_metadata?.last_name || ""),
      email: profile?.email || user.email,
      role: (profile?.role || "customer") as UserRole
    };
  }
  const store = await cookies();
  const payload = decode(store.get(COOKIE_NAME)?.value);
  if (!payload) return null;
  return { id: payload.id, firstName: payload.firstName, lastName: payload.lastName, email: payload.email, role: payload.role };
}

export async function requireUser(roles?: UserRole[]) {
  const user = await getCurrentUser();
  if (!user) throw new Error("AUTH_REQUIRED");
  if (roles && !roles.includes(user.role)) throw new Error("FORBIDDEN");
  return user;
}

export function isAdminRole(role: UserRole) {
  return role === "admin" || role === "super_admin";
}

export function isDoorRole(role: UserRole) {
  return isAdminRole(role) || role === "door_staff" || role === "scanner_only";
}
