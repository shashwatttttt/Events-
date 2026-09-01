import { apiError, createCorrelationId, noStoreJson } from "@/lib/http";
import { constructStripeEvent } from "@/lib/payments";
import {
  markStripeWebhookInboxResult,
  recordStripeWebhookInbox,
} from "@/lib/operations";
import { requestStripeWebhookReplay } from "@/lib/payments/webhook-replay";
import {
  classifyStripeWebhookProcessingFailure,
  normalizedStripeWebhookMetadata,
  processVerifiedStripeEvent,
} from "@/lib/payments/webhook-processor";

export const runtime = "nodejs";
export const maxDuration = 60;

const STRIPE_WEBHOOK_MAX_BYTES = 262_144;

type WebhookInboxResult = {
  duplicate?: boolean;
  inserted?: boolean;
  status?: string;
  event?: { status?: string };
};

export async function POST(request: Request) {
  const correlationId = createCorrelationId();
  let verifiedEvent = false;
  try {
    const signature = request.headers.get("stripe-signature");
    if (!signature) return noStoreJson({ error: "Missing signature." }, 400, correlationId);
    const declared = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declared) && declared > STRIPE_WEBHOOK_MAX_BYTES) {
      return noStoreJson({ error: "Stripe webhook payload is too large.", code: "WEBHOOK_PAYLOAD_TOO_LARGE" }, 413, correlationId);
    }
    const payload = Buffer.from(await request.arrayBuffer());
    if (payload.byteLength > STRIPE_WEBHOOK_MAX_BYTES) {
      return noStoreJson({ error: "Stripe webhook payload is too large.", code: "WEBHOOK_PAYLOAD_TOO_LARGE" }, 413, correlationId);
    }
    const event = constructStripeEvent(payload, signature);
    verifiedEvent = true;
    if (!event.livemode) return noStoreJson({ received: true, ignored: "mode_mismatch" }, 200, correlationId);

    const inbox = await recordStripeWebhookInbox(
      normalizedStripeWebhookMetadata(event, correlationId),
    ) as WebhookInboxResult;
    const duplicate = inbox.duplicate === true || inbox.inserted === false;
    const existingStatus = inbox.status || inbox.event?.status;
    if (duplicate && existingStatus === "processed") {
      return noStoreJson({ received: true, handled: true, duplicate: true }, 200, correlationId);
    }

    try {
      const handled = await processVerifiedStripeEvent(event);
      await markStripeWebhookInboxResult(event.id, "processed");
      return noStoreJson({ received: true, handled }, 200, correlationId);
    } catch (error) {
      const failure = classifyStripeWebhookProcessingFailure(error);
      await markStripeWebhookInboxResult(event.id, failure.status, failure.code).catch(() => undefined);
      if (failure.retry) {
        await requestStripeWebhookReplay(event.id).catch(() => undefined);
        console.error("Stripe webhook processing failed temporarily.", {
          correlationId,
          code: failure.code,
          type: event.type,
        });
        return noStoreJson({ error: "Stripe webhook processing failed.", code: failure.code }, 503, correlationId);
      }
      console.error("Stripe webhook requires payment recovery review.", {
        correlationId,
        code: failure.code,
        type: event.type,
      });
      return noStoreJson({ received: true, reviewRequired: true, code: failure.code }, 200, correlationId);
    }
  } catch (error) {
    if (verifiedEvent) {
      console.error("Verified Stripe webhook inbox failed.", {
        correlationId,
        code: "WEBHOOK_INBOX_UNAVAILABLE",
      });
      return noStoreJson({ error: "Stripe webhook inbox unavailable." }, 503, correlationId);
    }
    console.error("Stripe webhook signature verification failed.", {
      correlationId,
      code: "WEBHOOK_SIGNATURE_INVALID",
    });
    return apiError(error, 400, correlationId);
  }
}
