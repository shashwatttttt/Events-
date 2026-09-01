import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("checkout customer-facing contract", () => {
  it("keeps the introduction compact", () => {
    const page = source("src/app/(site)/checkout/event/[slug]/page.tsx");
    expect(page).not.toContain("Application approval checkout");
    expect(page).toContain("<h1>{event.title}</h1>");
  });

  it("shows all open releases while locking allocations", () => {
    const builder = source("src/components/CheckoutBuilder.tsx");
    expect(builder).toContain("availableTicketTypes.map((type)");
    expect(builder).toContain("!allocation || item.id === allocation.ticketTypeId");
    expect(builder).toContain("Math.min(event.defaultTicketLimit, type.defaultMaxPerCustomer)");
    expect(builder).toContain("ticketTypeId: ticketType!.id");
  });

  it("retains every mandatory acknowledgement", () => {
    const builder = source("src/components/CheckoutBuilder.tsx");
    expect(builder).toContain("function consent(");
    for (const key of ["authorization", "age", "terms", "privacy", "entry"]) {
      expect(builder).toContain(`"${key}"`);
    }
  });

  it("continues directly to the form only when no payment remains", () => {
    const builder = source("src/components/CheckoutBuilder.tsx");
    expect(builder).toContain('guestlistNoPayment ? "Continue to application" : "Checkout"');
    expect(builder).toContain("Drink passes and other add-ons remain payable");
  });

  it("does not present tracking as a discount", () => {
    const builder = source("src/components/CheckoutBuilder.tsx");
    expect(builder).toContain('quote.trackingOnly ? "Tracking code" : "Promo"');
    expect(builder).not.toContain('quote.trackingOnly ? "No discount"');
  });
});
