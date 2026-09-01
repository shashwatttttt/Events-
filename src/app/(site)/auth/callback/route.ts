import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { repairAuthenticatedCustomer } from "@/lib/security/auth-service";
import { customerBookingLandingPath } from "@/lib/security/customer-landing";
import { safeRedirectPath } from "@/lib/security/redirects";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (config.dataProvider !== "supabase" || !code) {
    return NextResponse.redirect(new URL("/login?error=confirmation", url.origin));
  }

  const client = await createSupabaseServerClient();
  const { error } = await client.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(new URL("/login?error=confirmation", url.origin));
  await repairAuthenticatedCustomer(client).catch(() => undefined);

  const fallback = await customerBookingLandingPath();
  const safeNext = safeRedirectPath(url.searchParams.get("next"), fallback);
  return NextResponse.redirect(new URL(safeNext, url.origin));
}
