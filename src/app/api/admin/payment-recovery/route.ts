import { randomUUID } from "node:crypto";
import { assertRequestOrigin, apiError, noStoreJson, PublicApiError } from "@/lib/http";
import {
  expireStripeCheckoutSession,
  requestStripeFullRefund,
  retrieveStripeSnapshotForRecovery,
} from "@/lib/payments";
import {
  fulfillStripeOrder,
  listPaymentRecovery,
  markPaymentRecoveryResolved,
  recordPaymentRecoveryAction,
  recordStripeCheckoutTerminalEvent,
} from "@/lib/operations";
import { requireUser } from "@/lib/security/session";

const ACTIONS = new Set(["retry_fulfilment", "refresh_stripe", "expire_session", "request_refund", "mark_resolved"]);

export async function GET() {
  try {
    await requireUser(["admin", "super_admin"]);
    return noStoreJson({ items: await listPaymentRecovery() });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["admin", "super_admin"]);
    const body = await request.json() as {
      orderId?: string;
      reservationId?: string;
      action?: string;
      operationId?: string;
    };
    if (!body.orderId || !body.reservationId || !body.action || !ACTIONS.has(body.action)) {
      throw new PublicApiError("RECOVERY_ACTION_INVALID", "Select a valid payment recovery action.");
    }
    const operationId = body.operationId && /^[a-zA-Z0-9_-]{8,120}$/.test(body.operationId)
      ? body.operationId
      : randomUUID();
    const idempotencyKey = `recovery:${body.action}:${body.orderId}:${operationId}`;
    const item = (await listPaymentRecovery()).find(
      (candidate) => candidate.orderId === body.orderId && candidate.reservationId === body.reservationId,
    );
    if (!item) throw new PublicApiError("RECOVERY_ITEM_NOT_FOUND", "The recovery item is no longer active.", 409);
    if (item.kind === "webhook") {
      throw new PublicApiError("WEBHOOK_RETRY_WORKER_REQUIRED", "Webhook failures are retried by the protected reconciliation worker.", 409);
    }

    await recordPaymentRecoveryAction({
      reservationId: item.reservationId,
      orderId: item.orderId,
      action: body.action,
      actor,
      idempotencyKey,
      status: "requested",
      safeMetadata: { eventId: item.eventId },
    });

    try {
      if (body.action === "retry_fulfilment" || body.action === "refresh_stripe") {
        if (!item.sessionId) throw new Error("RECOVERY_SESSION_MISSING");
        const snapshot = await retrieveStripeSnapshotForRecovery(item.sessionId);
        if (!snapshot) throw new Error("RECOVERY_PROVIDER_STATE_UNAVAILABLE");
        if (snapshot.paymentStatus === "paid") await fulfillStripeOrder(snapshot);
      } else if (body.action === "expire_session") {
        if (!item.sessionId) throw new Error("RECOVERY_SESSION_MISSING");
        await expireStripeCheckoutSession(item.sessionId);
        await recordStripeCheckoutTerminalEvent({
          eventId: `recovery_expire_${operationId}`,
          eventType: "checkout.session.expired",
          eventCreatedAtMs: Date.now(),
          sessionId: item.sessionId,
          metadataOrderId: item.orderId,
          clientReferenceOrderId: item.orderId,
          paymentStatus: "unpaid",
          amountTotal: item.totalCents,
          currency: item.currency,
          paymentIntentId: item.paymentIntentId || null,
        });
      } else if (body.action === "request_refund") {
        if (!item.paymentIntentId) throw new Error("RECOVERY_PAYMENT_INTENT_MISSING");
        await requestStripeFullRefund(item.paymentIntentId, idempotencyKey);
      } else if (body.action === "mark_resolved") {
        await markPaymentRecoveryResolved(item.reservationId);
      }
    } catch {
      await recordPaymentRecoveryAction({
        reservationId: item.reservationId,
        orderId: item.orderId,
        action: body.action,
        actor,
        idempotencyKey,
        status: "failed",
        safeMetadata: { eventId: item.eventId },
        safeErrorCode: "RECOVERY_ACTION_FAILED",
      }).catch(() => undefined);
      throw new PublicApiError("RECOVERY_ACTION_FAILED", "The recovery action did not complete. Review the item and retry safely.", 409);
    }

    await recordPaymentRecoveryAction({
      reservationId: item.reservationId,
      orderId: item.orderId,
      action: body.action,
      actor,
      idempotencyKey,
      status: "completed",
      safeMetadata: { eventId: item.eventId },
    });
    return noStoreJson({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
