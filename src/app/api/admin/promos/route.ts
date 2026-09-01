import { z } from "zod";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { listPromos, promoAdminSchema, savePromo } from "@/lib/promos/service";
import { requireUser } from "@/lib/security/session";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), promo: promoAdminSchema }).strict(),
]);

export async function GET() {
  try {
    await requireUser(["admin", "super_admin"]);
    return noStoreJson(await listPromos());
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["admin", "super_admin"]);
    const input = await parseJsonRequest(request, actionSchema, 32_768);
    return noStoreJson(await savePromo(actor, input.promo), input.promo.id ? 200 : 201);
  } catch (error) {
    return apiError(error);
  }
}
