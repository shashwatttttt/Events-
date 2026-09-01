import { describe, expect, it } from "vitest";
import { repairOperationsCustomer } from "@/lib/security/auth-service";
import { hasLocalEventCapability } from "@/lib/staff";
import { operationsFixture, sessionUserFixture, userFixture } from "../fixtures";

describe("idempotent customer repair", () => {
  it("repairs a missing customer once and records one safe audit marker", () => {
    const operations = operationsFixture({ users: [], auditLogs: [] });
    const identity = {
      id: "usr_repair",
      email: "repair@example.test",
      firstName: "Repair",
      lastName: "Fixture",
      phone: "+61400000000",
      instagram: "@repair",
    };
    repairOperationsCustomer(operations, identity, "customer", true, "2026-07-22T00:00:00.000Z");
    repairOperationsCustomer(operations, identity, "customer", true, "2026-07-22T00:01:00.000Z");
    expect(operations.users).toHaveLength(1);
    expect(operations.auditLogs.filter((item) => item.action === "customer.identity_repaired")).toHaveLength(1);
  });

  it("updates identity fields without downgrading an existing privileged role", () => {
    const existing = userFixture({ id: "usr_repair", firstName: "Old" }, "door_staff");
    const operations = operationsFixture({ users: [existing], auditLogs: [] });
    repairOperationsCustomer(operations, {
      id: existing.id,
      email: existing.email,
      firstName: "New",
      lastName: existing.lastName,
      phone: existing.phone,
      instagram: existing.instagram,
    }, "customer", false);
    expect(operations.users[0]).toMatchObject({ firstName: "New", role: "door_staff" });
  });
});

describe("local staff capability parity", () => {
  it("honours event, role and assignment windows", () => {
    const actor = sessionUserFixture({ id: "usr_door" }, "door_staff");
    const operations = operationsFixture({
      eventStaffAssignments: [{
        id: "staff_fixture", userId: actor.id, eventId: "event_a", role: "door_staff", active: true,
        startsAt: "2026-07-22T00:00:00.000Z", endsAt: "2026-07-22T02:00:00.000Z",
        assignedBy: "usr_admin", createdAt: "2026-07-22T00:00:00.000Z", updatedAt: "2026-07-22T00:00:00.000Z",
      }],
    });
    expect(hasLocalEventCapability(operations, actor, "event_a", "redeem", new Date("2026-07-22T01:00:00.000Z"))).toBe(true);
    expect(hasLocalEventCapability(operations, actor, "event_b", "redeem", new Date("2026-07-22T01:00:00.000Z"))).toBe(false);
    expect(hasLocalEventCapability(operations, actor, "event_a", "redeem", new Date("2026-07-22T03:00:00.000Z"))).toBe(false);
  });

  it("does not grant redemption capability to scanner-only assignments", () => {
    const actor = sessionUserFixture({ id: "usr_scanner" }, "scanner_only");
    const operations = operationsFixture({
      eventStaffAssignments: [{
        id: "staff_scanner", userId: actor.id, eventId: "event_a", role: "scanner_only", active: true,
        startsAt: "2026-07-22T00:00:00.000Z", assignedBy: "usr_admin",
        createdAt: "2026-07-22T00:00:00.000Z", updatedAt: "2026-07-22T00:00:00.000Z",
      }],
    });
    expect(hasLocalEventCapability(operations, actor, "event_a", "scan", new Date("2026-07-22T01:00:00.000Z"))).toBe(true);
    expect(hasLocalEventCapability(operations, actor, "event_a", "redeem", new Date("2026-07-22T01:00:00.000Z"))).toBe(false);
  });
});
