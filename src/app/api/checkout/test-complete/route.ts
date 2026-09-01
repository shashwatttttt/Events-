import { z } from "zod";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { config } from "@/lib/config";
import { isEffectiveTestMode } from "@/lib/mode";
import { fulfillOrder } from "@/lib/operations";
import { readOperationsData } from "@/lib/data/documents";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";
import { requireUser } from "@/lib/security/session";

const schema = z.object({
  orderId: z.string().min(1).max(120),
}).strict();

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    if (config.appMode === "live") throw new Error("Test checkout is disabled on a live server.");
    if (!(await isEffectiveTestMode())) throw new Error("Test checkout is disabled in live mode.");
    const user = await requireUser(["customer"]);
    await enforceRateLimit(requestKey(request, "checkout-test-complete", user.id), 12, 60_000);
    const { orderId } = await parseJsonRequest(request, schema, 2_048);

    const ops = await readOperationsData();
    const order = ops.orders.find((item) => item.id === orderId);
    if (!order || order.userId !== user.id) throw new Error("FORBIDDEN");
    if (order.status !== "pending" && order.status !== "paid") throw new Error("This order can no longer be completed.");
    if (order.status === "pending" && new Date(order.expiresAt).getTime() <= Date.now()) throw new Error("This checkout has expired.");

    return noStoreJson(await fulfillOrder(orderId, "test", `test_${Date.now()}`));
  } catch (error) {
    return apiError(error);
  }
}
