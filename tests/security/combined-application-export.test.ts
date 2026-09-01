import { describe, expect, it } from "vitest";
import { buildCombinedApplicationCsv } from "@/lib/admin/combined-application-export";

describe("combined application export", () => {
  it("includes pre-checkout and post-checkout applications with dynamic answers", () => {
    const result = buildCombinedApplicationCsv(
      {
        events: [{ id: "event-1", title: "SKIE House Party", slug: "skie-house-party" }],
        applicationForms: [{
          id: "form-pre",
          fields: [{ key: "music_preference", label: "Music preference" }],
        }],
      },
      {
        users: [{
          id: "customer-1",
          firstName: "Jai",
          lastName: "Test",
          email: "jai@example.com",
          phone: "0400000000",
          instagram: "@jaitest",
          tags: ["returning"],
        }],
        consents: [],
        applications: [{
          id: "application-pre",
          eventId: "event-1",
          userId: "customer-1",
          status: "pending",
          createdAt: "2026-07-28T10:00:00.000Z",
          answers: { music_preference: "House" },
        }],
      },
      [{
        id: "application-post",
        eventId: "event-1",
        customerId: "customer-1",
        orderId: "order-1",
        formId: "form-post",
        formVersion: 2,
        status: "submitted",
        paymentStatus: "authorized",
        completionPercentage: 100,
        createdAt: "2026-07-29T10:00:00.000Z",
        submittedAt: "2026-07-29T10:05:00.000Z",
        formDueAt: "2026-07-29T12:00:00.000Z",
        captureBefore: "2026-07-30T10:00:00.000Z",
        submittedAnswers: {
          music_preference: "Afrobeats",
          group_size: 4,
        },
        draftAnswers: {
          music_preference: "Draft answer that must not win",
        },
        consentSnapshot: { termsAccepted: true },
        formSnapshot: {
          id: "form-post",
          name: "Post-checkout form",
          version: 2,
          fields: [{ key: "group_size", label: "Group size" }],
        },
        customer: {
          firstName: "Jai",
          lastName: "Test",
          email: "jai@example.com",
          phone: "0400000000",
          instagram: "@jaitest",
        },
        order: { totalCents: 12000, currency: "AUD" },
      }],
      null,
    );

    expect(result.records).toBe(2);
    expect(result.preCheckoutRecords).toBe(1);
    expect(result.postCheckoutRecords).toBe(1);
    expect(result.csv).toContain('"Application method"');
    expect(result.csv).toContain('"pre_checkout_application"');
    expect(result.csv).toContain('"post_checkout_approval"');
    expect(result.csv).toContain('"Question: Music preference [music_preference]"');
    expect(result.csv).toContain('"Question: Group size [group_size]"');
    expect(result.csv).toContain('"House"');
    expect(result.csv).toContain('"Afrobeats"');
    expect(result.csv).toContain('"4"');
    expect(result.csv).not.toContain("Draft answer that must not win");
  });

  it("exports saved post-checkout drafts when no submitted answers exist", () => {
    const result = buildCombinedApplicationCsv(
      { events: [{ id: "event-1", title: "Event", slug: "event" }] },
      { users: [], consents: [], applications: [] },
      [{
        id: "application-draft",
        eventId: "event-1",
        customerId: "customer-2",
        status: "draft",
        paymentStatus: "authorized",
        completionPercentage: 50,
        createdAt: "2026-07-29T10:00:00.000Z",
        draftAnswers: { dietary_requirements: "Vegetarian" },
        formSnapshot: {
          fields: [{ key: "dietary_requirements", label: "Dietary requirements" }],
        },
        customer: { firstName: "Draft", lastName: "Customer", email: "draft@example.com" },
      }],
      "event-1",
    );

    expect(result.records).toBe(1);
    expect(result.csv).toContain('"Saved draft"');
    expect(result.csv).toContain('"Vegetarian"');
    expect(result.filename).toBe("applications-all-methods-event-1.csv");
  });
});
