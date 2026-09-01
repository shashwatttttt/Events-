import { assertRequestOrigin, apiError, noStoreJson } from "@/lib/http";
import { config } from "@/lib/config";
import { isEffectiveTestMode } from "@/lib/mode";
import { fulfillOrder } from "@/lib/operations";
import { readOperationsData } from "@/lib/data/documents";
import { requireUser } from "@/lib/security/session";

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    if (config.appMode === "live") throw new Error("Test checkout is disabled on a live server.");
    if (!(await isEffectiveTestMode())) throw new Error("Test checkout is disabled in live mode.");
    const user = await requireUser(["customer"]);
    const { orderId } = (await request.json()) as { orderId?: string };
    if (!orderId) throw new Error("Order ID is required.");

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
