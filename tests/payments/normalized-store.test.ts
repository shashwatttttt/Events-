import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripeCheckoutFixture } from "../fixtures";

const rpc = vi.fn();

vi.mock("@/lib/config", () => ({ config: { dataProvider: "supabase", currency: "AUD", ticketSecret: "fixture-ticket-secret" } }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc }) }));

describe("normalized payment store boundary", () => {
  beforeEach(() => rpc.mockReset());

  it("does not record an unpaid completed Session as payment", async () => {
    const { fulfilNormalizedPayment } = await import("@/lib/payments/transaction-store");
    await expect(fulfilNormalizedPayment(stripeCheckoutFixture({ paymentStatus: "unpaid" }))).resolves.toEqual({ awaitingPayment: true, duplicate: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes both immutable order references into the atomic payment RPC", async () => {
    rpc.mockResolvedValue({ data: [{ reservation_id: "res_fixture", order_id: "ord_fixture", duplicate: false, failure_code: null }], error: null });
    const { recordNormalizedPayment } = await import("@/lib/payments/transaction-store");
    await recordNormalizedPayment(stripeCheckoutFixture());
    expect(rpc).toHaveBeenCalledWith("skie_record_payment_received", expect.objectContaining({
      p_metadata_order_id: "ord_fixture",
      p_client_reference_order_id: "ord_fixture",
      p_amount_cents: 10_500,
      p_currency: "aud",
    }));
  });

  it("surfaces a durably returned reconciliation failure code", async () => {
    rpc.mockResolvedValue({ data: [{ reservation_id: "res_fixture", order_id: "ord_fixture", duplicate: false, failure_code: "PAYMENT_AMOUNT_MISMATCH" }], error: null });
    const { recordNormalizedPayment } = await import("@/lib/payments/transaction-store");
    await expect(recordNormalizedPayment(stripeCheckoutFixture())).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_MISMATCH" });
  });
});
