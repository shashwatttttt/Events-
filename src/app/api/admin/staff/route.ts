import { z } from "zod";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { requireUser } from "@/lib/security/session";
import { listStaffAdministration, manageStaffAssignment, setStaffAccountRole } from "@/lib/staff";

const staffRole = z.enum(["scanner_only", "door_staff", "event_admin"]);
const accountRole = z.enum(["customer", "scanner_only", "door_staff", "admin"]);
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("assign"),
    userId: z.string().min(1).max(100),
    eventId: z.string().min(1).max(100),
    role: staffRole,
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }).optional(),
  }).strict().superRefine((value, context) => {
    if (value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) {
      context.addIssue({ code: "custom", message: "Assignment end must be after its start.", path: ["endsAt"] });
    }
  }),
  z.object({ action: z.literal("revoke"), assignmentId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("set_role"), userId: z.string().min(1).max(100), role: accountRole }).strict(),
]);

export async function GET() {
  try {
    const actor = await requireUser(["admin", "super_admin"]);
    return noStoreJson({ actorRole: actor.role, ...await listStaffAdministration() });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["admin", "super_admin"]);
    const input = await parseJsonRequest(request, mutationSchema, 8_192);
    if (input.action === "set_role") {
      return noStoreJson({ account: await setStaffAccountRole(actor, input.userId, input.role) });
    }
    return noStoreJson({ assignment: await manageStaffAssignment({ ...input, actor }) });
  } catch (error) {
    return apiError(error);
  }
}
