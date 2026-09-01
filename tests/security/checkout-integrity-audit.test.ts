import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutOrderPayloadSchema } from "@/lib/validate";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("checkout integrity audit", () => {
  it("binds every checkout to the subtotal displayed in the browser", () => {
    expect(checkoutOrderPayloadSchema.parse({
      eventId: "house",
      ticketTypeId: "general",
      ticketQuantity: 1,
      products: [],
      expectedSubtotalCents: 2500,
    })).toMatchObject({ expectedSubtotalCents: 2500 });

    const builder = source("src/components/CheckoutBuilder.tsx");
    const route = source("src/app/api/checkout/create/route.ts");
    expect(builder).toContain("expectedSubtotalCents: subtotal");
    expect(route).toContain("requireExpectedSubtotal");
    expect(route).toContain("prepared.order.subtotalCents !== expectedSubtotalCents");
    expect(route).toContain("order.subtotalCents !== expectedSubtotalCents");
    expect(route).toContain('"CHECKOUT_PRICE_CHANGED"');
    expect(route).toContain("releaseCheckoutBeforeProvider(order)");
    expect(route).toContain("restartUnpaidPostCheckout(prepared.order.id");
  });

  it("validates a free guest-list subtotal before activating its application", () => {
    const guestlist = source("src/lib/post-approval/guestlist-service.ts");
    const route = source("src/app/api/checkout/create/route.ts");
    const subtotalCheck = guestlist.indexOf("order.subtotalCents !== payload.expectedSubtotalCents");
    const applicationPreparation = guestlist.indexOf("prepared = await preparePostCheckoutApplication");
    expect(subtotalCheck).toBeGreaterThan(-1);
    expect(applicationPreparation).toBeGreaterThan(-1);
    expect(subtotalCheck).toBeLessThan(applicationPreparation);
    expect(guestlist).toContain('releaseUnstartedOrder(order.id, order.checkoutAttemptId, "CHECKOUT_PRICE_CHANGED")');
    expect(route).toContain("!zeroPaymentGuestlist && prepared.order.subtotalCents !== expectedSubtotalCents");
    expect(route).toContain("if (!zeroPaymentGuestlist");
  });

  it("uses a synchronous browser lock against rapid duplicate checkout submits", () => {
    const builder = source("src/components/CheckoutBuilder.tsx");
    expect(builder).toContain("const submittingRef = useRef(false)");
    expect(builder).toContain("if (submittingRef.current) return;");
    expect(builder).toContain("submittingRef.current = true");
    expect(builder).toContain("let redirecting = false");
    expect(builder).toContain("redirecting = true");
    expect(builder).toContain("if (!redirecting)");
    expect(builder).toContain("submittingRef.current = false");
  });

  it("binds resumed approval checkout sessions to the same cart and price", () => {
    const resume = source("src/lib/post-approval/resume.ts");
    expect(resume).toContain("expectedSubtotalCents: number");
    expect(resume).toContain("requested.expectedSubtotalCents === existing.subtotalCents");
    expect(resume).toContain('url: "/account?checkout=application-active"');
  });

  it("does not advertise allocation-only extras on direct checkout", () => {
    const directPage = source("src/app/(site)/checkout/event/[slug]/page.tsx");
    expect(directPage).toContain("&& !item.requiresApproval");
  });

  it("loads the authoritative normalized allocation in production", () => {
    const allocationPage = source("src/app/(site)/checkout/[allocationId]/page.tsx");
    expect(allocationPage).toContain('config.dataProvider === "supabase"');
    expect(allocationPage).toContain("getNormalizedAllocation(allocationId, user.id)");
  });

  it("shows an already fulfilled free checkout as complete for its owner", () => {
    const successPage = source("src/app/(site)/payment/success/page.tsx");
    expect(successPage).toContain("if (params.order)");
    expect(successPage).toContain("workspace.orders.find((item) => item.id === params.order)");
    expect(successPage).toContain('["paid", "fulfilled"].includes(order.status)');
    expect(successPage).toContain("workspace.orders.some((item) => item.id === result.order?.id)");
  });

  it("does not tell free guest-list applicants that card capture is mandatory", () => {
    const accountPage = source("src/app/(site)/account/page.tsx");
    expect(accountPage).toContain("Where payment is required, fulfilment also waits for verified payment.");
    expect(accountPage).not.toContain("submitted, approved and payment is captured");
    expect(accountPage).toContain("Tickets appear here after fulfilment.");
  });
});
