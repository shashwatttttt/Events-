import { z } from "zod";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { reviewApplication } from "@/lib/operations";
import { requireUser } from "@/lib/security/session";
import { captureAnalyticsSafely } from "@/lib/analytics/store";

const schema = z.object({
  applicationId: z.string().min(1).max(100),
  status: z.enum(["pending", "approved", "waitlist", "hold", "rejected", "cancelled"]),
  ticketTypeId: z.string().max(100).optional(),
  maxQuantity: z.number().int().min(1).max(20).optional(),
  expiryHours: z.number().int().min(1).max(336).optional(),
  adminNotes: z.string().max(3_000).optional(),
}).strict();
const bulkSchema = z.object({
  applicationIds: z.array(z.string().min(1).max(100)).min(1).max(100),
  status: z.enum(["pending", "waitlist", "hold", "rejected", "cancelled"]),
  adminNotes: z.string().max(3_000).optional(),
}).strict();

export async function PATCH(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["admin", "super_admin"]);
    const body = await parseJsonRequest(request, z.union([schema, bulkSchema]), 32_768);
    if ("applicationIds" in body) {
      const results: Array<{ applicationId: string; ok: boolean; error?: string }> = [];
      for (const applicationId of [...new Set(body.applicationIds)]) {
        try {
          await reviewApplication({ applicationId, status: body.status, actor, adminNotes: body.adminNotes });
          results.push({ applicationId, ok: true });
        } catch (error) {
          results.push({ applicationId, ok: false, error: error instanceof Error ? error.message.slice(0, 120) : "UPDATE_FAILED" });
        }
      }
      return noStoreJson({ results, completed: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length });
    }
    const result=await reviewApplication({ applicationId: body.applicationId, status: body.status, actor, ticketTypeId: body.ticketTypeId, maxQuantity: body.maxQuantity, expiryHours: body.expiryHours, adminNotes: body.adminNotes });
    if(result.allocation&&body.status==="approved")await captureAnalyticsSafely({eventName:"allocation_unlocked",source:"server",deduplicationKey:`allocation_unlocked:${result.allocation.id}`,eventId:result.allocation.eventId,ticketTypeId:result.allocation.ticketTypeId,customerId:result.allocation.userId,quantity:result.allocation.maxQuantity,occurredAt:result.allocation.approvedAt});
    return noStoreJson(result);
  } catch (error) { return apiError(error); }
}
