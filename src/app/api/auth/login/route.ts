import { noStoreJson, assertRequestOrigin, apiError, parseJsonRequest } from "@/lib/http";
import { loginCustomer } from "@/lib/security/auth-service";
import { customerBookingLandingPath } from "@/lib/security/customer-landing";
import { setLocalSession } from "@/lib/security/session";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";
import { loginSchema } from "@/lib/validate";

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    await enforceRateLimit(requestKey(request, "auth-login"), 12, 900000);
    const body = await parseJsonRequest(request, loginSchema, 4_096);
    await enforceRateLimit(requestKey(request, "auth-login-account", body.email), 8, 900000);
    const user = await loginCustomer(body);
    await setLocalSession(user);
    return noStoreJson({
      user,
      redirect: user.role === "customer" ? await customerBookingLandingPath() : "/skie-control",
    });
  } catch (error) { return apiError(error); }
}
