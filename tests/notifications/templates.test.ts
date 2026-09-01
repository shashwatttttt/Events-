import { describe, expect, it } from "vitest";
import { renderGenericEmail, renderInAppNotification, renderTextNotification, renderTicketEmail } from "@/lib/notifications/templates";

describe("branded notification templates", () => {
  it.each([
    "application_received", "ticket_unlocked", "waitlist", "not_selected", "payment_confirmed",
    "refund_invalidation", "event_update", "event_cancellation", "event_reminder", "payment_reminder", "admin_manual_message",
  ] as const)("renders accessible HTML and plain text for %s", (templateKey) => {
    const result = renderGenericEmail(templateKey, {
      first_name: "Local", event_title: "SKIE Fixture", order_reference: "ORDER-1",
      account_url: "http://localhost:3000/account", message: "Doors changed.",
    });
    expect(result.subject).toContain("SKIE Fixture");
    expect(result.html).toContain("<!doctype html>");
    expect(result.html).toContain('alt="SKIE EVENTS"');
    expect(result.text).toContain("SKIE EVENTS / MELBOURNE");
    expect(result.attachments).toEqual([]);
  });

  it("renders channel-specific text and in-app messages without secrets", () => {
    const variables = { event_title: "SKIE Fixture", message: "Doors changed." };
    expect(renderTextNotification("event_update", variables).text).toContain("Doors changed.");
    expect(renderInAppNotification("event_update", variables)).toMatchObject({ title: "EVENT UPDATE", href: "/account" });
  });

  it("renders every ticket with one unique CID QR and add-ons", async () => {
    const result = await renderTicketEmail("ticket_issued", {
      customerName: "Fixture Customer", eventTitle: "SKIE Fixture", eventDate: "31 October 2026",
      eventTime: "8:30 PM", eventLocation: "Local Venue, Melbourne", purchaser: "Fixture Customer",
      orderReference: "ORDER-2", accountUrl: "http://localhost:3000/account",
      entryPolicyUrl: "http://localhost:3000/entry-policy", refundPolicyUrl: "http://localhost:3000/refund-policy",
      tickets: [
        { id: "ticket-one", code: "SKIE-ONE", name: "First Release", holderName: "Fixture Customer", verificationUrl: "http://localhost:3000/ticket/verify?ticket=one&token=secret-one" },
        { id: "ticket-two", code: "SKIE-TWO", name: "First Release", holderName: "Fixture Guest", verificationUrl: "http://localhost:3000/ticket/verify?ticket=two&token=secret-two" },
      ],
      products: [{ name: "Fixture Extra", quantity: 2, unitPriceCents: 500 }],
    });
    expect(result.attachments).toHaveLength(2);
    expect(new Set(result.attachments.map((item) => item.contentId)).size).toBe(2);
    expect(result.html.match(/src="cid:ticket-qr-/g)).toHaveLength(2);
    expect(result.html).toContain("2 × Fixture Extra");
    expect(result.text).toContain("Ticket 1: First Release");
    expect(result.text).toContain("Ticket 2: First Release");
    expect(result.text).not.toContain("secret-one");
    expect(result.text).not.toContain("secret-two");
  });

  it("supports a ticket resend with no optional add-ons", async () => {
    const result = await renderTicketEmail("ticket_resend", {
      customerName: "Fixture", eventTitle: "SKIE Fixture", eventDate: "31 October 2026",
      eventTime: "8:30 PM", eventLocation: "Melbourne", purchaser: "Fixture", orderReference: "ORDER-3",
      accountUrl: "http://localhost:3000/account", entryPolicyUrl: "http://localhost:3000/entry-policy",
      refundPolicyUrl: "http://localhost:3000/refund-policy",
      tickets: [{ id: "ticket-three", code: "SKIE-THREE", name: "Admission", holderName: "Fixture", verificationUrl: "http://localhost:3000/ticket/verify?ticket=three&token=secret" }],
      products: [],
    });
    expect(result.subject).toContain("resent");
    expect(result.attachments).toHaveLength(1);
    expect(result.html).not.toContain("Purchased add-ons");
  });
});
