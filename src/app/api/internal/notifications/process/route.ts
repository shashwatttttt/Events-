import { z } from "zod";
import { config } from "@/lib/config";
import { apiError, noStoreJson, parseJsonRequest, PublicApiError } from "@/lib/http";
import { processNotificationBatch } from "@/lib/notifications/worker";
import { safeEqual } from "@/lib/security/crypto";

const schema = z.object({
  batchSize: z.number().int().min(1).max(25).default(10),
  dryRun: z.boolean().default(false),
  channel: z.enum(["email", "sms", "in_app", "whatsapp", "all"]).default("all"),
}).strict();

export async function POST(request: Request) {
  try {
    const authorization = request.headers.get("authorization") || "";
    const expected = `Bearer ${config.notificationWorkerSecret}`;
    if (!safeEqual(authorization, expected)) throw new PublicApiError("WORKER_AUTH_REQUIRED", "Worker authentication failed.", 401);
    const input = await parseJsonRequest(request, schema, 2_048);
    return noStoreJson(await processNotificationBatch(input));
  } catch (error) {
    return apiError(error);
  }
}
