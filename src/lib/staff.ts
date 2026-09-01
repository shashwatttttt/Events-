import "server-only";

import { config } from "@/lib/config";
import { mutateOperationsData, readOperationsData } from "@/lib/data/documents";
import { PublicApiError } from "@/lib/http";
import { randomId } from "@/lib/security/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type {
  EventStaffAssignment,
  EventStaffAssignmentAudit,
  EventStaffRole,
  OperationsData,
  SessionUser,
  UserRole,
} from "@/types/site";

export type StaffCapability = "scan" | "search" | "redeem";

const capabilities: Record<EventStaffRole, readonly StaffCapability[]> = {
  scanner_only: ["scan", "search"],
  door_staff: ["scan", "search", "redeem"],
  event_admin: ["scan", "search", "redeem"],
};

function assignmentIsCurrent(assignment: EventStaffAssignment, at = new Date()) {
  const timestamp = at.getTime();
  return assignment.active
    && new Date(assignment.startsAt).getTime() <= timestamp
    && (!assignment.endsAt || new Date(assignment.endsAt).getTime() > timestamp);
}

export function hasLocalEventCapability(
  operations: OperationsData,
  actor: SessionUser,
  eventId: string,
  capability: StaffCapability,
  at = new Date(),
) {
  if (["admin", "super_admin"].includes(actor.role)) return true;
  return operations.eventStaffAssignments.some((assignment) => (
    assignment.userId === actor.id
    && assignment.eventId === eventId
    && assignmentIsCurrent(assignment, at)
    && capabilities[assignment.role].includes(capability)
  ));
}

export async function assertEventCapability(actor: SessionUser, eventId: string, capability: StaffCapability) {
  if (["admin", "super_admin"].includes(actor.role)) return;
  if (config.dataProvider === "supabase") {
    const allowedRoles = (Object.keys(capabilities) as EventStaffRole[])
      .filter((role) => capabilities[role].includes(capability));
    const now = new Date().toISOString();
    const { data, error } = await createSupabaseAdminClient().from("event_staff_assignments")
      .select("id")
      .eq("user_id", actor.id)
      .eq("event_id", eventId)
      .eq("active", true)
      .lte("starts_at", now)
      .or(`ends_at.is.null,ends_at.gt.${now}`)
      .in("role", allowedRoles)
      .limit(1);
    if (!error && data?.length) return;
  } else {
    const operations = await readOperationsData();
    if (hasLocalEventCapability(operations, actor, eventId, capability)) return;
  }
  throw new PublicApiError("EVENT_ASSIGNMENT_REQUIRED", "You are not assigned to this event.", 403);
}

export async function listAccessibleEventIds(actor: SessionUser) {
  if (["admin", "super_admin"].includes(actor.role)) return null;
  if (config.dataProvider === "supabase") {
    const now = new Date().toISOString();
    const { data, error } = await createSupabaseAdminClient().from("event_staff_assignments")
      .select("event_id")
      .eq("user_id", actor.id)
      .eq("active", true)
      .lte("starts_at", now)
      .or(`ends_at.is.null,ends_at.gt.${now}`);
    if (error) throw new PublicApiError("STAFF_ASSIGNMENTS_UNAVAILABLE", "Staff assignments are temporarily unavailable.", 503);
    return [...new Set((data || []).map((item) => String(item.event_id)))];
  }
  const operations = await readOperationsData();
  return [...new Set(operations.eventStaffAssignments
    .filter((assignment) => assignment.userId === actor.id && assignmentIsCurrent(assignment))
    .map((assignment) => assignment.eventId))];
}

function normalizedAssignment(row: Record<string, unknown>): EventStaffAssignment {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    eventId: String(row.event_id),
    role: String(row.role) as EventStaffRole,
    active: Boolean(row.active),
    startsAt: String(row.starts_at),
    endsAt: row.ends_at ? String(row.ends_at) : undefined,
    assignedBy: String(row.assigned_by),
    revokedBy: row.revoked_by ? String(row.revoked_by) : undefined,
    revokedAt: row.revoked_at ? String(row.revoked_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function normalizedAudit(row: Record<string, unknown>): EventStaffAssignmentAudit {
  return {
    id: String(row.id),
    assignmentId: String(row.assignment_id),
    eventId: String(row.event_id),
    subjectUserId: String(row.subject_user_id),
    actorId: String(row.actor_id),
    action: String(row.action) as EventStaffAssignmentAudit["action"],
    role: String(row.role) as EventStaffRole,
    startsAt: String(row.starts_at),
    endsAt: row.ends_at ? String(row.ends_at) : undefined,
    createdAt: String(row.created_at),
  };
}

export async function listStaffAdministration() {
  const operations = await readOperationsData();
  if (config.dataProvider !== "supabase") {
    return {
      users: operations.users.map(({ passwordHash, ...user }) => { void passwordHash; return user; }),
      assignments: operations.eventStaffAssignments,
      audits: operations.eventStaffAssignmentAudits.slice(-200),
    };
  }
  const client = createSupabaseAdminClient();
  const [assignmentResult, auditResult] = await Promise.all([
    client.from("event_staff_assignments").select("*").order("created_at", { ascending: false }).limit(500),
    client.from("event_staff_assignment_audit").select("*").order("created_at", { ascending: false }).limit(200),
  ]);
  if (assignmentResult.error || auditResult.error) {
    throw new PublicApiError("STAFF_ASSIGNMENTS_UNAVAILABLE", "Staff assignments are temporarily unavailable.", 503);
  }
  return {
    users: operations.users.map(({ passwordHash, ...user }) => { void passwordHash; return user; }),
    assignments: (assignmentResult.data || []).map((row) => normalizedAssignment(row)),
    audits: (auditResult.data || []).map((row) => normalizedAudit(row)),
  };
}

export async function manageStaffAssignment(input: {
  action: "assign" | "revoke";
  assignmentId?: string;
  userId?: string;
  eventId?: string;
  role?: EventStaffRole;
  startsAt?: string;
  endsAt?: string;
  actor: SessionUser;
}) {
  if (config.dataProvider === "supabase") {
    const { data, error } = await createSupabaseAdminClient().rpc("skie_manage_event_staff_assignment", {
      p_action: input.action,
      p_assignment_id: input.assignmentId || null,
      p_user_id: input.userId || null,
      p_event_id: input.eventId || null,
      p_role: input.role || null,
      p_starts_at: input.startsAt || null,
      p_ends_at: input.endsAt || null,
      p_actor_id: input.actor.id,
    });
    if (error) throw new PublicApiError("STAFF_ASSIGNMENT_REJECTED", "The staff assignment could not be changed.", 409);
    const row = Array.isArray(data) ? data[0] : data;
    return normalizedAssignment(row as Record<string, unknown>);
  }

  return mutateOperationsData((operations) => {
    const now = new Date().toISOString();
    let assignment: EventStaffAssignment | undefined;
    let action: EventStaffAssignmentAudit["action"];
    if (input.action === "revoke") {
      assignment = operations.eventStaffAssignments.find((item) => item.id === input.assignmentId);
      if (!assignment) throw new PublicApiError("STAFF_ASSIGNMENT_NOT_FOUND", "Staff assignment was not found.", 404);
      assignment.active = false;
      assignment.revokedAt = now;
      assignment.revokedBy = input.actor.id;
      assignment.updatedAt = now;
      action = "revoked";
    } else {
      if (!input.userId || !input.eventId || !input.role || !input.startsAt) {
        throw new PublicApiError("INVALID_STAFF_ASSIGNMENT", "Staff, event, role and start time are required.", 422);
      }
      const target = operations.users.find((item) => item.id === input.userId);
      if (!target || !["scanner_only", "door_staff", "admin", "super_admin"].includes(target.role)) {
        throw new PublicApiError("INVALID_STAFF_ROLE", "The selected account is not eligible for event staff access.", 409);
      }
      assignment = operations.eventStaffAssignments.find((item) => (
        item.userId === input.userId && item.eventId === input.eventId && item.role === input.role
      ));
      action = assignment ? "updated" : "assigned";
      if (assignment) {
        Object.assign(assignment, {
          active: true, startsAt: input.startsAt, endsAt: input.endsAt,
          assignedBy: input.actor.id, revokedAt: undefined, revokedBy: undefined, updatedAt: now,
        });
      } else {
        assignment = {
          id: randomId("staff"), userId: input.userId, eventId: input.eventId, role: input.role,
          active: true, startsAt: input.startsAt, endsAt: input.endsAt, assignedBy: input.actor.id,
          createdAt: now, updatedAt: now,
        };
        operations.eventStaffAssignments.push(assignment);
      }
    }
    operations.eventStaffAssignmentAudits.push({
      id: randomId("staffaudit"), assignmentId: assignment.id, eventId: assignment.eventId,
      subjectUserId: assignment.userId, actorId: input.actor.id, action, role: assignment.role,
      startsAt: assignment.startsAt, endsAt: assignment.endsAt, createdAt: now,
    });
    operations.auditLogs.push({
      id: randomId("audit"), actorId: input.actor.id, actorEmail: input.actor.email,
      action: `staff_assignment.${action}`, entityType: "event_staff_assignment", entityId: assignment.id,
      metadata: { eventId: assignment.eventId, subjectUserId: assignment.userId, role: assignment.role }, createdAt: now,
    });
    return assignment;
  });
}

export async function setStaffAccountRole(actor: SessionUser, userId: string, role: UserRole) {
  if (actor.role !== "super_admin") throw new PublicApiError("FORBIDDEN", "Only a super administrator can change staff account roles.", 403);
  if (actor.id === userId || role === "super_admin") throw new PublicApiError("ROLE_CHANGE_REJECTED", "That role change is not permitted.", 409);
  const allowed: UserRole[] = ["customer", "scanner_only", "door_staff", "admin"];
  if (!allowed.includes(role)) throw new PublicApiError("INVALID_STAFF_ROLE", "Select a permitted account role.", 422);
  if (config.dataProvider === "supabase") {
    const { data: current, error: readError } = await createSupabaseAdminClient().from("profiles").select("role").eq("id", userId).single();
    if (readError || current?.role === "super_admin") throw new PublicApiError("ROLE_CHANGE_REJECTED", "That role change is not permitted.", 409);
    const { error } = await createSupabaseAdminClient().from("profiles").update({ role }).eq("id", userId);
    if (error) throw new PublicApiError("ROLE_CHANGE_REJECTED", "The account role could not be changed.", 409);
  }
  return mutateOperationsData((operations) => {
    const target = operations.users.find((item) => item.id === userId);
    if (!target || target.role === "super_admin") throw new PublicApiError("ROLE_CHANGE_REJECTED", "That role change is not permitted.", 409);
    target.role = role;
    target.updatedAt = new Date().toISOString();
    operations.auditLogs.push({
      id: randomId("audit"), actorId: actor.id, actorEmail: actor.email, action: "staff.role_changed",
      entityType: "user", entityId: userId, metadata: { role }, createdAt: target.updatedAt,
    });
    return { id: target.id, role: target.role };
  });
}
