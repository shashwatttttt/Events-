import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: "customer",
  listPaymentRecovery: vi.fn(),
  markPaymentRecoveryResolved: vi.fn(),
  recordPaymentRecoveryAction: vi.fn(),
}));

vi.mock("@/lib/security/session", () => ({
  requireUser: vi.fn(async (allowedRoles: string[]) => {
    if (!allowedRoles.includes(mocks.role)) throw new Error("FORBIDDEN");
    return {
      id: `local-${mocks.role}`,
      firstName: "Local",
      lastName: "Actor",
      email: `${mocks.role}@local.invalid`,
      role: mocks.role,
    };
  }),
}));

vi.mock("@/lib/payments", () => ({
  expireStripeCheckoutSession: vi.fn(),
  requestStripeFullRefund: vi.fn(),
  retrieveStripeSnapshotForRecovery: vi.fn(),
}));

vi.mock("@/lib/operations", () => ({
  fulfillStripeOrder: vi.fn(),
  listPaymentRecovery: mocks.listPaymentRecovery,
  markPaymentRecoveryResolved: mocks.markPaymentRecoveryResolved,
  recordPaymentRecoveryAction: mocks.recordPaymentRecoveryAction,
  recordStripeCheckoutTerminalEvent: vi.fn(),
}));

const recoveryItem = {
  kind: "order",
  orderId: "local-order",
  reservationId: "local-reservation",
  eventId: "local-event",
  sessionId: null,
  paymentIntentId: "local-payment-intent",
  totalCents: 1000,
  currency: "AUD",
};

function postRequest() {
  return new Request("http://localhost/api/admin/payment-recovery", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orderId: recoveryItem.orderId,
      reservationId: recoveryItem.reservationId,
      action: "mark_resolved",
      operationId: "local-operation-001",
    }),
  });
}

describe("payment recovery role boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = "customer";
    mocks.listPaymentRecovery.mockResolvedValue([recoveryItem]);
    mocks.markPaymentRecoveryResolved.mockResolvedValue(undefined);
    mocks.recordPaymentRecoveryAction.mockResolvedValue(undefined);
  });

  it.each(["customer", "door_staff", "scanner_only"])("rejects %s recovery actions", async (role) => {
    mocks.role = role;
    const { POST } = await import("@/app/api/admin/payment-recovery/route");
    const response = await POST(postRequest());
    expect(response.status).toBe(403);
    expect(mocks.listPaymentRecovery).not.toHaveBeenCalled();
    expect(mocks.recordPaymentRecoveryAction).not.toHaveBeenCalled();
  });

  it.each(["admin", "super_admin"])("allows %s protected recovery actions", async (role) => {
    mocks.role = role;
    const { POST } = await import("@/app/api/admin/payment-recovery/route");
    const response = await POST(postRequest());
    expect(response.status).toBe(200);
    expect(mocks.markPaymentRecoveryResolved).toHaveBeenCalledWith(recoveryItem.reservationId);
    expect(mocks.recordPaymentRecoveryAction).toHaveBeenCalledTimes(2);
  });
});
