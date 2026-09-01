import { config } from "@/lib/config";
import { localAdminLogin, loginCustomer } from "@/lib/security/auth-service";
import { isAdminRole, setLocalSession } from "@/lib/security/session";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";
import { loginSchema } from "@/lib/validate";

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    await enforceRateLimit(requestKey(request, "admin-login"), 8, 900000);
    const body = await parseJsonRequest(request, loginSchema, 4_096);
    await enforceRateLimit(requestKey(request, "admin-login-account", body.email), 6, 900000);
    const user = config.dataProvider === "supabase" ? await loginCustomer(body) : await localAdminLogin(body);
    if (!isAdminRole(user.role)) throw new Error("FORBIDDEN");
    await setLocalSession(user);
    return noStoreJson({ ok: true, redirect: "/skie-control" });
  } catch (error) { return apiError(error); }
}
