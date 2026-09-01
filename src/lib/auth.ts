import "server-only";
import { redirect } from "next/navigation";
import { getCurrentUser, isAdminRole, requireUser } from "@/lib/security/session";
import { loginRedirectPath } from "@/lib/security/redirects";
import type { UserRole } from "@/types/site";

export async function isAdmin() { const user = await getCurrentUser(); return Boolean(user && isAdminRole(user.role)); }
export async function requireAdmin() { const user = await getCurrentUser(); if (!user || !isAdminRole(user.role)) redirect("/skie-control/login"); return user; }
export async function assertAdmin() { return requireUser(["admin", "super_admin"]); }
export function assertSameOrigin(request: Request) { const origin = request.headers.get("origin"); const host = request.headers.get("host"); if (origin && host && new URL(origin).host !== host) throw new Error("INVALID_ORIGIN"); }
export async function requirePageUser(next: string, roles?: UserRole[]) {
  const user = await getCurrentUser();
  if (!user) redirect(loginRedirectPath(next));
  if (roles && !roles.includes(user.role)) redirect("/account");
  return user;
}
