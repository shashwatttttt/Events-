import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertCanonicalEventConfiguration, canonicalEventState } from "@/lib/event-state";
import { snapshotApplicationForm, validatePostCheckoutAnswers } from "@/lib/post-approval/service";
import type { ApplicationForm, EventItem } from "@/types/site";

const form: ApplicationForm = {
  id: "form_house_arrest",
  name: "HOUSE ARREST application",
  intro: "Tell us about your group.",
  active: true,
  fields: [
    {
      id: "field_name",
      key: "display_name",
      label: "Display name",
      type: "text",
      required: true,
      placeholder: "Your name",
      options: [],
      maxLength: 80,
    },
    {
      id: "field_email",
      key: "contact_email",
      label: "Contact email",
      type: "email",
      required: true,
      placeholder: "name@example.com",
      options: [],
      maxLength: 254,
    },
    {
      id: "field_vibe",
      key: "vibe",
      label: "Vibe",
      type: "select",
      required: false,
      placeholder: "Choose one",
      options: ["House", "Afro", "Open format"],
    },
    {
      id: "field_terms",
      key: "form_terms",
      label: "Application declaration",
      type: "checkbox",
      required: true,
      placeholder: "I confirm these answers are accurate.",
      options: [],
    },
  ],
};

function postCheckoutEvent(overrides: Partial<EventItem> = {}): EventItem {
  return {
    id: "evt_house_arrest",
    slug: "house-arrest",
    title: "HOUSE ARREST",
    date: "2026-10-31",
    time: "9:00 PM – LATE",
    venue: "Private venue",
    location: "Melbourne, VIC",
    genre: "HOUSE",
    teaser: "Private house-party energy.",
    description: "A SKIE event.",
    posterUrl: "",
    heroUrl: "",
    accent: "#5170ff",
    lineup: [],
    houseRules: ["18+ only"],
    faq: [],
    ageRestriction: "18+",
    lifecycle: "published",
    visibility: "public",
    ticketMode: "post_checkout_approval",
    featured: true,
    sponsorIds: [],
    formId: form.id,
    venueCapacity: 250,
    publicCapacity: 180,
    sponsorAllocation: 20,
    guestlistAllocation: 20,
    teamAllocation: 15,
    safetyBuffer: 15,
    defaultTicketLimit: 2,
    ticketTypes: [
      {
        id: "tt_entry",
        name: "Entry",
        description: "General entry",
        priceCents: 4900,
        capacity: 180,
        sold: 0,
        defaultMaxPerCustomer: 2,
        active: true,
      },
    ],
    productIds: [],
    ...overrides,
  };
}

describe("post-checkout application form snapshots", () => {
  it("creates a deterministic immutable-shaped snapshot", () => {
    const first = snapshotApplicationForm(form);
    const second = snapshotApplicationForm(structuredClone(form));

    expect(first).toEqual(second);
    expect(first.version).toBeGreaterThan(0);
    expect(first.fields).toHaveLength(4);
    expect(first.fields[0]).toMatchObject({ key: "display_name", required: true, maxLength: 80 });
  });

  it("changes the version when the form definition changes", () => {
    const original = snapshotApplicationForm(form);
    const changed = snapshotApplicationForm({
      ...form,
      fields: form.fields.map((field) => field.key === "display_name"
        ? { ...field, label: "Full name" }
        : field),
    });

    expect(changed.version).not.toBe(original.version);
  });

  it("allows optional fields to remain blank when required fields are complete", () => {
    const snapshot = snapshotApplicationForm(form);
    const completion = validatePostCheckoutAnswers(snapshot, {
      display_name: "Test Customer",
      contact_email: "test@example.com",
      form_terms: true,
    }, true);

    expect(completion).toBe(100);
  });

  it("rejects missing required answers", () => {
    const snapshot = snapshotApplicationForm(form);
    expect(() => validatePostCheckoutAnswers(snapshot, {
      display_name: "Test Customer",
      contact_email: "test@example.com",
    }, true)).toThrow("Application declaration is required.");
  });

  it("rejects unknown, invalid-choice and malformed email answers", () => {
    const snapshot = snapshotApplicationForm(form);
    expect(() => validatePostCheckoutAnswers(snapshot, {
      display_name: "Test Customer",
      contact_email: "test@example.com",
      form_terms: true,
      injected_field: "not allowed",
    }, true)).toThrow("unknown fields");

    expect(() => validatePostCheckoutAnswers(snapshot, {
      display_name: "Test Customer",
      contact_email: "not-an-email",
      form_terms: true,
    }, true)).toThrow("valid email address");

    expect(() => validatePostCheckoutAnswers(snapshot, {
      display_name: "Test Customer",
      contact_email: "test@example.com",
      vibe: "Invalid option",
      form_terms: true,
    }, true)).toThrow("invalid selection");
  });
});

describe("post-checkout event configuration", () => {
  it("is treated as an open sales flow", () => {
    expect(canonicalEventState(postCheckoutEvent())).toBe("sales_open");
    expect(() => assertCanonicalEventConfiguration(postCheckoutEvent())).not.toThrow();
  });

  it("requires a form and paid active ticket types", () => {
    expect(() => assertCanonicalEventConfiguration(postCheckoutEvent({ formId: undefined })))
      .toThrow("requires an application form");

    expect(() => assertCanonicalEventConfiguration(postCheckoutEvent({
      ticketTypes: [{
        id: "tt_free",
        name: "Free",
        description: "Free entry",
        priceCents: 0,
        capacity: 10,
        sold: 0,
        defaultMaxPerCustomer: 1,
        active: true,
      }],
    }))).toThrow("requires paid active ticket types");
  });

  it("rejects incompatible visibility", () => {
    expect(() => assertCanonicalEventConfiguration(postCheckoutEvent({ visibility: "hidden" })))
      .toThrow("hidden events must have ticket mode closed");
  });
});

describe("post-checkout timeout migration", () => {
  const migration = readFileSync(resolve(
    process.cwd(),
    "supabase/migrations/20260724000011_post_checkout_timeout_enforcement.sql",
  ), "utf8");

  it("enforces form, review and authorisation timeouts", () => {
    expect(migration).toContain("'form_expired','review_expired','authorization_expired'");
    expect(migration).toContain("v_application.review_due_at");
    expect(migration).toContain("v_application.capture_before - make_interval");
  });

  it("uses the unique cancel action for idempotent timeout handling", () => {
    expect(migration).toContain("on conflict (application_id,action_type) where action_type = 'cancel'");
    expect(migration).toContain("'cancel','requested'");
  });

  it("does not release the reservation before Stripe confirms cancellation", () => {
    expect(migration).not.toMatch(/update\s+public\.reservations/i);
  });
});
