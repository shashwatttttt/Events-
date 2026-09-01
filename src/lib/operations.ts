import "server-only";
import { config } from "@/lib/config";
import { mutateOperationsData, mutateSiteData, readOperationsData, readSiteData, readSiteDataSnapshot } from "@/lib/data/documents";
import { sendTemplateEmail } from "@/lib/email";
import { enqueueOrderFulfilmentNotifications } from "@/lib/notifications/service";
import { hasEventPasswordAccess } from "@/lib/event-access";
import { canApplyToEvent, canStartCheckout, isSalesWindowOpen } from "@/lib/event-state";
import {
  assertStripeReferencesAreUnique,
  reconcilePaidStripeSession,
  reconcileTerminalStripeSession,
  type StripeCheckoutSnapshot,
} from "@/lib/payments/reconciliation";
import {
  assertReservationMatchesOrder,
  applyLocalDispute,
  applyLocalRefund,
  createReservationRecords,
  markLocalPaidUnfulfilled,
  markLocalWebhookResult,
  recordLocalStripeWebhook,
  recordLocalPaymentReceived,
} from "@/lib/payments/state";
import {
  applyNormalizedDispute,
  applyNormalizedRefund,
  fulfilNormalizedPayment,
  fulfilNormalizedOrder,
  expireNormalizedSessionState,
  getNormalizedAllocation,
  getNormalizedCustomerTransactions,
  getNormalizedOwnedTicket,
  getNormalizedOrderEntitlements,
  markNormalizedPaymentIntentTerminal,
  markNormalizedWebhookResult,
  listNormalizedPaymentRecovery,
  markNormalizedRecoveryResolved,
  PAYMENT_RECOVERY_STATUSES,
  recordNormalizedWebhook,
  recordNormalizedRecoveryAction,
  redeemNormalizedEntitlement,
  reserveNormalizedCheckout,
  searchNormalizedDoorTickets,
  upsertNormalizedAllocation,
  verifyNormalizedTicket,
  checkInNormalizedTicket,
} from "@/lib/payments/transaction-store";
import type { PaymentRecoveryItem } from "@/lib/payments/transaction-store";
import { randomId, sha256 } from "@/lib/security/crypto";
import { calculatePromoQuote, normalizePromoCode, PromoPolicyError } from "@/lib/promos/policy";
import { assertEventCapability } from "@/lib/staff";
import { createTicketToken, createTicketTokenHash, verifyTicketToken } from "@/lib/tickets/security";
import { applicationPayloadSchema, orderPayloadSchema } from "@/lib/validate";
import type {
  Application, ApplicationStatus, CartItem, CheckInRecord, Entitlement, OperationsData, Order,
  ReservationProductLine, ReservationTicketLine, SessionUser, StripeWebhookEventRecord, Ticket, TicketAllocation
} from "@/types/site";

function nowIso() { return new Date().toISOString(); }
function expiresInHours(hours: number) { return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(); }

export async function getCustomerWorkspace(userId: string) {
  const [site, ops] = await Promise.all([readSiteData(), readOperationsData()]);
  const transactions = config.dataProvider === "supabase"
    ? await getNormalizedCustomerTransactions(userId)
    : { allocations: ops.allocations, orders: ops.orders, tickets: ops.tickets, entitlements: ops.entitlements };
  return {
    timezone: site.settings.timezone,
    user: ops.users.find((item) => item.id === userId) || null,
    applications: ops.applications.filter((item) => item.userId === userId).map((item) => ({ ...item, event: site.events.find((event) => event.id === item.eventId) })),
    allocations: transactions.allocations.filter((item) => item.userId === userId).map((item) => ({ ...item, event: site.events.find((event) => event.id === item.eventId) })),
    orders: transactions.orders.filter((item) => item.userId === userId).map((item) => ({ ...item, event: site.events.find((event) => event.id === item.eventId) })),
    tickets: transactions.tickets.filter((item) => item.userId === userId).map((item) => ({ ...item, event: site.events.find((event) => event.id === item.eventId), entitlements: transactions.entitlements.filter((entitlement) => entitlement.orderId === item.orderId) }))
  };
}

export async function getOwnedTicket(ticketId: string, userId: string) {
  if (config.dataProvider === "supabase") return getNormalizedOwnedTicket(ticketId, userId);
  const ops = await readOperationsData();
  const ticket = ops.tickets.find((item) => item.id === ticketId && item.userId === userId) || null;
  return ticket ? { ticket, entitlements: ops.entitlements.filter((item) => item.orderId === ticket.orderId) } : null;
}

export async function submitApplication(user: SessionUser, raw: unknown, requestMeta?: { ip?: string; userAgent?: string }) {
  const payload = applicationPayloadSchema.parse(raw);
  const site = await readSiteData();
  const event = site.events.find((item) => item.id === payload.eventId);
  const form = site.forms.find((item) => item.id === payload.formId && item.id === event?.formId && item.active);
  if (!event || !form) throw new Error("This application is not available.");
  if (!canApplyToEvent(event)) throw new Error("This application is not available.");
  if (!(await hasEventPasswordAccess(event))) throw new Error("Enter the event password before applying.");
  const allowedKeys = new Set(form.fields.map((field) => field.key));
  if (Object.keys(payload.answers).length > form.fields.length) throw new Error("Application answers contain unknown fields.");
  for (const key of Object.keys(payload.answers)) {
    if (!allowedKeys.has(key)) throw new Error("Application answers contain unknown fields.");
  }
  for (const field of form.fields) {
    const answer = payload.answers[field.key];
    if (field.required && (answer === undefined || answer === false || String(answer).trim() === "")) throw new Error(`${field.label} is required.`);
    if (answer === undefined) continue;
    if (field.type === "checkbox" && typeof answer !== "boolean") throw new Error(`${field.label} must be true or false.`);
    if (field.type !== "checkbox" && typeof answer !== "string") throw new Error(`${field.label} must be text.`);
    if (typeof answer === "string" && answer.length > (field.maxLength || 2000)) throw new Error(`${field.label} is too long.`);
    if (["select", "radio"].includes(field.type) && (typeof answer !== "string" || !field.options.includes(answer))) {
      throw new Error(`${field.label} has an invalid selection.`);
    }
    if (field.type === "email" && (typeof answer !== "string" || !/^\S+@\S+\.\S+$/.test(answer))) {
      throw new Error(`${field.label} must be a valid email address.`);
    }
  }
  const createdAt = nowIso();
  const application = await mutateOperationsData((ops) => {
    const profile = ops.users.find((item) => item.id === user.id);
    if (!profile) throw new Error("Customer profile was not found.");
    const existing = ops.applications.find((item) => item.userId === user.id && item.eventId === event.id && !["rejected", "cancelled"].includes(item.status));
    if (existing) throw new Error("You already have an active application for this event.");
    const duplicateFlags: string[] = [];
    const instagram = String(payload.answers.instagram || profile.instagram || "").toLowerCase().replace(/^@/, "");
    for (const other of ops.users) {
      if (other.id === user.id) continue;
      if (other.email.toLowerCase() === profile.email.toLowerCase()) duplicateFlags.push("Same email as another profile");
      if (profile.phone && other.phone === profile.phone) duplicateFlags.push("Same phone as another profile");
      if (instagram && other.instagram.toLowerCase().replace(/^@/, "") === instagram) duplicateFlags.push("Same Instagram as another profile");
    }
    const item: Application = {
      id: randomId("app"), eventId: event.id, userId: user.id, formId: form.id, answers: payload.answers,
      status: "pending", adminNotes: "", duplicateFlags: [...new Set(duplicateFlags)], createdAt, updatedAt: createdAt
    };
    ops.applications.push(item);
    const legalMap = Object.fromEntries(site.legalPages.map((page) => [page.slug, page]));
    const consentRows = [
      ["terms", true, "I agree to the Terms & Conditions.", legalMap.terms?.version || "1.0"],
      ["privacy", true, "I acknowledge the Privacy Policy.", legalMap.privacy?.version || "1.0"],
      ["entry", true, "I agree to the Entry Policy.", legalMap["entry-policy"]?.version || "1.0"],
      ["age", Boolean(payload.answers.age_confirmed), String(form.fields.find((f) => f.key === "age_confirmed")?.placeholder || "18+ confirmation"), legalMap["age-policy"]?.version || "1.0"],
      ["media", Boolean(payload.answers.media_consent), String(form.fields.find((f) => f.key === "media_consent")?.placeholder || "Media consent"), legalMap["media-release"]?.version || "1.0"],
      ["sponsor", Boolean(payload.answers.sponsor_consent), String(form.fields.find((f) => f.key === "sponsor_consent")?.placeholder || "Sponsor consent"), legalMap.privacy?.version || "1.0"]
    ] as const;
    for (const [type, accepted, textShown, policyVersion] of consentRows) {
      ops.consents.push({ id: randomId("consent"), userId: user.id, eventId: event.id, type, accepted, textShown, policyVersion, acceptedAt: createdAt, ipHash: requestMeta?.ip ? sha256(requestMeta.ip).slice(0, 32) : undefined, userAgent: requestMeta?.userAgent?.slice(0, 300) });
    }
    ops.auditLogs.push({ id: randomId("audit"), actorId: user.id, actorEmail: user.email, action: "application.submitted", entityType: "application", entityId: item.id, metadata: { eventId: event.id }, createdAt });
    return item;
  });
  await sendTemplateEmail({ templateKey: "application_received", to: user.email, recipientUserId: user.id, eventId: event.id, variables: { first_name: user.firstName, event_title: event.title }, idempotencyKey: `application_received:${application.id}` }).catch(() => undefined);
  return application;
}

export async function reviewApplication(options: {
  applicationId: string;
  status: ApplicationStatus;
  actor: SessionUser;
  ticketTypeId?: string;
  maxQuantity?: number;
  expiryHours?: number;
  adminNotes?: string;
}) {
  const site = await readSiteData();
  const result = await mutateOperationsData((ops) => {
    let email: { key: string; to: string; userId: string; eventId: string; variables: Record<string, string | number>; idempotency: string } | null = null;
    const application = ops.applications.find((item) => item.id === options.applicationId);
    if (!application) throw new Error("Application not found.");
    const event = site.events.find((item) => item.id === application.eventId);
    const customer = ops.users.find((item) => item.id === application.userId);
    if (!event || !customer) throw new Error("Application data is incomplete.");
    if (options.status === "approved") {
      const requestedType = event.ticketTypes.find((item) => item.id === (options.ticketTypeId || event.ticketTypes.find((item) => item.active)?.id));
      if (!requestedType?.active) throw new Error("Select an active ticket type.");
      const requestedMaximum = Math.max(1, Math.min(20, options.maxQuantity || event.defaultTicketLimit || config.defaultTicketLimit));
      const currentAllocation = ops.allocations.find((item) => item.applicationId === application.id);
      if (application.status === "approved" && currentAllocation
        && currentAllocation.ticketTypeId === requestedType.id
        && currentAllocation.maxQuantity === requestedMaximum
        && currentAllocation.priceCents === requestedType.priceCents) {
        return { application, allocation: currentAllocation, email: null };
      }
      const activeReservation = currentAllocation && ops.reservations.find(
        (item) => item.allocationId === currentAllocation.id
          && ["reserved", "session_active", "payment_received", "fulfilment_pending", "paid_unfulfilled"].includes(item.status),
      );
      if (activeReservation) throw new Error("ACTIVE_CHECKOUT_CONFLICT");
    }
    application.status = options.status;
    application.adminNotes = options.adminNotes ?? application.adminNotes;
    application.updatedAt = nowIso();
    application.reviewedAt = application.updatedAt;
    application.reviewedBy = options.actor.id;
    let allocation: TicketAllocation | undefined;
    if (options.status === "approved") {
      const ticketType = event.ticketTypes.find((item) => item.id === (options.ticketTypeId || event.ticketTypes.find((item) => item.active)?.id));
      if (!ticketType) throw new Error("Select an active ticket type.");
      allocation = ops.allocations.find((item) => item.applicationId === application.id);
      const maxQuantity = Math.max(1, Math.min(20, options.maxQuantity || event.defaultTicketLimit || config.defaultTicketLimit));
      if (allocation) {
        allocation.status = "unlocked";
        allocation.ticketTypeId = ticketType.id;
        allocation.maxQuantity = maxQuantity;
        allocation.priceCents = ticketType.priceCents;
        allocation.expiresAt = expiresInHours(options.expiryHours || site.settings.defaultAllocationExpiryHours);
      } else {
        allocation = {
          id: randomId("alloc"), eventId: event.id, userId: customer.id, applicationId: application.id, ticketTypeId: ticketType.id,
          maxQuantity, purchasedQuantity: 0, priceCents: ticketType.priceCents, status: "unlocked",
          expiresAt: expiresInHours(options.expiryHours || site.settings.defaultAllocationExpiryHours), approvedBy: options.actor.id, approvedAt: nowIso()
        };
        ops.allocations.push(allocation);
      }
      email = { key: "ticket_unlocked", to: customer.email, userId: customer.id, eventId: event.id, variables: { first_name: customer.firstName, event_title: event.title, max_quantity: allocation.maxQuantity, expires_at: new Date(allocation.expiresAt).toLocaleString("en-AU", { timeZone: site.settings.timezone }), account_url: `${config.siteUrl}/account` }, idempotency: `ticket_unlocked:${application.id}:${application.updatedAt}` };
    } else if (options.status === "waitlist") {
      email = { key: "waitlist", to: customer.email, userId: customer.id, eventId: event.id, variables: { first_name: customer.firstName, event_title: event.title }, idempotency: `waitlist:${application.id}:${application.updatedAt}` };
    } else if (options.status === "rejected") {
      email = { key: "not_selected", to: customer.email, userId: customer.id, eventId: event.id, variables: { first_name: customer.firstName, event_title: event.title }, idempotency: `not_selected:${application.id}:${application.updatedAt}` };
    }
    ops.auditLogs.push({ id: randomId("audit"), actorId: options.actor.id, actorEmail: options.actor.email, action: `application.${options.status}`, entityType: "application", entityId: application.id, metadata: { eventId: event.id, customerId: customer.id }, createdAt: nowIso() });
    return { application, allocation, email };
  });
  if (result.allocation && config.dataProvider === "supabase") {
    await upsertNormalizedAllocation(result.allocation);
  }
  if (result.email) await sendTemplateEmail({ templateKey: result.email.key, to: result.email.to, recipientUserId: result.email.userId, eventId: result.email.eventId, variables: result.email.variables, idempotencyKey: result.email.idempotency }).catch(() => undefined);
  return { application: result.application, allocation: result.allocation };
}

export async function createOrder(user: SessionUser, raw: unknown): Promise<Order> {
  const payload = orderPayloadSchema.parse(raw);
  const site = await readSiteData();
  const event = site.events.find((item) => item.id === payload.eventId);
  if (!event || !canStartCheckout(event)) throw new Error("Event is not available for checkout.");
  if (!(await hasEventPasswordAccess(event))) throw new Error("Enter the event password before checkout.");

  const ticketType = event.ticketTypes.find((item) => item.id === payload.ticketTypeId && isSalesWindowOpen(item));
  if (!ticketType) throw new Error("Ticket type is unavailable.");
  if (event.ticketMode === "free_rsvp" && ticketType.priceCents !== 0) throw new Error("Free RSVP tickets must have a zero price.");

  const now = Date.now();
  const createdAt = nowIso();
  const expiresAt = new Date(now + 60 * 60 * 1000).toISOString();

  if (config.dataProvider === "supabase") {
    let allocation: TicketAllocation | undefined;
    if (event.ticketMode === "invite_only") {
      if (!payload.allocationId) throw new Error("Your ticket allocation is not active.");
      allocation = (await getNormalizedAllocation(payload.allocationId, user.id)) || undefined;
      if (!allocation || allocation.eventId !== event.id || !["unlocked", "checkout_started"].includes(allocation.status)) {
        throw new Error("Your ticket allocation is not active.");
      }
      if (new Date(allocation.expiresAt).getTime() <= now) throw new Error("Your ticket allocation has expired.");
      if (allocation.ticketTypeId !== ticketType.id || allocation.priceCents !== ticketType.priceCents) {
        throw new Error("This ticket allocation no longer matches the event configuration.");
      }
    } else if (event.ticketMode !== "direct_purchase" && event.ticketMode !== "free_rsvp") {
      throw new Error("Tickets are not currently available.");
    }

    const productLines: ReservationProductLine[] = payload.products.map((requested) => {
      const product = site.products.find(
        (item) => item.id === requested.productId
          && item.eventId === event.id
          && event.productIds.includes(item.id)
          && isSalesWindowOpen(item),
      );
      if (!product) throw new Error("An event extra is no longer available.");
      if (requested.quantity > product.maxPerOrder) throw new Error(`${product.name} exceeds its per-order limit.`);
      return {
        kind: "product",
        referenceId: product.id,
        name: product.name,
        quantity: requested.quantity,
        unitPriceCents: product.priceCents,
        stockQuantity: product.stockQuantity,
        maxPerCustomer: product.maxPerCustomer,
        unitsPerPurchase: Math.max(1, product.unitsPerPurchase || 1),
        redeemable: product.isRedeemable,
      };
    });
    const customerLimit = allocation
      ? allocation.maxQuantity
      : Math.min(event.defaultTicketLimit, ticketType.defaultMaxPerCustomer);
    return reserveNormalizedCheckout({
      customer: user,
      customerEmail: user.email,
      event,
      allocation,
      ticketLine: {
        kind: "ticket",
        referenceId: ticketType.id,
        name: ticketType.name,
        quantity: payload.ticketQuantity,
        unitPriceCents: ticketType.priceCents,
        ticketTypeCapacity: ticketType.capacity,
        eventPublicCapacity: event.publicCapacity,
        customerLimit,
      },
      productLines,
      expiresAt,
      promoCode: payload.promoCode,
    });
  }

  return mutateOperationsData((ops) => {
    for (const pending of ops.orders) {
      if (pending.status === "pending" && new Date(pending.expiresAt).getTime() <= now) {
        pending.status = "expired";
        pending.updatedAt = createdAt;
        if (pending.allocationId) {
          const staleAllocation = ops.allocations.find((item) => item.id === pending.allocationId);
          if (staleAllocation?.status === "checkout_started") staleAllocation.status = "unlocked";
        }
      }
    }
    for (const redemption of ops.promoRedemptions) {
      if (redemption.status === "reserved" && new Date(redemption.reservedUntil).getTime() <= now) {
        redemption.status = "released";
        redemption.releasedAt = createdAt;
        redemption.updatedAt = createdAt;
      }
    }

    const activePendingOrders = ops.orders.filter(
      (order) => order.status === "pending" && new Date(order.expiresAt).getTime() > now,
    );

    let allocation: TicketAllocation | undefined;
    if (event.ticketMode === "invite_only") {
      allocation = ops.allocations.find(
        (item) => item.id === payload.allocationId && item.userId === user.id && item.eventId === event.id,
      );
      if (!allocation || !["unlocked", "checkout_started"].includes(allocation.status)) {
        throw new Error("Your ticket allocation is not active.");
      }
      if (new Date(allocation.expiresAt).getTime() <= now) {
        allocation.status = "expired";
        throw new Error("Your ticket allocation has expired.");
      }
      if (allocation.ticketTypeId !== ticketType.id) {
        throw new Error("This ticket type is not unlocked for your account.");
      }

      const reservedForAllocation = activePendingOrders
        .filter((order) => order.allocationId === allocation?.id)
        .flatMap((order) => order.items)
        .filter((item) => item.kind === "ticket")
        .reduce((sum, item) => sum + item.quantity, 0);
      const remaining = allocation.maxQuantity - allocation.purchasedQuantity - reservedForAllocation;
      if (payload.ticketQuantity > remaining) throw new Error(`You can buy up to ${Math.max(0, remaining)} ticket(s).`);
    } else if (event.ticketMode !== "direct_purchase" && event.ticketMode !== "free_rsvp") {
      throw new Error("Tickets are not currently available.");
    } else {
      const customerLimit = Math.min(event.defaultTicketLimit, ticketType.defaultMaxPerCustomer);
      const previouslyIssued = ops.tickets.filter(
        (ticket) => ticket.userId === user.id && ticket.eventId === event.id && ticket.ticketTypeId === ticketType.id && !["cancelled", "refunded", "expired"].includes(ticket.status),
      ).length;
      const customerReserved = activePendingOrders
        .filter((order) => order.userId === user.id && order.eventId === event.id)
        .flatMap((order) => order.items)
        .filter((item) => item.kind === "ticket" && item.referenceId === ticketType.id)
        .reduce((sum, item) => sum + item.quantity, 0);
      if (previouslyIssued + customerReserved + payload.ticketQuantity > customerLimit) {
        throw new Error(`Maximum ${customerLimit} tickets per customer.`);
      }
    }

    const issuedForType = ops.tickets.filter(
      (ticket) => ticket.eventId === event.id && ticket.ticketTypeId === ticketType.id && !["cancelled", "refunded", "expired"].includes(ticket.status),
    ).length;
    const reservedForType = activePendingOrders
      .filter((order) => order.eventId === event.id)
      .flatMap((order) => order.items)
      .filter((item) => item.kind === "ticket" && item.referenceId === ticketType.id)
      .reduce((sum, item) => sum + item.quantity, 0);
    if (issuedForType + reservedForType + payload.ticketQuantity > ticketType.capacity) {
      throw new Error("There are not enough tickets remaining.");
    }

    const issuedForEvent = ops.tickets.filter(
      (ticket) => ticket.eventId === event.id && !["cancelled", "refunded", "expired"].includes(ticket.status),
    ).length;
    const reservedForEvent = activePendingOrders
      .filter((order) => order.eventId === event.id)
      .flatMap((order) => order.items)
      .filter((item) => item.kind === "ticket")
      .reduce((sum, item) => sum + item.quantity, 0);
    if (issuedForEvent + reservedForEvent + payload.ticketQuantity > event.publicCapacity) {
      throw new Error("The public ticket allocation is full.");
    }

    const items: CartItem[] = [
      {
        kind: "ticket",
        referenceId: ticketType.id,
        name: ticketType.name,
        quantity: payload.ticketQuantity,
        unitPriceCents: ticketType.priceCents,
      },
    ];
    const reservationProductLines: ReservationProductLine[] = [];

    for (const requested of payload.products) {
      const product = site.products.find(
        (item) => item.id === requested.productId
          && item.eventId === event.id
          && event.productIds.includes(item.id)
          && isSalesWindowOpen(item),
      );
      if (!product) throw new Error("An event extra is no longer available.");
      if (requested.quantity > product.maxPerOrder) throw new Error(`${product.name} exceeds its per-order limit.`);
      if (product.requiresApproval && event.ticketMode === "invite_only" && !allocation) throw new Error(`${product.name} requires approval.`);

      const customerPaidQuantity = ops.orders
        .filter((order) => order.status === "paid" && order.userId === user.id)
        .flatMap((order) => order.items)
        .filter((item) => item.kind === "product" && item.referenceId === product.id)
        .reduce((sum, item) => sum + item.quantity, 0);
      const customerReservedQuantity = activePendingOrders
        .filter((order) => order.userId === user.id)
        .flatMap((order) => order.items)
        .filter((item) => item.kind === "product" && item.referenceId === product.id)
        .reduce((sum, item) => sum + item.quantity, 0);
      if (customerPaidQuantity + customerReservedQuantity + requested.quantity > product.maxPerCustomer) {
        throw new Error(`${product.name} exceeds its per-customer limit.`);
      }

      const sold = ops.orders
        .filter((order) => order.status === "paid")
        .flatMap((order) => order.items)
        .filter((item) => item.kind === "product" && item.referenceId === product.id)
        .reduce((sum, item) => sum + item.quantity, 0);
      const reserved = activePendingOrders
        .flatMap((order) => order.items)
        .filter((item) => item.kind === "product" && item.referenceId === product.id)
        .reduce((sum, item) => sum + item.quantity, 0);
      if (sold + reserved + requested.quantity > product.stockQuantity) throw new Error(`${product.name} is sold out.`);

      items.push({
        kind: "product",
        referenceId: product.id,
        name: product.name,
        quantity: requested.quantity,
        unitPriceCents: product.priceCents,
      });
      reservationProductLines.push({
        kind: "product",
        referenceId: product.id,
        name: product.name,
        quantity: requested.quantity,
        unitPriceCents: product.priceCents,
        stockQuantity: product.stockQuantity,
        maxPerCustomer: product.maxPerCustomer,
        unitsPerPurchase: Math.max(1, product.unitsPerPurchase || 1),
        redeemable: product.isRedeemable,
      });
    }

    const subtotalCents = items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
    let promoQuote: ReturnType<typeof calculatePromoQuote> | undefined;
    if (payload.promoCode) {
      const promo = ops.promoCodes.find((item) => normalizePromoCode(item.code) === normalizePromoCode(payload.promoCode!));
      if (!promo) throw new PromoPolicyError("PROMO_NOT_FOUND");
      const activeStatuses = new Set(["reserved", "finalized", "refunded", "disputed"]);
      const current = ops.promoRedemptions.filter((item) => item.promoCodeId === promo.id && activeStatuses.has(item.status));
      promoQuote = calculatePromoQuote({ promo, eventId: event.id, items, usage: {
        redemptions: current.length,
        discountedTicketUnits: current.reduce((sum, item) => sum + item.discountedTicketUnits, 0),
        customerRedemptions: current.filter((item) => item.customerId === user.id).length,
        customerHasPriorPurchase: ops.orders.some((item) => item.userId === user.id && !["pending", "expired", "failed"].includes(item.status)),
      } });
    }
    const discountCents = promoQuote?.discountCents || 0;
    const order: Order = {
      id: randomId("ord"),
      eventId: event.id,
      userId: user.id,
      allocationId: allocation?.id,
      status: "pending",
      currency: config.currency,
      subtotalCents,
      discountCents,
      totalCents: subtotalCents - discountCents,
      promoCodeId: promoQuote?.promoCodeId,
      promoCodeSnapshot: promoQuote?.code,
      items,
      idempotencyKey: randomId("idem"),
      createdAt,
      updatedAt: createdAt,
      expiresAt,
    };

    const customerLimit = allocation
      ? allocation.maxQuantity
      : Math.min(event.defaultTicketLimit, ticketType.defaultMaxPerCustomer);
    const reservationTicketLine: ReservationTicketLine = {
      kind: "ticket",
      referenceId: ticketType.id,
      name: ticketType.name,
      quantity: payload.ticketQuantity,
      unitPriceCents: ticketType.priceCents,
      ticketTypeCapacity: ticketType.capacity,
      eventPublicCapacity: event.publicCapacity,
      customerLimit,
    };
    const durable = createReservationRecords({
      order,
      event,
      customer: user,
      customerEmail: user.email,
      ticketLine: reservationTicketLine,
      productLines: reservationProductLines,
    });

    ops.orders.push(durable.order);
    ops.reservations.push(durable.reservation);
    ops.checkoutAttempts.push(durable.checkoutAttempt);
    if (promoQuote) {
      ops.promoRedemptions.push({
        id: randomId("promo_use"), promoCodeId: promoQuote.promoCodeId, reservationId: durable.reservation.id,
        orderId: durable.order.id, customerId: user.id, eventId: event.id, status: "reserved",
        discountedTicketUnits: promoQuote.discountedTicketUnits, originalSubtotalCents: subtotalCents,
        discountCents, finalTotalCents: durable.order.totalCents, reservedUntil: expiresAt,
        createdAt, updatedAt: createdAt,
      });
    }
    if (allocation) allocation.status = "checkout_started";
    ops.auditLogs.push({
      id: randomId("audit"),
      actorId: user.id,
      actorEmail: user.email,
      action: "order.created",
      entityType: "order",
      entityId: order.id,
      metadata: { eventId: event.id, totalCents: durable.order.totalCents, discountCents, expiresAt },
      createdAt,
    });
    return durable.order;
  });
}

type FulfillmentEmail = {
  to: string;
  eventTitle: string;
  ticketId: string;
  firstName: string;
};

function hasActiveTicketStatus(status: Ticket["status"]) {
  return !["cancelled", "refunded", "expired"].includes(status);
}

function addAuditOnce(
  ops: OperationsData,
  action: string,
  entityId: string,
  actor: string,
  metadata: Record<string, string | number | boolean | null>,
) {
  if (ops.auditLogs.some((item) => item.action === action && item.entityId === entityId)) return;
  ops.auditLogs.push({
    id: randomId("audit"),
    actorId: actor,
    actorEmail: actor,
    action,
    entityType: "order",
    entityId,
    metadata,
    createdAt: nowIso(),
  });
}

function immutableFulfillmentSnapshot(ops: OperationsData, order: Order) {
  const reservation = ops.reservations.find((item) => item.id === order.reservationId);
  if (!reservation) throw new Error("PAYMENT_RESERVATION_NOT_FOUND");
  assertReservationMatchesOrder(reservation, order);
  if (reservation.ticketLines.length !== 1) throw new Error("RESERVATION_TICKET_LINE_INVALID");
  const ticketLine = reservation.ticketLines[0];
  if (!Number.isInteger(ticketLine.quantity) || ticketLine.quantity < 1) {
    throw new Error("RESERVATION_TICKET_QUANTITY_INVALID");
  }
  const customer = ops.users.find((item) => item.id === reservation.customerId);
  return { reservation, customer, ticketLine, productLines: reservation.productLines };
}

async function recordOrderAudit(
  orderId: string,
  action: string,
  actor: string,
  metadata: Record<string, string | number | boolean | null>,
) {
  await mutateOperationsData((ops) => addAuditOnce(ops, action, orderId, actor, metadata));
}

async function synchronizeSoldCounters(orderId: string) {
  const ops = await readOperationsData();
  await mutateSiteData((site) => {
    for (const event of site.events) {
      for (const ticketType of event.ticketTypes) {
        ticketType.sold = ops.tickets.filter(
          (ticket) =>
            ticket.eventId === event.id
            && ticket.ticketTypeId === ticketType.id
            && hasActiveTicketStatus(ticket.status),
        ).length;
      }
    }
    for (const product of site.products) {
      product.soldQuantity = ops.orders
        .filter((order) => order.status === "paid")
        .flatMap((order) => order.items)
        .filter((item) => item.kind === "product" && item.referenceId === product.id)
        .reduce((sum, item) => sum + item.quantity, 0);
    }
  });
  await recordOrderAudit(orderId, "order.sold_counters_synced", "system", { recomputed: true });
}

async function completeFulfillmentSideEffects(
  orderId: string,
  provider: "test" | "stripe" | "free",
  email: FulfillmentEmail | null,
) {
  try {
    await synchronizeSoldCounters(orderId);
  } catch {
    await recordOrderAudit(orderId, "order.sold_counters_sync_failed", "system", { retryRequired: true })
      .catch(() => undefined);
  }
  if (!email) return;
  try {
    await enqueueOrderFulfilmentNotifications(orderId);
  } catch {
    await recordOrderAudit(orderId, "order.ticket_email_enqueue_failed", provider, { retryRequired: true })
      .catch(() => undefined);
  }
}

async function fulfillOrderInternal(options: {
  orderId: string;
  provider: "test" | "stripe" | "free";
  providerReference: string;
  stripe?: StripeCheckoutSnapshot;
}) {
  const result = await mutateOperationsData((ops) => {
    const order = ops.orders.find((item) => item.id === options.orderId);
    if (!order) throw new Error("Order not found.");
    let reconciliation: "fulfill" | "replay" | "awaiting_payment" = "fulfill";
    if (options.stripe) {
      assertStripeReferencesAreUnique(order, options.stripe, ops.orders, ops.payments);
      reconciliation = reconcilePaidStripeSession(order, options.stripe);
      if (reconciliation === "awaiting_payment") {
        addAuditOnce(
          ops,
          `stripe.${options.stripe.eventId}.awaiting_payment`,
          order.id,
          "stripe",
          { eventId: options.stripe.eventId, sessionId: options.stripe.sessionId },
        );
        return {
          order,
          tickets: [] as Ticket[],
          duplicate: false,
          awaitingPayment: true,
          email: null as FulfillmentEmail | null,
        };
      }
    } else if (["paid", "fulfilled"].includes(order.status)) {
      reconciliation = "replay";
    } else {
      if (order.status !== "pending") throw new Error("Order is not pending fulfilment.");
      if (Date.now() >= new Date(order.expiresAt).getTime()) throw new Error("Order has expired.");
    }

    if (reconciliation === "replay") {
      const tickets = ops.tickets.filter((ticket) => ticket.orderId === order.id);
      const reservation = ops.reservations.find((item) => item.id === order.reservationId);
      const customer = ops.users.find((item) => item.id === order.userId);
      if (!reservation || !tickets.length) throw new Error("Fulfilled order data is incomplete.");
      if (options.stripe) {
        const payment = ops.payments.find(
          (item) =>
            item.orderId === order.id
            && item.provider === "stripe"
            && item.providerReference === options.stripe?.paymentIntentId
            && item.status === "paid",
        );
        if (!payment || payment.amountCents !== order.totalCents || payment.currency.toUpperCase() !== order.currency.toUpperCase()) {
          throw new Error("Stripe replay does not match the stored payment.");
        }
      }
      return {
        order,
        tickets,
        duplicate: true,
        awaitingPayment: false,
        email: {
          to: customer?.email || reservation.customerEmail,
          eventTitle: reservation.eventTitle,
          ticketId: tickets[0].id,
          firstName: customer?.firstName || reservation.customerName.split(" ")[0] || "there",
        } satisfies FulfillmentEmail,
      };
    }

    const { reservation, customer, ticketLine, productLines } = immutableFulfillmentSnapshot(ops, order);
    const paidAt = nowIso();
    order.status = "fulfilment_pending"; order.updatedAt = paidAt; order.paidAt ||= paidAt;
    reservation.status = "fulfilment_pending";
    reservation.updatedAt = paidAt;
    if (options.stripe) order.stripePaymentIntentId = options.stripe.paymentIntentId || undefined;
    let tickets = ops.tickets.filter((ticket) => ticket.orderId === order.id);
    if (tickets.length && tickets.length !== ticketLine.quantity) throw new Error("TICKET_FULFILMENT_INCOMPLETE");
    if (!tickets.length) {
      tickets = [];
      for (let index = 0; index < ticketLine.quantity; index += 1) {
        const id = randomId("tkt");
        const ticket: Ticket = {
          id, eventId: reservation.eventId, userId: reservation.customerId, orderId: order.id,
          ticketTypeId: ticketLine.referenceId,
          ticketCode: `SKIE-${id.slice(-12).toUpperCase().match(/.{1,4}/g)?.join("-")}`,
          tokenHash: "", tokenPreview: "", status: "valid",
          holderName: reservation.customerName, holderEmail: reservation.customerEmail, createdAt: paidAt,
        };
        const token = createTicketToken(ticket);
        ticket.tokenHash = createTicketTokenHash(ticket);
        ticket.tokenPreview = token.slice(0, 8);
        ops.tickets.push(ticket);
        tickets.push(ticket);
      }
    }
    for (const product of productLines.filter((line) => line.redeemable)) {
      if (ops.entitlements.some((item) => item.orderId === order.id && item.productId === product.referenceId)) continue;
      const entitlement: Entitlement = {
        id: randomId("ent"), eventId: reservation.eventId, userId: reservation.customerId,
        orderId: order.id, productId: product.referenceId, name: product.name,
        quantityTotal: product.quantity * product.unitsPerPurchase,
        quantityRemaining: product.quantity * product.unitsPerPurchase,
        status: "active", createdAt: paidAt
      };
      ops.entitlements.push(entitlement);
    }
    const payment = ops.payments.find((item) => item.orderId === order.id && item.provider === options.provider);
    if (payment) {
      payment.status = "paid";
      payment.updatedAt = paidAt;
    } else {
      ops.payments.push({ id: randomId("pay"), orderId: order.id, provider: options.provider, providerReference: options.providerReference, amountCents: order.totalCents, currency: order.currency, status: "paid", createdAt: paidAt, updatedAt: paidAt });
    }
    const allocation = order.allocationId ? ops.allocations.find((item) => item.id === order.allocationId) : undefined;
    if (allocation && allocation.status !== "ticket_issued") {
      allocation.purchasedQuantity += ticketLine.quantity;
      allocation.status = "ticket_issued";
    }
    order.status = "fulfilled";
    order.updatedAt = paidAt;
    reservation.status = "fulfilled";
    reservation.updatedAt = paidAt;
    const promoRedemption = ops.promoRedemptions.find((item) => item.orderId === order.id && item.status === "reserved");
    if (promoRedemption) {
      promoRedemption.status = "finalized";
      promoRedemption.finalizedAt ||= paidAt;
      promoRedemption.updatedAt = paidAt;
    }
    const attempt = ops.checkoutAttempts.find((item) => item.id === reservation.checkoutAttemptId);
    if (attempt) { attempt.status = "fulfilled"; attempt.updatedAt = paidAt; }
    ops.auditLogs.push({ id: randomId("audit"), actorId: options.provider, actorEmail: options.provider, action: "order.fulfilled", entityType: "order", entityId: order.id, metadata: { tickets: tickets.length, providerReference: options.providerReference }, createdAt: paidAt });
    const email = {
      to: reservation.customerEmail,
      eventTitle: reservation.eventTitle,
      ticketId: tickets[0].id,
      firstName: customer?.firstName || reservation.customerName.split(" ")[0] || "there",
    };
    return { order, tickets, duplicate: false, awaitingPayment: false, email };
  });
  if (result.awaitingPayment) return result;
  await completeFulfillmentSideEffects(options.orderId, options.provider, result.email);
  return result;
}

export async function fulfillOrder(
  orderId: string,
  provider: "test" | "free",
  providerReference: string,
) {
  if (config.dataProvider === "supabase") return fulfilNormalizedOrder(orderId, provider, providerReference);
  return fulfillOrderInternal({ orderId, provider, providerReference });
}

export async function fulfillStripeOrder(snapshot: StripeCheckoutSnapshot) {
  if (config.dataProvider === "supabase") return fulfilNormalizedPayment(snapshot);
  const orderId = snapshot.metadataOrderId || snapshot.clientReferenceOrderId;
  if (!orderId) throw new Error("Stripe session is missing its order reference.");
  const received = await recordStripePaymentReceived(snapshot);
  if (received.awaitingPayment) return received;
  try {
    return await fulfillOrderInternal({
      orderId,
      provider: "stripe",
      providerReference: snapshot.paymentIntentId || snapshot.sessionId,
      stripe: snapshot,
    });
  } catch (error) {
    await mutateOperationsData((ops) => {
      const order = ops.orders.find((item) => item.id === orderId);
      if (order?.reservationId) markLocalPaidUnfulfilled(ops, order.reservationId, "FULFILMENT_FAILED");
    }).catch(() => undefined);
    throw error;
  }
}

export async function recordStripePaymentReceived(snapshot: StripeCheckoutSnapshot) {
  const orderId = snapshot.metadataOrderId || snapshot.clientReferenceOrderId;
  if (!orderId) throw new Error("Stripe session is missing its order reference.");
  const result = await mutateOperationsData((ops) => {
    const order = ops.orders.find((item) => item.id === orderId);
    if (!order) throw new Error("Order not found.");
    assertStripeReferencesAreUnique(order, snapshot, ops.orders, ops.payments);
    const reconciliation = reconcilePaidStripeSession(order, snapshot);
    if (reconciliation === "awaiting_payment") {
      addAuditOnce(ops, `stripe.${snapshot.eventId}.awaiting_payment`, order.id, "stripe", {
        eventId: snapshot.eventId,
        sessionId: snapshot.sessionId,
      });
      return { order, awaitingPayment: true, duplicate: false };
    }
    if (reconciliation === "replay") return { order, awaitingPayment: false, duplicate: true };
    let payment: ReturnType<typeof recordLocalPaymentReceived>;
    try {
      payment = recordLocalPaymentReceived(ops, order, snapshot);
    } catch (error) {
      if (error instanceof Error && ["PAYMENT_AMOUNT_MISMATCH", "PAYMENT_INTENT_MISMATCH"].includes(error.message)) {
        return { order, awaitingPayment: false, duplicate: false, failureCode: error.message };
      }
      throw error;
    }
    addAuditOnce(ops, `stripe.${snapshot.eventId}.payment_received`, order.id, "stripe", {
      eventId: snapshot.eventId,
      sessionId: snapshot.sessionId,
      duplicate: payment.duplicate,
    });
    return { order, awaitingPayment: false, duplicate: payment.duplicate, failureCode: undefined };
  });
  if (result.failureCode) throw new Error(result.failureCode);
  return result;
}

export async function recordStripeCheckoutTerminalEvent(snapshot: StripeCheckoutSnapshot) {
  if (config.dataProvider === "supabase") {
    await expireNormalizedSessionState(
      snapshot.sessionId,
      snapshot.eventType === "checkout.session.expired" ? "expired" : "failed",
    );
    return { duplicate: false };
  }
  const orderId = snapshot.metadataOrderId || snapshot.clientReferenceOrderId;
  if (!orderId) throw new Error("Stripe session is missing its order reference.");
  return mutateOperationsData((ops) => {
    const order = ops.orders.find((item) => item.id === orderId);
    if (!order) throw new Error("Order not found.");
    reconcileTerminalStripeSession(order, snapshot);
    assertStripeReferencesAreUnique(order, snapshot, ops.orders, ops.payments);

    const action = `stripe.${snapshot.eventId}.${snapshot.eventType}`;
    if (ops.auditLogs.some((item) => item.action === action && item.entityId === order.id)) {
      return { order, duplicate: true };
    }

    const updatedAt = nowIso();
    if (order.status === "pending") {
      order.status = snapshot.eventType === "checkout.session.expired" ? "expired" : "failed";
      order.updatedAt = updatedAt;
      const reservation = ops.reservations.find((item) => item.id === order.reservationId);
      if (reservation && ["reserved", "session_active"].includes(reservation.status)) {
        reservation.status = snapshot.eventType === "checkout.session.expired" ? "expired" : "failed";
        reservation.updatedAt = updatedAt;
      }
      const attempt = ops.checkoutAttempts.find((item) => item.id === order.checkoutAttemptId);
      if (attempt && ["creating_session", "session_active"].includes(attempt.status)) {
        attempt.status = snapshot.eventType === "checkout.session.expired" ? "session_expired" : "session_failed";
        attempt.updatedAt = updatedAt;
      }
      const allocation = order.allocationId
        ? ops.allocations.find((item) => item.id === order.allocationId)
        : undefined;
      if (allocation?.status === "checkout_started") {
        allocation.status = new Date(allocation.expiresAt).getTime() <= Date.now()
          ? "expired"
          : "unlocked";
      }
    }
    ops.auditLogs.push({
      id: randomId("audit"),
      actorId: "stripe",
      actorEmail: "stripe",
      action,
      entityType: "order",
      entityId: order.id,
      metadata: {
        eventId: snapshot.eventId,
        eventType: snapshot.eventType,
        sessionId: snapshot.sessionId,
        resultingStatus: order.status,
        ticketsIssued: false,
      },
      createdAt: updatedAt,
    });
    return { order, duplicate: false };
  });
}

type WebhookInboxInput = Omit<StripeWebhookEventRecord,
  "status" | "processingAttempts" | "receivedAt" | "processedAt" | "safeErrorCode">;

export async function recordStripeWebhookInbox(input: WebhookInboxInput) {
  if (config.dataProvider === "supabase") return recordNormalizedWebhook(input);
  return mutateOperationsData((ops) => recordLocalStripeWebhook(ops, input));
}

export async function markStripeWebhookInboxResult(
  stripeEventId: string,
  status: "processed" | "temporary_failure" | "permanent_failure" | "manual_review",
  safeErrorCode?: string,
) {
  if (config.dataProvider === "supabase") {
    return markNormalizedWebhookResult(stripeEventId, status, safeErrorCode);
  }
  return mutateOperationsData((ops) => markLocalWebhookResult(ops, stripeEventId, status, safeErrorCode));
}

export type StripeRefundUpdate = {
  paymentIntentId: string;
  refundId: string;
  status: "pending" | "succeeded" | "failed";
  amountCents: number;
  currency: string;
  providerCreatedAt: string;
};

export async function applyStripeRefundUpdate(input: StripeRefundUpdate) {
  if (config.dataProvider === "supabase") return applyNormalizedRefund(input);
  return mutateOperationsData((ops) => applyLocalRefund(ops, {
    providerObjectId: input.refundId,
    paymentIntentId: input.paymentIntentId,
    amountCents: input.amountCents,
    currency: input.currency,
    status: input.status,
  }));
}

export type StripeDisputeUpdate = {
  paymentIntentId: string;
  disputeId: string;
  status: "needs_response" | "won" | "lost" | "closed";
  amountCents: number;
  currency: string;
  providerCreatedAt: string;
};

export async function applyStripeDisputeUpdate(input: StripeDisputeUpdate) {
  if (config.dataProvider === "supabase") return applyNormalizedDispute(input);
  return mutateOperationsData((ops) => applyLocalDispute(ops, {
    providerObjectId: input.disputeId,
    paymentIntentId: input.paymentIntentId,
    amountCents: input.amountCents,
    currency: input.currency,
    status: input.status,
  }));
}

export async function recordStripePaymentIntentTerminal(
  paymentIntentId: string,
  result: "failed" | "cancelled",
) {
  if (config.dataProvider === "supabase") return markNormalizedPaymentIntentTerminal(paymentIntentId, result);
  return mutateOperationsData((ops) => {
    const payment = ops.payments.find((item) => item.provider === "stripe" && item.providerReference === paymentIntentId);
    const attempt = ops.checkoutAttempts.find((item) => item.stripePaymentIntentId === paymentIntentId);
    const order = ops.orders.find((item) => item.id === payment?.orderId || item.id === attempt?.orderId);
    if (!order) throw new Error("PAYMENT_NOT_FOUND");
    if (["fulfilled", "refunded", "partially_refunded", "disputed", "suspended"].includes(order.status)) return order;
    order.status = result;
    order.updatedAt = nowIso();
    if (payment) { payment.status = result; payment.updatedAt = order.updatedAt; }
    const reservation = ops.reservations.find((item) => item.id === order.reservationId);
    if (reservation && ["reserved", "session_active", "payment_received", "fulfilment_pending"].includes(reservation.status)) {
      reservation.status = result;
      reservation.updatedAt = order.updatedAt;
    }
    if (attempt && attempt.status !== "fulfilled") {
      attempt.status = "session_failed";
      attempt.failureCode = `PAYMENT_INTENT_${result.toUpperCase()}`;
      attempt.updatedAt = order.updatedAt;
    }
    return order;
  });
}

export async function listPaymentRecovery(): Promise<PaymentRecoveryItem[]> {
  if (config.dataProvider === "supabase") return listNormalizedPaymentRecovery();
  const ops = await readOperationsData();
  const payments = ops.reservations
    .filter((reservation) => (PAYMENT_RECOVERY_STATUSES as readonly string[]).includes(reservation.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 250)
    .flatMap((reservation) => {
      const order = ops.orders.find((item) => item.id === reservation.orderId);
      const attempt = ops.checkoutAttempts.find((item) => item.id === reservation.checkoutAttemptId);
      if (!order) return [];
      return [{
        kind: "payment" as const,
        reservationId: reservation.id,
        orderId: order.id,
        eventId: order.eventId,
        status: reservation.status,
        totalCents: order.totalCents,
        currency: order.currency,
        failureCode: reservation.failureCode,
        sessionId: attempt?.stripeCheckoutSessionId,
        paymentIntentId: attempt?.stripePaymentIntentId,
        updatedAt: reservation.updatedAt,
      }];
    });
  const orphans = ops.checkoutAttempts
    .filter((attempt) => attempt.status === "orphan_session")
    .flatMap((attempt) => {
      const reservation = ops.reservations.find((item) => item.id === attempt.reservationId);
      const order = ops.orders.find((item) => item.id === attempt.orderId);
      if (!reservation || !order) return [];
      return [{
        kind: "orphan_session" as const,
        reservationId: reservation.id,
        orderId: order.id,
        eventId: order.eventId,
        status: "orphan_session",
        totalCents: order.totalCents,
        currency: order.currency,
        failureCode: attempt.failureCode || "SESSION_LINK_FAILED",
        sessionId: attempt.stripeCheckoutSessionId,
        paymentIntentId: attempt.stripePaymentIntentId,
        updatedAt: attempt.updatedAt,
      }];
    });
  const webhooks = ops.stripeWebhookEvents
    .filter((event) => ["temporary_failure", "permanent_failure", "manual_review"].includes(event.status))
    .map((event) => ({
      kind: "webhook" as const,
      reservationId: `webhook:${event.stripeEventId}`,
      orderId: event.objectId || event.stripeEventId,
      eventId: event.eventType,
      status: "webhook_failed",
      totalCents: 0,
      currency: config.currency,
      failureCode: event.safeErrorCode || event.status,
      updatedAt: event.processedAt || event.receivedAt,
    }));
  return [...payments, ...orphans, ...webhooks]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 250);
}

export async function recordPaymentRecoveryAction(input: {
  reservationId: string;
  orderId: string;
  action: string;
  actor: SessionUser;
  idempotencyKey: string;
  status: "requested" | "completed" | "failed" | "manual_review";
  safeMetadata?: Record<string, string | number | boolean | null>;
  safeErrorCode?: string;
}) {
  if (config.dataProvider === "supabase") {
    return recordNormalizedRecoveryAction({
      ...input,
      actorId: input.actor.id,
      actorLabel: input.actor.email,
    });
  }
  return mutateOperationsData((ops) => {
    const existing = ops.paymentRecoveryActions.find((item) => item.idempotencyKey === input.idempotencyKey);
    if (existing) {
      existing.status = input.status;
      existing.safeErrorCode = input.safeErrorCode;
      existing.safeMetadata = input.safeMetadata || existing.safeMetadata;
      existing.completedAt = input.status === "completed" ? nowIso() : existing.completedAt;
      return existing;
    }
    const timestamp = nowIso();
    const action = {
      id: randomId("recovery"),
      reservationId: input.reservationId,
      orderId: input.orderId,
      action: input.action,
      actorId: input.actor.id,
      actorLabel: input.actor.email,
      idempotencyKey: input.idempotencyKey,
      status: input.status,
      safeMetadata: input.safeMetadata || {},
      safeErrorCode: input.safeErrorCode,
      createdAt: timestamp,
      completedAt: input.status === "completed" ? timestamp : undefined,
    } as const;
    ops.paymentRecoveryActions.push(action);
    ops.auditLogs.push({
      id: randomId("audit"),
      actorId: input.actor.id,
      actorEmail: input.actor.email,
      action: `payment_recovery.${input.action}`,
      entityType: "order",
      entityId: input.orderId,
      metadata: { reservationId: input.reservationId, status: input.status },
      createdAt: timestamp,
    });
    return action;
  });
}

export async function markPaymentRecoveryResolved(reservationId: string) {
  if (config.dataProvider === "supabase") return markNormalizedRecoveryResolved(reservationId);
  return mutateOperationsData((ops) => {
    const reservation = ops.reservations.find((item) => item.id === reservationId);
    const order = ops.orders.find((item) => item.id === reservation?.orderId);
    if (!reservation || !order) throw new Error("ORDER_NOT_FOUND");
    const expected = reservation.ticketLines.reduce((sum, item) => sum + item.quantity, 0);
    const actual = ops.tickets.filter((item) => item.orderId === order.id).length;
    const payment = ops.payments.find((item) => item.orderId === order.id && ["paid", "payment_received"].includes(item.status));
    if (expected < 1 || actual !== expected || !payment) throw new Error("RECOVERY_NOT_PROVABLY_FULFILLED");
    const updatedAt = nowIso();
    order.status = "fulfilled";
    order.updatedAt = updatedAt;
    order.paidAt ||= payment.createdAt;
    reservation.status = "fulfilled";
    reservation.failureCode = undefined;
    reservation.updatedAt = updatedAt;
    payment.status = "paid";
    payment.updatedAt = updatedAt;
    const attempt = ops.checkoutAttempts.find((item) => item.id === reservation.checkoutAttemptId);
    if (attempt) { attempt.status = "fulfilled"; attempt.failureCode = undefined; attempt.updatedAt = updatedAt; }
    return { orderId: order.id, resultingStatus: order.status };
  });
}

export async function verifyTicket(ticketId: string, token: string, expectedEventId?: string) {
  if (config.dataProvider === "supabase") return verifyNormalizedTicket(ticketId, token, expectedEventId);
  const ops = await readOperationsData();
  const ticket = ops.tickets.find((item) => item.id === ticketId);
  if (!ticket || !verifyTicketToken(ticket, token)) return { result: "invalid" as const, ticket: null };
  if (expectedEventId && ticket.eventId !== expectedEventId) return { result: "wrong_event" as const, ticket };
  if (ticket.status === "checked_in") return { result: "already_checked_in" as const, ticket };
  if (ticket.status !== "valid") return { result: ticket.status as "cancelled" | "refunded" | "suspended" | "expired" | "entry_refused", ticket };
  return { result: "valid" as const, ticket };
}

export async function checkInTicket(options: { ticketId: string; token: string; eventId: string; actor: SessionUser; notes?: string }) {
  if (config.dataProvider === "supabase") {
    return checkInNormalizedTicket({ ...options, actorId: options.actor.id });
  }
  await assertEventCapability(options.actor, options.eventId, "scan");
  return mutateOperationsData((ops) => {
    const ticket = ops.tickets.find((item) => item.id === options.ticketId);
    let result: CheckInRecord["result"] = "invalid";
    if (ticket && verifyTicketToken(ticket, options.token)) {
      if (ticket.eventId !== options.eventId) result = "wrong_event";
      else if (ticket.status === "checked_in") result = "already_checked_in";
      else if (ticket.status === "cancelled") result = "cancelled";
      else if (ticket.status === "refunded") result = "refunded";
      else if (ticket.status === "suspended") result = "suspended";
      else if (ticket.status === "expired") result = "expired";
      else if (ticket.status === "valid") {
        result = "valid";
        ticket.status = "checked_in";
        ticket.checkedInAt = nowIso();
        ticket.checkedInBy = options.actor.id;
      }
    }
    const record: CheckInRecord = { id: randomId("scan"), eventId: options.eventId, ticketId: ticket?.id || options.ticketId, scannedBy: options.actor.id, result, notes: options.notes || "", scannedAt: nowIso() };
    ops.checkIns.push(record);
    ops.auditLogs.push({ id: randomId("audit"), actorId: options.actor.id, actorEmail: options.actor.email, action: `ticket.scan.${result}`, entityType: "ticket", entityId: ticket?.id || options.ticketId, metadata: { eventId: options.eventId }, createdAt: record.scannedAt });
    return { result, ticket: ticket || null, record };
  });
}

export async function searchDoorTickets(query: string, eventId: string, actor?: SessionUser) {
  if (config.dataProvider === "supabase") {
    if (!actor) throw new Error("FORBIDDEN");
    const tickets = await searchNormalizedDoorTickets(query, eventId, actor.id);
    return tickets.map((ticket) => ({
      id: ticket.id, eventId: ticket.eventId, holderName: ticket.holderName,
      holderEmail: "", ticketCode: ticket.ticketCode, status: ticket.status,
      checkedInAt: ticket.checkedInAt, entitlements: [],
    }));
  }
  if (!actor) throw new Error("FORBIDDEN");
  await assertEventCapability(actor, eventId, "search");
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 2) return [];
  const ops = await readOperationsData();
  return ops.tickets
    .filter((ticket) => ticket.eventId === eventId)
    .filter((ticket) =>
      [ticket.holderName, ticket.holderEmail, ticket.ticketCode]
        .some((value) => value.toLowerCase().includes(normalized)),
    )
    .slice(0, 12)
    .map((ticket) => ({
      id: ticket.id,
      eventId: ticket.eventId,
      holderName: ticket.holderName,
      holderEmail: "",
      ticketCode: ticket.ticketCode,
      status: ticket.status,
      checkedInAt: ticket.checkedInAt,
      entitlements: [],
    }));
}

export async function manualCheckInTicket(options: { ticketId: string; eventId: string; actor: SessionUser; notes?: string }) {
  if (config.dataProvider === "supabase") {
    return checkInNormalizedTicket({ ...options, actorId: options.actor.id, manual: true });
  }
  await assertEventCapability(options.actor, options.eventId, "scan");
  return mutateOperationsData((ops) => {
    const ticket = ops.tickets.find((item) => item.id === options.ticketId);
    let result: CheckInRecord["result"] = "invalid";
    if (ticket) {
      if (ticket.eventId !== options.eventId) result = "wrong_event";
      else if (ticket.status === "checked_in") result = "already_checked_in";
      else if (ticket.status === "cancelled") result = "cancelled";
      else if (ticket.status === "refunded") result = "refunded";
      else if (ticket.status === "expired") result = "expired";
      else if (ticket.status === "valid") {
        result = "valid";
        ticket.status = "checked_in";
        ticket.checkedInAt = nowIso();
        ticket.checkedInBy = options.actor.id;
      }
    }
    const record: CheckInRecord = {
      id: randomId("scan"),
      eventId: options.eventId,
      ticketId: ticket?.id || options.ticketId,
      scannedBy: options.actor.id,
      result,
      notes: options.notes || "Manual door lookup",
      scannedAt: nowIso(),
    };
    ops.checkIns.push(record);
    ops.auditLogs.push({
      id: randomId("audit"),
      actorId: options.actor.id,
      actorEmail: options.actor.email,
      action: `ticket.manual_check_in.${result}`,
      entityType: "ticket",
      entityId: ticket?.id || options.ticketId,
      metadata: { eventId: options.eventId },
      createdAt: record.scannedAt,
    });
    return { result, ticket: ticket || null, record };
  });
}

export async function getDoorEntitlements(orderId: string, eventId: string, actor: SessionUser) {
  if (config.dataProvider === "supabase") {
    const items = await getNormalizedOrderEntitlements(orderId, eventId, actor.id);
    return items.map((item) => ({
      id: String(item.id), name: String(item.name), quantityRemaining: Number(item.quantity_remaining), status: String(item.status),
    }));
  }
  await assertEventCapability(actor, eventId, "redeem");
  const ops = await readOperationsData();
  return ops.entitlements
    .filter((item) => item.orderId === orderId && item.eventId === eventId && item.status === "active")
    .map((item) => ({ id: item.id, name: item.name, quantityRemaining: item.quantityRemaining, status: item.status }));
}

export async function redeemEntitlement(options: { entitlementId: string; eventId: string; quantity: number; actor: SessionUser; idempotencyKey: string }) {
  if (config.dataProvider === "supabase") {
    return redeemNormalizedEntitlement({
      entitlementId: options.entitlementId,
      eventId: options.eventId,
      quantity: options.quantity,
      actorId: options.actor.id,
      idempotencyKey: options.idempotencyKey,
    });
  }
  await assertEventCapability(options.actor, options.eventId, "redeem");
  return mutateOperationsData((ops) => {
    const duplicate = ops.entitlementRedemptions.find((item) => item.idempotencyKey === options.idempotencyKey);
    if (duplicate) {
      const previous = ops.entitlements.find((item) => item.id === duplicate.entitlementId);
      if (!previous) throw new Error("Entitlement redemption state is incomplete.");
      return previous;
    }
    const entitlement = ops.entitlements.find((item) => item.id === options.entitlementId);
    if (!entitlement || entitlement.eventId !== options.eventId || entitlement.status !== "active") throw new Error("Entitlement is not active.");
    if (options.quantity < 1 || options.quantity > entitlement.quantityRemaining) throw new Error("Invalid redemption quantity.");
    entitlement.quantityRemaining -= options.quantity;
    if (entitlement.quantityRemaining === 0) entitlement.status = "redeemed";
    ops.entitlementRedemptions.push({
      id: randomId("redemption"), entitlementId: entitlement.id, eventId: entitlement.eventId,
      quantity: options.quantity, redeemedBy: options.actor.id, idempotencyKey: options.idempotencyKey,
      redeemedAt: nowIso(),
    });
    ops.auditLogs.push({ id: randomId("audit"), actorId: options.actor.id, actorEmail: options.actor.email, action: "entitlement.redeemed", entityType: "entitlement", entityId: entitlement.id, metadata: { quantity: options.quantity, remaining: entitlement.quantityRemaining }, createdAt: nowIso() });
    return entitlement;
  });
}

export async function adminSnapshot() {
  const [siteSnapshot, ops] = await Promise.all([readSiteDataSnapshot(), readOperationsData()]);
  const site = siteSnapshot.value;
  const enrichedApplications = ops.applications.map((application) => ({
    ...application,
    customer: ops.users.find((user) => user.id === application.userId),
    event: site.events.find((event) => event.id === application.eventId),
    allocation: ops.allocations.find((allocation) => allocation.applicationId === application.id)
  }));
  return { site, siteVersion: siteSnapshot.version, ops, applications: enrichedApplications };
}
