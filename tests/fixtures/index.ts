import type {
  Entitlement,
  EventItem,
  EventProduct,
  OperationsData,
  Order,
  Payment,
  SessionUser,
  SiteData,
  Ticket,
  TicketAllocation,
  UserProfile,
  UserRole,
} from "@/types/site";
import type { StripeCheckoutSnapshot } from "@/lib/payments/reconciliation";

export const FIXTURE_NOW = "2026-07-21T00:00:00.000Z";
export const FIXTURE_EXPIRY = "2026-07-21T01:00:00.000Z";

export function userFixture(
  overrides: Partial<UserProfile> = {},
  role: UserRole = "customer",
): UserProfile {
  return {
    id: "usr_fixture_customer",
    firstName: "Test",
    lastName: "Customer",
    email: "customer@example.test",
    phone: "+61400000000",
    instagram: "@fixture",
    role,
    tags: [],
    internalNotes: "",
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

export function sessionUserFixture(
  overrides: Partial<SessionUser> = {},
  role: UserRole = "customer",
): SessionUser {
  const user = userFixture(overrides, role);
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role,
  };
}

export function staffFixtures(): UserProfile[] {
  return (["scanner_only", "door_staff", "admin", "super_admin"] as const).map((role) =>
    userFixture(
      {
        id: `usr_fixture_${role}`,
        email: `${role}@example.test`,
        firstName: role,
      },
      role,
    ),
  );
}

export function eventFixture(overrides: Partial<EventItem> = {}): EventItem {
  return {
    id: "evt_fixture",
    slug: "fixture-event",
    title: "Fixture Event",
    date: "2026-10-31",
    time: "8:30 PM - LATE",
    venue: "Fixture Venue",
    location: "Melbourne, VIC",
    genre: "TEST EVENT",
    teaser: "A deterministic test event.",
    description: "Used only by local automated tests.",
    posterUrl: "",
    heroUrl: "",
    accent: "#5170FF",
    lineup: [],
    houseRules: ["18+ only."],
    faq: [],
    ageRestriction: "18+",
    lifecycle: "published",
    visibility: "public",
    ticketMode: "direct_purchase",
    featured: true,
    sponsorIds: [],
    formId: "form_fixture",
    venueCapacity: 100,
    publicCapacity: 80,
    sponsorAllocation: 5,
    guestlistAllocation: 5,
    teamAllocation: 5,
    safetyBuffer: 5,
    defaultTicketLimit: 2,
    productIds: ["prod_fixture"],
    ticketTypes: [
      {
        id: "tt_fixture",
        name: "Fixture Admission",
        description: "Fixture ticket.",
        priceCents: 4_500,
        capacity: 80,
        sold: 0,
        defaultMaxPerCustomer: 2,
        active: true,
      },
    ],
    ...overrides,
  };
}

export function productFixture(overrides: Partial<EventProduct> = {}): EventProduct {
  return {
    id: "prod_fixture",
    eventId: "evt_fixture",
    name: "Fixture Extra",
    description: "Fixture redeemable extra.",
    type: "add_on",
    priceCents: 1_500,
    stockQuantity: 20,
    soldQuantity: 0,
    maxPerOrder: 2,
    maxPerCustomer: 2,
    requiresApproval: false,
    requiresTicket: true,
    isRedeemable: true,
    unitsPerPurchase: 1,
    imageUrl: "",
    active: true,
    visibleOnEventPage: true,
    ...overrides,
  };
}

export function siteFixture(overrides: Partial<SiteData> = {}): SiteData {
  return {
    brand: {
      name: "SKIE EVENTS",
      statement: "Fixture site",
      instagramUrl: "https://example.test/skie",
      contactEmail: "support@example.test",
      contactPhone: "",
      accent: "#5170FF",
    },
    about: { eyebrow: "About", title: "Fixture", body: ["Fixture"] },
    settings: {
      appMode: "test",
      currency: "AUD",
      timezone: "Australia/Melbourne",
      defaultTicketLimit: 2,
      defaultAllocationExpiryHours: 48,
      newsletterEnabled: false,
      featuredSponsorCarousel: false,
    },
    heroSlides: [],
    events: [eventFixture()],
    products: [productFixture()],
    sponsors: [],
    media: [],
    reviews: [],
    forms: [
      {
        id: "form_fixture",
        name: "Fixture Form",
        intro: "Fixture only",
        active: true,
        fields: [
          {
            id: "field_fixture",
            key: "reason",
            label: "Reason",
            type: "textarea",
            required: true,
            placeholder: "Reason",
            options: [],
            maxLength: 200,
          },
        ],
      },
    ],
    emailTemplates: [],
    legalPages: [],
    ...overrides,
  };
}

export function allocationFixture(
  overrides: Partial<TicketAllocation> = {},
): TicketAllocation {
  return {
    id: "alloc_fixture",
    eventId: "evt_fixture",
    userId: "usr_fixture_customer",
    applicationId: "app_fixture",
    ticketTypeId: "tt_fixture",
    maxQuantity: 2,
    purchasedQuantity: 0,
    priceCents: 4_500,
    status: "checkout_started",
    expiresAt: FIXTURE_EXPIRY,
    approvedBy: "usr_fixture_admin",
    approvedAt: FIXTURE_NOW,
    ...overrides,
  };
}

export function orderFixture(overrides: Partial<Order> = {}): Order {
  return {
    id: "ord_fixture",
    eventId: "evt_fixture",
    userId: "usr_fixture_customer",
    allocationId: "alloc_fixture",
    status: "pending",
    currency: "AUD",
    subtotalCents: 10_500,
    totalCents: 10_500,
    items: [
      {
        kind: "ticket",
        referenceId: "tt_fixture",
        name: "Fixture Admission",
        quantity: 2,
        unitPriceCents: 4_500,
      },
      {
        kind: "product",
        referenceId: "prod_fixture",
        name: "Fixture Extra",
        quantity: 1,
        unitPriceCents: 1_500,
      },
    ],
    stripeCheckoutSessionId: "cs_test_fixture",
    stripePaymentIntentId: undefined,
    idempotencyKey: "idem_fixture",
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    expiresAt: FIXTURE_EXPIRY,
    ...overrides,
  };
}

export function paidOrderFixture(overrides: Partial<Order> = {}): Order {
  return orderFixture({
    status: "paid",
    stripePaymentIntentId: "pi_fixture",
    paidAt: "2026-07-21T00:30:00.000Z",
    ...overrides,
  });
}

export function failedOrderFixture(overrides: Partial<Order> = {}): Order {
  return orderFixture({ status: "failed", ...overrides });
}

export function paymentFixture(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "pay_fixture",
    orderId: "ord_fixture",
    provider: "stripe",
    providerReference: "pi_fixture",
    amountCents: 10_500,
    currency: "AUD",
    status: "paid",
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

export function ticketFixture(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "tkt_fixture",
    eventId: "evt_fixture",
    userId: "usr_fixture_customer",
    orderId: "ord_fixture",
    ticketTypeId: "tt_fixture",
    ticketCode: "SKIE-TEST-0001",
    tokenHash: "fixture-token-hash",
    tokenPreview: "fixture-",
    status: "valid",
    holderName: "Test Customer",
    holderEmail: "customer@example.test",
    createdAt: FIXTURE_NOW,
    ...overrides,
  };
}

export function entitlementFixture(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    id: "ent_fixture",
    eventId: "evt_fixture",
    userId: "usr_fixture_customer",
    orderId: "ord_fixture",
    productId: "prod_fixture",
    name: "Fixture Extra",
    quantityTotal: 1,
    quantityRemaining: 1,
    status: "active",
    createdAt: FIXTURE_NOW,
    ...overrides,
  };
}

export function operationsFixture(overrides: Partial<OperationsData> = {}): OperationsData {
  return {
    users: [userFixture(), ...staffFixtures()],
    consents: [],
    applications: [],
    allocations: [allocationFixture()],
    orders: [orderFixture()],
    payments: [],
    tickets: [],
    entitlements: [],
    checkIns: [],
    emailLogs: [],
    auditLogs: [],
    contacts: [],
    newsletter: [],
    reservations: [],
    checkoutAttempts: [],
    stripeWebhookEvents: [],
    paymentAdjustments: [],
    paymentRecoveryActions: [],
    eventStaffAssignments: [],
    eventStaffAssignmentAudits: [],
    notificationOutbox: [],
    notificationAttempts: [],
    notificationPreferences: [],
    notificationConsents: [],
    notificationChannelControls: [],
    eventNotificationControls: [],
    promoCodes: [],
    promoRedemptions: [],
    mediaObjects: [],
    mediaVideoAssets: [],
    mediaProviderEvents: [],
    analyticsEvents: [],
    entitlementRedemptions: [],
    adminSavedFilters: [],
    eventLaunchReadiness: [],
    ...overrides,
  };
}

export function stripeCheckoutFixture(
  overrides: Partial<StripeCheckoutSnapshot> = {},
): StripeCheckoutSnapshot {
  return {
    eventId: "evt_stripe_fixture",
    eventType: "checkout.session.completed",
    eventCreatedAtMs: Date.parse("2026-07-21T00:30:00.000Z"),
    sessionId: "cs_test_fixture",
    metadataOrderId: "ord_fixture",
    clientReferenceOrderId: "ord_fixture",
    paymentStatus: "paid",
    amountTotal: 10_500,
    currency: "aud",
    paymentIntentId: "pi_fixture",
    ...overrides,
  };
}

export type StripeWebhookFixture = {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
};

export function stripeWebhookFixture(
  overrides: Partial<StripeWebhookFixture> = {},
): StripeWebhookFixture {
  return {
    id: "evt_stripe_fixture",
    type: "checkout.session.completed",
    created: 1_774_224_600,
    data: {
      object: {
        id: "cs_test_fixture",
        payment_status: "paid",
        amount_total: 10_500,
        currency: "aud",
        payment_intent: "pi_fixture",
        client_reference_id: "ord_fixture",
        metadata: { order_id: "ord_fixture" },
      },
    },
    ...overrides,
  };
}

export type RefundFixture = {
  id: string;
  orderId: string;
  paymentIntentId: string;
  amountCents: number;
  status: "pending" | "succeeded" | "failed";
};

export function refundFixture(overrides: Partial<RefundFixture> = {}): RefundFixture {
  return {
    id: "re_fixture",
    orderId: "ord_fixture",
    paymentIntentId: "pi_fixture",
    amountCents: 10_500,
    status: "succeeded",
    ...overrides,
  };
}

export type DisputeFixture = {
  id: string;
  paymentIntentId: string;
  amountCents: number;
  status: "needs_response" | "won" | "lost";
};

export function disputeFixture(overrides: Partial<DisputeFixture> = {}): DisputeFixture {
  return {
    id: "dp_fixture",
    paymentIntentId: "pi_fixture",
    amountCents: 10_500,
    status: "needs_response",
    ...overrides,
  };
}

export type ProviderResponseFixture = {
  providerMessageId: string;
  status: "accepted" | "delivered" | "temporary_failure" | "permanent_failure";
  safeErrorCode?: string;
};

export function emailProviderResponseFixture(
  overrides: Partial<ProviderResponseFixture> = {},
): ProviderResponseFixture {
  return { providerMessageId: "email_fixture", status: "accepted", ...overrides };
}

export function smsProviderResponseFixture(
  overrides: Partial<ProviderResponseFixture> = {},
): ProviderResponseFixture {
  return { providerMessageId: "sms_fixture", status: "accepted", ...overrides };
}

export type PromoFixture = {
  id: string;
  code: string;
  type: "percentage" | "fixed";
  percentOff?: number;
  amountOffCents?: number;
  currency: "AUD";
  maxRedemptions: number;
  maxTicketUnits: number;
  redemptionCount: number;
  reservedTicketUnits: number;
  usedTicketUnits: number;
};

export function promoFixture(overrides: Partial<PromoFixture> = {}): PromoFixture {
  return {
    id: "promo_fixture",
    code: "FIXTURE20",
    type: "percentage",
    percentOff: 20,
    currency: "AUD",
    maxRedemptions: 10,
    maxTicketUnits: 20,
    redemptionCount: 0,
    reservedTicketUnits: 0,
    usedTicketUnits: 0,
    ...overrides,
  };
}
