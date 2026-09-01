import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("commerce logic safety", () => {
  it("releases reservations when a Stripe session cannot be used or linked", () => {
    const payments = source("src/lib/payments/index.ts");

    expect(payments).toContain("async function abandonUnlinkedStripeSession");
    expect(payments).toContain("await stripe.checkout.sessions.expire(session.id)");
    expect(payments).toContain("await failCheckoutCreation(order)");
    expect(payments).toContain("if (!session.url)");
    expect((payments.match(/await abandonUnlinkedStripeSession\(stripe, session, order\)/g) || []).length)
      .toBeGreaterThanOrEqual(2);
  });

  it("does not release inventory while an unexpired orphan Stripe session may remain payable", () => {
    const payments = source("src/lib/payments/index.ts");
    const helperStart = payments.indexOf("async function abandonUnlinkedStripeSession");
    const helperEnd = payments.indexOf("function stripeClient", helperStart);
    const helper = payments.slice(helperStart, helperEnd);

    expect(helper).toContain("await markUnlinkedSessionForReview(order, session.id)");
    expect(helper.indexOf("markUnlinkedSessionForReview")).toBeLessThan(
      helper.indexOf("await failCheckoutCreation(order)"),
    );
    expect(helper).toContain("return false");
  });

  it("releases post-approval reservations when preparation fails or becomes zero value", () => {
    const service = source("src/lib/post-approval/service.ts");

    expect(service).toContain("async function releaseUnstartedPostCheckout");
    expect(service).toContain('rpc("skie_fail_post_checkout_initialization"');
    expect(service).toContain("await failNormalizedCheckoutCreation(order.checkoutAttemptId)");
    expect(service).toContain('releaseUnstartedPostCheckout(order, "POST_APPROVAL_ZERO_VALUE_ORDER")');
    expect(service).toContain("POST_APPROVAL_PREPARATION_FAILED");
    expect(service).toContain("preparePostCheckoutApplication");
  });

  it("keeps audit logging non-blocking after a durable application is prepared", () => {
    const service = source("src/lib/post-approval/service.ts");
    const preparedIndex = service.indexOf("prepared = await preparePostCheckoutApplication");
    const auditIndex = service.indexOf("await addPostCheckoutAudit", preparedIndex);
    const catchIndex = service.indexOf(".catch(() => undefined)", auditIndex);

    expect(preparedIndex).toBeGreaterThan(-1);
    expect(auditIndex).toBeGreaterThan(preparedIndex);
    expect(catchIndex).toBeGreaterThan(auditIndex);
  });

  it("blocks approval-only extras from ordinary direct and free checkout", () => {
    const checkoutRoute = source("src/app/api/checkout/create/route.ts");
    const promoService = source("src/lib/promos/service.ts");

    expect(checkoutRoute).toContain("approvalOnlyProduct");
    expect(checkoutRoute).toContain('event?.ticketMode !== "invite_only"');
    expect(checkoutRoute).toContain("PRODUCT_APPROVAL_REQUIRED");
    expect(promoService).toContain("product.requiresApproval");
    expect(promoService).toContain('String(event.ticketMode) !== POST_CHECKOUT_MODE');
  });

  it("makes promo quotes use the same event, ticket, product and allocation eligibility checks", () => {
    const promoService = source("src/lib/promos/service.ts");

    expect(promoService).toContain("canStartCheckout(event)");
    expect(promoService).toContain("hasEventPasswordAccess(event)");
    expect(promoService).toContain("isSalesWindowOpen(item)");
    expect(promoService).toContain("getNormalizedAllocation");
    expect(promoService).toContain("allocation.priceCents !== ticket.priceCents");
    expect(promoService).toContain("requested.quantity > product.maxPerOrder");
  });
});
