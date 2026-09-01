import { describe, expect, it } from "vitest";
import { customerBookingPathForEvents } from "@/lib/security/customer-landing";
import { eventFixture } from "./fixtures";

function bookableHouseArrest() {
  return eventFixture({
    id: "evt_house_arrest",
    slug: "house-arrest",
    title: "HOUSE ARREST",
    featured: false,
    date: "2026-11-01",
  });
}

describe("customer booking landing", () => {
  it("prioritises HOUSE ARREST over another featured bookable event", () => {
    expect(customerBookingPathForEvents([
      eventFixture({ id: "evt_featured", slug: "other-featured", title: "Other Featured" }),
      bookableHouseArrest(),
    ])).toBe("/events/house-arrest");
  });

  it("does not redirect customers to closed HOUSE ARREST records", () => {
    expect(customerBookingPathForEvents([
      { ...bookableHouseArrest(), ticketMode: "closed" },
      eventFixture({ id: "evt_open", slug: "open-event", title: "Open Event" }),
    ])).toBe("/events/open-event");
  });

  it("falls back to the events index when no event is bookable", () => {
    expect(customerBookingPathForEvents([
      eventFixture({ lifecycle: "draft", featured: false }),
    ])).toBe("/events");
  });
});
