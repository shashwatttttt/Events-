import { NextResponse } from "next/server";
import { assertRequestOrigin, apiError } from "@/lib/http";
import { clearSession } from "@/lib/security/session";

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    await clearSession();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
