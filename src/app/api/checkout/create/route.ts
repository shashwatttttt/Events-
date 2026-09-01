import { z } from "zod";
import { captureAnalyticsSafely } from "@/lib/analytics/store";
import { readSiteData } from "@/lib/data/documents";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest, PublicApiError } from "@/lib/http";
import { queueMetaCheckout } from "@/lib/meta/conversions";
import { readMetaRequestContext } from "@/lib/meta/request-context";
import { createOrder, fulfillOrder } from "@/lib/operations";
import { createCheckoutForOrder } from "@/lib/payments";
import { releaseCheckoutBeforeProvider } from "@/lib/payments/checkout-cleanup";
import { failPostCheckoutInitialization, restartUnpaidPostCheckout } from "@/lib/post-approval/cleanup";
import { createZeroPaymentGuestlistOrder } from "@/lib/post-approval/guestlist-service";
import {
  assertGuestlistApprovalSchemaReady,
  assertPostCheckoutOperationsReady,
  assertPostCheckoutSchemaReady,
} from "@/lib/post-approval/readiness";
import { resumeExistingPostCheckout } from "@/lib/post-approval/resume";
import { createPostCheckoutOrder, isPostCheckoutApprovalEvent } from "@/lib/post-approval/service";
import { getPromoDiscountTypeById, type PromoDiscountType } from "@/lib/promos/service";
import { enforceRateLimit, requestKey } from "@/lib/rate-limit";
import { getUserProfile } from "@/lib/security/auth-service";
import { requireUser } from "@/lib/security/session";
import {
  checkoutOrderPayloadSchema,
  orderPayloadSchema,
  promoExpectationMatches,
  validatePromoCheckoutBinding,
} from "@/lib/validate";

const postCheckoutRequestSchema = orderPayloadSchema.extend({
  authorizationAccepted: z.literal(true),
  termsAccepted: z.literal(true),
  privacyAccepted: z.literal(true),
  entryAccepted: z.literal(true),
  ageAccepted: z.literal(true),
}).strict().superRefine((value, context) => {
  validatePromoCheckoutBinding(value, context);
  if (value.promoExpectation?.totalCents === 0
    && !value.promoExpectation.guestlistApplication) {
    context.addIssue({
      code: "custom",
      message: "A zero-value approval checkout requires a guest-list application code.",
      path: ["promoExpectation", "totalCents"],
    });
  }
});

function requireExpectedSubtotal(value: number | undefined) {
  if (value === undefined) {
    throw new PublicApiError(
      "CHECKOUT_REFRESH_REQUIRED",
      "Checkout was updated. Refresh the page and review the displayed total before continuing.",
      409,
    );
  }
  return value;
}

function promoSnapshotForOrder(order: {
  promoCodeSnapshot?: string;
  subtotalCents: number;
  discountCents?: number;
  totalCents: number;
}, promoType?: PromoDiscountType) {
  if (!order.promoCodeSnapshot) return null;
  return {
    code: order.promoCodeSnapshot,
    subtotalCents: order.subtotalCents,
    discountCents: Number(order.discountCents || 0),
    totalCents: order.totalCents,
    trackingOnly: promoType === "tracking",
    guestlistApplication: promoType === "guestlist",
  };
}

function promoSnapshotIsCurrent(
  expectation: {
    code: string;
    subtotalCents: number;
    discountCents: number;
    totalCents: number;
    trackingOnly: boolean;
    guestlistApplication: boolean;
  } | undefined,
  order: {
    promoCodeSnapshot?: string;
    subtotalCents: number;
    discountCents?: number;
    totalCents: number;
  },
  promoType?: PromoDiscountType,
) {
  const actual = promoSnapshotForOrder(order, promoType);
  return expectation && actual
    ? promoExpectationMatches(expectation, actual)
    : !expectation && !actual && Number(order.discountCents || 0) === 0;
}

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    const user = await requireUser(["customer"]);
    await enforceRateLimit(requestKey(request, "checkout", user.id), 12, 60_000);
    const profile = await getUserProfile(user.id);
    const metaContext = readMetaRequestContext(request);
    const raw = await parseJsonRequest(request, z.unknown(), 16_384);
    const eventId = raw && typeof raw === "object" && "eventId" in raw
      ? String(raw.eventId || "")
      : "";
    const site = await readSiteData();
    const event = site.events.find((item) => item.id === eventId);
    const postCheckout = Boolean(event && isPostCheckoutApprovalEvent(event));

    if (postCheckout && event) {
      const payload = postCheckoutRequestSchema.parse(raw);
      const expectedSubtotalCents = requireExpectedSubtotal(payload.expectedSubtotalCents);
      const existing = await resumeExistingPostCheckout(user.id, event.id, {
        ticketTypeId: payload.ticketTypeId,
        ticketQuantity: payload.ticketQuantity,
        products: payload.products,
        expectedSubtotalCents,
        promoCode: payload.promoCode,
        promoExpectation: payload.promoExpectation,
      });
      if (existing) {
        return noStoreJson({
          applicationId: existing.applicationId,
          orderId: existing.orderId,
          formDueAt: existing.formDueAt,
          checkout: existing.checkout,
          resumed: true,
        });
      }

      await assertPostCheckoutSchemaReady();
      const zeroPaymentGuestlist = payload.promoExpectation?.guestlistApplication === true
        && payload.promoExpectation.totalCents === 0;
      if (payload.promoExpectation?.guestlistApplication) {
        await assertGuestlistApprovalSchemaReady();
      }
      if (!zeroPaymentGuestlist) {
        await assertPostCheckoutOperationsReady();
      }

      const prepared = zeroPaymentGuestlist
        ? await createZeroPaymentGuestlistOrder(user, payload)
        : await createPostCheckoutOrder(user, payload);
      if (!zeroPaymentGuestlist && prepared.order.subtotalCents !== expectedSubtotalCents) {
        await restartUnpaidPostCheckout(prepared.order.id, "CHECKOUT_PRICE_CHANGED");
        throw new PublicApiError(
          "CHECKOUT_PRICE_CHANGED",
          "Ticket or add-on prices changed before checkout. Refresh the page and review the new total; no payment or ticket was created.",
          409,
        );
      }
      const promoType = await getPromoDiscountTypeById(prepared.order.promoCodeId);
      const promoMatches = promoSnapshotIsCurrent(
        payload.promoExpectation,
        prepared.order,
        promoType,
      );

      if (!zeroPaymentGuestlist
        && (!promoMatches || (payload.promoCode && !prepared.order.promoCodeId))) {
        await restartUnpaidPostCheckout(prepared.order.id, "PROMO_QUOTE_CHANGED");
        throw new PublicApiError(
          "PROMO_QUOTE_CHANGED",
          "The promo price changed before checkout. Apply the promo again; no card authorisation was created.",
          409,
        );
      }
      if (!zeroPaymentGuestlist
        && (payload.promoExpectation?.guestlistApplication === true) !== (promoType === "guestlist")) {
        await restartUnpaidPostCheckout(prepared.order.id, "GUESTLIST_PROMO_TYPE_CHANGED");
        throw new PublicApiError(
          "PROMO_QUOTE_CHANGED",
          "The guest-list code changed before checkout. Apply it again; no payment or ticket was created.",
          409,
        );
      }

      const ticketLine = prepared.order.items.find((item) => item.kind === "ticket");
      await captureAnalyticsSafely({
        eventName: "checkout_started",
        source: "server",
        deduplicationKey: `checkout_started:${prepared.order.id}`,
        eventId: prepared.order.eventId,
        ticketTypeId: ticketLine?.referenceId,
        customerId: prepared.order.userId,
        quantity: ticketLine?.quantity,
        occurredAt: prepared.order.createdAt,
      });
      if (prepared.order.promoCodeId) {
        await captureAnalyticsSafely({
          eventName: "promo_applied",
          source: "server",
          deduplicationKey: `promo_applied:${prepared.order.id}`,
          eventId: prepared.order.eventId,
          promoCodeId: prepared.order.promoCodeId,
          customerId: prepared.order.userId,
          quantity: ticketLine?.quantity,
          occurredAt: prepared.order.createdAt,
        });
      }
      await queueMetaCheckout(prepared.order, metaContext).catch(() => undefined);

      if (zeroPaymentGuestlist) {
        return noStoreJson({
          order: prepared.order,
          applicationId: prepared.applicationId,
          formDueAt: prepared.formDueAt,
          checkout: {
            provider: "guestlist",
            url: `/account/applications/${encodeURIComponent(prepared.order.id)}`,
          },
        }, 201);
      }

      try {
        const checkout = await createCheckoutForOrder(
          prepared.order,
          profile?.email || user.email,
          { postCheckoutApproval: true },
        );
        return noStoreJson({
          order: prepared.order,
          applicationId: prepared.applicationId,
          formDueAt: prepared.formDueAt,
          checkout,
        }, 201);
      } catch (error) {
        await failPostCheckoutInitialization(
          prepared.order.id,
          error instanceof Error ? error.message : "CHECKOUT_INITIALIZATION_FAILED",
        ).catch(() => undefined);
        throw error;
      }
    }

    const standardPayload = checkoutOrderPayloadSchema.parse(raw);
    const expectedSubtotalCents = requireExpectedSubtotal(standardPayload.expectedSubtotalCents);
    if (standardPayload.promoExpectation?.guestlistApplication) {
      throw new PublicApiError(
        "GUESTLIST_APPLICATION_MODE_REQUIRED",
        "Guest-list codes require the event application and approval checkout.",
        422,
      );
    }
    const approvalOnlyProduct = standardPayload.products
      .map((requested) => site.products.find((product) => product.id === requested.productId
        && product.eventId === event?.id
        && event.productIds.includes(product.id)))
      .find((product) => product?.requiresApproval);
    if (approvalOnlyProduct && event?.ticketMode !== "invite_only") {
      throw new PublicApiError(
        "PRODUCT_APPROVAL_REQUIRED",
        `${approvalOnlyProduct.name} requires an approved ticket allocation.`,
        409,
      );
    }

    const order = await createOrder(user, standardPayload);
    if (order.subtotalCents !== expectedSubtotalCents) {
      await releaseCheckoutBeforeProvider(order);
      throw new PublicApiError(
        "CHECKOUT_PRICE_CHANGED",
        "Ticket or add-on prices changed before checkout. Refresh the page and review the new total; no payment was created.",
        409,
      );
    }
    const standardPromoType = await getPromoDiscountTypeById(order.promoCodeId);
    if (standardPromoType === "guestlist") {
      await releaseCheckoutBeforeProvider(order);
      throw new PublicApiError(
        "GUESTLIST_APPLICATION_MODE_REQUIRED",
        "Guest-list codes cannot issue an instant free ticket. Use the application checkout.",
        422,
      );
    }
    if (!promoSnapshotIsCurrent(standardPayload.promoExpectation, order, standardPromoType)
      || (standardPayload.promoCode && !order.promoCodeId)) {
      await releaseCheckoutBeforeProvider(order);
      throw new PublicApiError(
        "PROMO_QUOTE_CHANGED",
        "The promo price changed before checkout. Apply the promo again; no payment was created.",
        409,
      );
    }

    const ticketLine = order.items.find((item) => item.kind === "ticket");
    await captureAnalyticsSafely({
      eventName: "checkout_started",
      source: "server",
      deduplicationKey: `checkout_started:${order.id}`,
      eventId: order.eventId,
      ticketTypeId: ticketLine?.referenceId,
      customerId: order.userId,
      quantity: ticketLine?.quantity,
      occurredAt: order.createdAt,
    });
    if (order.promoCodeId) {
      await captureAnalyticsSafely({
        eventName: "promo_applied",
        source: "server",
        deduplicationKey: `promo_applied:${order.id}`,
        eventId: order.eventId,
        promoCodeId: order.promoCodeId,
        customerId: order.userId,
        quantity: ticketLine?.quantity,
        occurredAt: order.createdAt,
      });
    }
    await queueMetaCheckout(order, metaContext).catch(() => undefined);
    if (order.totalCents === 0) {
      const fulfilled = await fulfillOrder(order.id, "free", `free_${order.id}`);
      await captureAnalyticsSafely({
        eventName: "payment_completed",
        source: "server",
        deduplicationKey: `payment_completed:${order.id}`,
        eventId: order.eventId,
        customerId: order.userId,
        revenueCents: 0,
        occurredAt: new Date().toISOString(),
      });
      const issuedTickets = Array.isArray(fulfilled.tickets) ? fulfilled.tickets : [];
      for (const ticket of issuedTickets as Array<{
        id: string;
        eventId: string;
        ticketTypeId: string;
        userId: string;
        createdAt: string;
      }>) {
        await captureAnalyticsSafely({
          eventName: "ticket_issued",
          source: "server",
          deduplicationKey: `ticket_issued:${ticket.id}`,
          eventId: ticket.eventId,
          ticketTypeId: ticket.ticketTypeId,
          customerId: ticket.userId,
          quantity: 1,
          occurredAt: ticket.createdAt,
        });
      }
      return noStoreJson({
        order: fulfilled.order,
        checkout: { provider: "free", url: `/payment/success?order=${encodeURIComponent(order.id)}` },
      }, 201);
    }
    const checkout = await createCheckoutForOrder(order, profile?.email || user.email);
    return noStoreJson({ order, checkout }, 201);
  } catch (error) {
    return apiError(error);
  }
}
