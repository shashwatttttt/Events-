import { z } from "zod";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { redeemEntitlement } from "@/lib/operations";
import { requireUser } from "@/lib/security/session";
import { captureAnalyticsSafely } from "@/lib/analytics/store";

const schema = z.object({
  entitlementId: z.string().min(1).max(100),
  eventId: z.string().min(1).max(100),
  quantity: z.number().int().min(1).max(100).default(1),
  operationId: z.uuid().optional(),
}).strict();

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["door_staff", "admin", "super_admin"]);
    const { entitlementId, eventId, quantity, operationId } = await parseJsonRequest(request, schema, 2_048);
    const idempotencyKey=operationId||crypto.randomUUID(); const result=await redeemEntitlement({ entitlementId, eventId, quantity, actor, idempotencyKey });
    await captureAnalyticsSafely({eventName:"addon_redemption",source:"server",deduplicationKey:`addon_redemption:${idempotencyKey}`,eventId,quantity,safeMetadata:{entitlementId}});
    return noStoreJson(result);
  } catch (error) { return apiError(error); }
}
