import { describe, expect, it } from "vitest";
import {
  assertCanonicalEventConfiguration,
  canonicalEventState,
  canApplyToEvent,
  canStartCheckout,
  isEventPubliclyListed,
  isSalesWindowOpen,
} from "@/lib/event-state";
import { dateTimeLocalInputToIso, formatDateTimeLocalInput } from "@/lib/format";
import { assertValidSiteData } from "@/lib/site-validation";
import { normalizeSiteData } from "@/lib/site-content";
import { eventFixture, siteFixture } from "../fixtures";

describe("canonical event state", () => {
  it("maps sale, application, coming-soon and closed states consistently", () => {
    const sale = eventFixture();
    const application = eventFixture({ ticketMode: "invite_only" });
    const comingSoon = eventFixture({ visibility: "coming_soon", ticketMode: "coming_soon" });
    const closed = eventFixture({ visibility: "hidden", ticketMode: "closed" });
    expect(canonicalEventState(sale)).toBe("sales_open");
    expect(canStartCheckout(sale)).toBe(true);
    expect(canonicalEventState(application)).toBe("applications_open");
    expect(canApplyToEvent(application)).toBe(true);
    expect(canonicalEventState(comingSoon)).toBe("coming_soon");
    expect(canStartCheckout(comingSoon)).toBe(false);
    expect(isEventPubliclyListed(comingSoon)).toBe(true);
    expect(canonicalEventState(closed)).toBe("closed");
  });

  it("rejects contradictory lifecycle, visibility and ticket-mode combinations", () => {
    expect(() => assertCanonicalEventConfiguration(eventFixture({ visibility: "coming_soon" })))
      .toThrow(/coming-soon visibility/i);
    expect(() => assertCanonicalEventConfiguration(eventFixture({ lifecycle: "cancelled" })))
      .toThrow(/cancelled events must be hidden/i);
    expect(() => assertCanonicalEventConfiguration(eventFixture({
      ticketMode: "free_rsvp",
      ticketTypes: [{ ...eventFixture().ticketTypes[0], priceCents: 100 }],
    }))).toThrow(/zero price/i);
  });

  it("uses half-open ticket and product sales windows", () => {
    const item = { active: true, salesStartAt: "2026-07-22T01:00:00.000Z", salesEndAt: "2026-07-22T02:00:00.000Z" };
    expect(isSalesWindowOpen(item, new Date("2026-07-22T00:59:59.999Z"))).toBe(false);
    expect(isSalesWindowOpen(item, new Date("2026-07-22T01:00:00.000Z"))).toBe(true);
    expect(isSalesWindowOpen(item, new Date("2026-07-22T02:00:00.000Z"))).toBe(false);
  });

  it("enforces Melbourne and complete product/event relationships on CMS saves", () => {
    expect(() => assertValidSiteData(normalizeSiteData(siteFixture({ settings: { ...siteFixture().settings, timezone: "UTC" } }))))
      .toThrow(/Australia\/Melbourne/);
    expect(() => assertValidSiteData(normalizeSiteData(siteFixture({ events: [eventFixture({ productIds: [] })] }))))
      .toThrow(/must be assigned/i);
  });
});

describe("Melbourne wall time", () => {
  it("converts summer and winter wall times with the correct Melbourne offset", () => {
    expect(dateTimeLocalInputToIso("2026-01-15T12:00")).toBe("2026-01-15T01:00:00.000Z");
    expect(dateTimeLocalInputToIso("2026-07-15T12:00")).toBe("2026-07-15T02:00:00.000Z");
    expect(formatDateTimeLocalInput("2026-07-15T02:00:00.000Z")).toBe("2026-07-15T12:00");
  });

  it("rejects daylight-saving gaps and folds instead of guessing an instant", () => {
    expect(() => dateTimeLocalInputToIso("2026-10-04T02:30")).toThrow(/does not exist/i);
    expect(() => dateTimeLocalInputToIso("2026-04-05T02:30")).toThrow(/occurs twice/i);
  });
});
