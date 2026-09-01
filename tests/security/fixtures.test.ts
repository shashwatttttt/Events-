import { describe, expect, it } from "vitest";
import { eventFixture, operationsFixture, staffFixtures, ticketFixture } from "../fixtures";

describe("security fixture foundation", () => {
  it("contains each privileged role without using a customer identity", () => {
    expect(staffFixtures().map((user) => user.role)).toEqual([
      "scanner_only",
      "door_staff",
      "admin",
      "super_admin",
    ]);
  });

  it("keeps tickets owned by their fixture customer and event", () => {
    const ticket = ticketFixture();
    const operations = operationsFixture({ tickets: [ticket] });
    expect(operations.tickets[0]).toMatchObject({
      userId: "usr_fixture_customer",
      eventId: eventFixture().id,
    });
  });
});
