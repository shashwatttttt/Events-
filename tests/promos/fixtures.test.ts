import { describe, expect, it } from "vitest";
import { promoFixture } from "../fixtures";

describe("promo fixtures", () => {
  it("tracks redemptions separately from discounted ticket units", () => {
    const promo = promoFixture({ redemptionCount: 1, usedTicketUnits: 4 });
    expect(promo.redemptionCount).toBe(1);
    expect(promo.usedTicketUnits).toBe(4);
  });

  it("uses AUD for fixed discounts", () => {
    expect(promoFixture({ type: "fixed", percentOff: undefined, amountOffCents: 1_000 })).toMatchObject({
      type: "fixed",
      currency: "AUD",
      amountOffCents: 1_000,
    });
  });
});
