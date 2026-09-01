export type AppMode = "test" | "live";

export type UserRole =
  | "customer"
  | "scanner_only"
  | "door_staff"
  | "admin"
  | "super_admin";

export type EventLifecycle =
  | "draft"
  | "preview"
  | "published"
  | "archived"
  | "cancelled";

export type EventVisibility =
  | "public"
  | "hidden"
  | "password"
  | "private_link"
  | "coming_soon"
  | "archived";

export type TicketMode =
  | "invite_only"
  | "direct_purchase"
  | "post_checkout_approval"
  | "coming_soon"
  | "closed"
  | "free_rsvp";

export type ApplicationStatus =
  | "pending"
  | "approved"
  | "waitlist"
  | "hold"
  | "rejected"
  | "cancelled";

export type AllocationStatus =
  | "unlocked"
  | "checkout_started"
  | "paid"
  | "expired"
  | "cancelled"
  | "ticket_issued";

export type OrderStatus =
  | "pending"
  | "paid"
  | "payment_received"
  | "fulfilment_pending"
  | "fulfilled"
  | "paid_unfulfilled"
  | "failed"
  | "expired"
  | "cancelled"
  | "refund_pending"
  | "refunded"
  | "partially_refunded"
  | "disputed"
  | "suspended"
  | "manual_review"
  | "recovery_failed";

export type TicketStatus =
  | "valid"
  | "checked_in"
  | "cancelled"
  | "refunded"
  | "expired"
  | "transferred"
  | "entry_refused"
  | "suspended";

export type ReservationStatus =
  | "reserved"
  | "session_active"
  | "payment_received"
  | "fulfilment_pending"
  | "fulfilled"
  | "expired"
  | "cancelled"
  | "failed"
  | "paid_unfulfilled"
  | "refund_pending"
  | "refunded"
  | "partially_refunded"
  | "disputed"
  | "suspended"
  | "manual_review"
  | "recovery_failed";

export type ProductType =
  | "ticket"
  | "drink_pass"
  | "add_on"
  | "vip_upgrade"
  | "merch"
  | "table_deposit";

export type ReviewStatus = "pending" | "approved" | "rejected" | "hidden";

export type ConsentType =
  | "terms"
  | "privacy"
  | "entry"
  | "age"
  | "media"
  | "marketing"
  | "sponsor";

export type VisualFocalPosition = "center" | "top" | "bottom" | "left" | "right";
export type VisualTextAlignment = "left" | "center";

export type PageCoverSettings = {
  coverImageUrl: string;
  coverOverlayOpacity: number;
  coverFocalPosition: VisualFocalPosition;
  coverTextAlignment: VisualTextAlignment;
};

export type HeroSlide = {
  id: string;
  active: boolean;
  kicker: string;
  title: string;
  subtitle: string;
  imageUrl: string;
  videoUrl?: string;
  ctaLabel: string;
  ctaHref: string;
  overlayOpacity?: number;
  focalPosition?: VisualFocalPosition;
  textAlignment?: VisualTextAlignment;
};

export type HomepageContent = {
  showUpcomingEvents: boolean;
  showMedia: boolean;
  showReviews: boolean;

  upcomingEyebrow: string;
  upcomingTitle: string;
  upcomingLinkLabel: string;
  emptyEventsTitle: string;
  emptyEventsBody: string;

  manifestoMarquee: string;
  manifestoEyebrow: string;
  manifestoTitle: string;
  manifestoBody: string;
  manifestoLinkLabel: string;
  manifestoLinkHref: string;

  mediaEyebrow: string;
  mediaTitle: string;
  mediaLinkLabel: string;

  reviewsEyebrow: string;
  reviewsTitle: string;
  reviewsLinkLabel: string;

  partnersEyebrow: string;
  partnersTitle: string;

  finalCtaEyebrow: string;
  finalCtaTitle: string;
  finalCtaButtonLabel: string;
  finalCtaButtonHref: string;
};

export type PageHeroContent = PageCoverSettings & {
  eyebrow: string;
  title: string;
  body: string;
};

export type WebsitePagesContent = {
  events: PageHeroContent & {
    emptyState: string;
  };
  previousEvents: PageHeroContent & {
    emptyState: string;
  };
  media: PageHeroContent;
  reviews: PageHeroContent & {
    formEyebrow: string;
    formTitle: string;
  };
  about: PageCoverSettings;
  contact: PageHeroContent & {
    emailLabel: string;
    instagramLabel: string;
    instagramLinkLabel: string;
    basedLabel: string;
    basedValue: string;
  };
};

export type FooterContent = {
  exploreLabel: string;
  eventsLabel: string;
  mediaLabel: string;
  reviewsLabel: string;
  accountLabel: string;
  connectLabel: string;
  instagramLabel: string;
  contactLabel: string;
  policiesLabel: string;
  termsLabel: string;
  privacyLabel: string;
  refundsLabel: string;
  entryLabel: string;
  locationLabel: string;
};

export type SiteSettings = {
  appMode: AppMode;
  currency: string;
  timezone: string;
  defaultTicketLimit: number;
  defaultAllocationExpiryHours: number;
  newsletterEnabled: boolean;
  featuredSponsorCarousel: boolean;
};

export type EventTicketType = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  capacity: number;
  sold: number;
  defaultMaxPerCustomer: number;
  salesStartAt?: string;
  salesEndAt?: string;
  active: boolean;
};

export type EventProduct = {
  id: string;
  eventId: string;
  name: string;
  description: string;
  type: ProductType;
  priceCents: number;
  stockQuantity: number;
  soldQuantity: number;
  maxPerOrder: number;
  maxPerCustomer: number;
  requiresApproval: boolean;
  requiresTicket: boolean;
  isRedeemable: boolean;
  unitsPerPurchase: number;
  imageUrl: string;
  salesStartAt?: string;
  salesEndAt?: string;
  active: boolean;
  visibleOnEventPage: boolean;
};

export type EventItem = {
  id: string;
  slug: string;
  title: string;
  date: string;
  endDate?: string;
  time: string;
  venue: string;
  location: string;
  genre: string;
  teaser: string;
  description: string;
  posterUrl: string;
  heroUrl: string;
  accent: string;
  lineup: string[];
  houseRules: string[];
  faq: Array<{ question: string; answer: string }>;
  ageRestriction: string;
  lifecycle: EventLifecycle;
  visibility: EventVisibility;
  password?: string;
  ticketMode: TicketMode;
  featured: boolean;
  sponsorIds: string[];
  formId?: string;
  venueCapacity: number;
  publicCapacity: number;
  sponsorAllocation: number;
  guestlistAllocation: number;
  teamAllocation: number;
  safetyBuffer: number;
  defaultTicketLimit: number;
  ticketTypes: EventTicketType[];
  productIds: string[];
};

export type Sponsor = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  logoUrl: string;
  bannerUrl: string;
  websiteUrl: string;
  instagramUrl?: string;
  active: boolean;
};

export type MediaItem = {
  id: string;
  title: string;
  eventName: string;
  eventId?: string;
  type: "image" | "video";
  url: string;
  thumbnailUrl?: string;
  posterUrl?: string;
  manualPosterUrl?: string;
  generatedPosterUrl?: string;
  fallbackPosterUrl?: string;
  posterTimeSeconds?: number;
  provider?: "local" | "mux";
  processingStatus?: MediaVideoStatus;
  providerUploadId?: string;
  providerAssetId?: string;
  playbackId?: string;
  playbackPolicy?: "public" | "signed";
  durationSeconds?: number;
  maxResolution?: string;
  processingErrorCode?: string;
  processingErrorMessage?: string;
  captions?: MediaCaptionTrack[];
  caption?: string;
  altText?: string;
  order?: number;
  visibility?: "draft" | "published";
  mimeType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  aspectRatio?: number;
  focalX?: number;
  focalY?: number;
  createdAt?: string;
  updatedAt?: string;
  featured: boolean;
  published: boolean;
};

export type MediaVideoStatus = "pending_upload" | "uploaded" | "processing" | "ready" | "failed" | "deleted";

export type MediaCaptionTrack = {
  id: string;
  kind: "captions" | "subtitles";
  label: string;
  language: string;
  src: string;
  default?: boolean;
};

export type MediaVideoAsset = {
  id: string;
  mediaItemId: string;
  eventId?: string;
  provider: "mux";
  status: MediaVideoStatus;
  providerUploadId: string;
  providerAssetId?: string;
  playbackId?: string;
  playbackPolicy: "public" | "signed";
  durationSeconds?: number;
  aspectRatio?: number;
  maxResolution?: string;
  processingErrorCode?: string;
  processingErrorMessage?: string;
  sanitizedMetadata: Record<string, string | number | boolean | null>;
  generatedPosterUrl?: string;
  posterTimeSeconds: number;
  manualPosterUrl?: string;
  fallbackPosterUrl?: string;
  captions: MediaCaptionTrack[];
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  uploadedAt?: string;
  readyAt?: string;
  failedAt?: string;
  deletedAt?: string;
};

export type MediaProviderEvent = {
  id: string;
  provider: "mux";
  providerEventId: string;
  eventType: string;
  mediaVideoAssetId?: string;
  providerCreatedAt?: string;
  receivedAt: string;
};

export type AnalyticsEventName =
  | "page_view" | "event_page_view" | "application_started" | "application_completed" | "allocation_unlocked"
  | "checkout_started" | "checkout_cancelled" | "payment_completed" | "payment_failed" | "ticket_issued"
  | "promo_applied" | "promo_rejected" | "notification_queued" | "notification_delivered" | "notification_failed"
  | "video_impression" | "video_started" | "video_completed" | "ticket_scan_accepted" | "ticket_scan_rejected"
  | "ticket_scan_duplicate" | "addon_redemption" | "addon_redemption_reversal";

export type AnalyticsEvent = {
  id: string;
  eventName: AnalyticsEventName;
  source: "client" | "server";
  deduplicationKey: string;
  eventId?: string;
  ticketTypeId?: string;
  promoCodeId?: string;
  notificationChannel?: NotificationChannel;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  referrerCategory?: "direct" | "search" | "social" | "email" | "partner" | "internal" | "other";
  deviceCategory?: "mobile" | "tablet" | "desktop" | "other";
  browserFamily?: "chrome" | "safari" | "firefox" | "edge" | "other";
  anonymousSessionHash?: string;
  customerId?: string;
  revenueCents?: number;
  quantity?: number;
  safeMetadata: Record<string, string | number | boolean | null>;
  occurredAt: string;
  melbourneDate: string;
  retentionUntil: string;
  createdAt: string;
};

export type AnalyticsReport = {
  startDate: string;
  endDate: string;
  totals: { events: number; revenueCents: number; ticketQuantity: number };
  byEventType: Array<{ eventName: AnalyticsEventName; count: number; revenueCents: number; quantity: number }>;
  byDate: Array<{ date: string; count: number; revenueCents: number }>;
};

export type MediaStorageObject = {
  id: string;
  bucket: "media";
  objectKey: string;
  publicUrl: string;
  kind: "image" | "video";
  mimeType: string;
  sizeBytes: number;
  status: "orphan" | "referenced" | "deleted";
  uploadedBy: string;
  createdAt: string;
  referencedAt?: string;
  orphanedAt?: string;
  deletedAt?: string;
};

export type Review = {
  id: string;
  userId?: string;
  eventId?: string;
  name: string;
  rating: number;
  body: string;
  status: ReviewStatus;
  featured: boolean;
  createdAt: string;
};

export type FormField = {
  id: string;
  key: string;
  label: string;
  type: "text" | "email" | "phone" | "textarea" | "select" | "radio" | "checkbox";
  required: boolean;
  placeholder: string;
  options: string[];
  maxLength?: number;
};

export type ApplicationForm = {
  id: string;
  name: string;
  intro: string;
  fields: FormField[];
  active: boolean;
};

export type EmailTemplate = {
  id: string;
  key: string;
  name: string;
  subject: string;
  html: string;
  active: boolean;
  updatedAt: string;
};

export type LegalPage = {
  id: string;
  slug:
    | "terms"
    | "privacy"
    | "refund-policy"
    | "entry-policy"
    | "media-release"
    | "age-policy";
  title: string;
  version: string;
  content: string;
  publishedAt: string;
};

export type SiteData = {
  brand: {
    name: string;
    statement: string;
    instagramUrl: string;
    contactEmail: string;
    contactPhone: string;
    accent: string;
  };
  about: {
    eyebrow: string;
    title: string;
    body: string[];
  };
  homepage?: HomepageContent;
  pages?: WebsitePagesContent;
  footer?: FooterContent;
  settings: SiteSettings;
  heroSlides: HeroSlide[];
  events: EventItem[];
  products: EventProduct[];
  sponsors: Sponsor[];
  media: MediaItem[];
  reviews: Review[];
  forms: ApplicationForm[];
  emailTemplates: EmailTemplate[];
  legalPages: LegalPage[];
};

export type UserProfile = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  instagram: string;
  passwordHash?: string;
  role: UserRole;
  tags: string[];
  internalNotes: string;
  createdAt: string;
  updatedAt: string;
};

export type ConsentRecord = {
  id: string;
  userId: string;
  eventId?: string;
  type: ConsentType;
  accepted: boolean;
  textShown: string;
  policyVersion: string;
  acceptedAt: string;
  ipHash?: string;
  userAgent?: string;
};

export type Application = {
  id: string;
  eventId: string;
  userId: string;
  formId: string;
  answers: Record<string, string | boolean | number>;
  status: ApplicationStatus;
  adminNotes: string;
  duplicateFlags: string[];
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
};

export type TicketAllocation = {
  id: string;
  eventId: string;
  userId: string;
  applicationId?: string;
  ticketTypeId: string;
  maxQuantity: number;
  purchasedQuantity: number;
  priceCents: number;
  status: AllocationStatus;
  expiresAt: string;
  approvedBy: string;
  approvedAt: string;
  cancelledAt?: string;
};

export type CartItem = {
  kind: "ticket" | "product";
  referenceId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
};

export type Order = {
  id: string;
  eventId: string;
  userId: string;
  allocationId?: string;
  reservationId?: string;
  reservationVersion?: number;
  checkoutAttemptId?: string;
  status: OrderStatus;
  currency: string;
  subtotalCents: number;
  discountCents?: number;
  totalCents: number;
  promoCodeId?: string;
  promoCodeSnapshot?: string;
  items: CartItem[];
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  paidAt?: string;
  expiresAt: string;
};

export type Payment = {
  id: string;
  orderId: string;
  provider: "test" | "stripe" | "free";
  providerReference: string;
  amountCents: number;
  currency: string;
  status:
    | "pending"
    | "payment_received"
    | "paid"
    | "failed"
    | "cancelled"
    | "refund_pending"
    | "refunded"
    | "partially_refunded"
    | "disputed"
    | "suspended"
    | "manual_review";
  refundedCents?: number;
  createdAt: string;
  updatedAt: string;
};

export type Ticket = {
  id: string;
  eventId: string;
  userId: string;
  orderId?: string;
  ticketTypeId: string;
  ticketCode: string;
  tokenHash: string;
  tokenPreview: string;
  status: TicketStatus;
  statusBeforeSuspension?: Exclude<TicketStatus, "suspended">;
  holderName: string;
  holderEmail: string;
  checkedInAt?: string;
  checkedInBy?: string;
  createdAt: string;
};

export type Entitlement = {
  id: string;
  eventId: string;
  userId: string;
  orderId: string;
  productId: string;
  name: string;
  quantityTotal: number;
  quantityRemaining: number;
  status: "active" | "redeemed" | "cancelled" | "refunded" | "suspended";
  statusBeforeSuspension?: "active" | "redeemed" | "cancelled" | "refunded";
  createdAt: string;
};

export type CheckInRecord = {
  id: string;
  eventId: string;
  ticketId: string;
  scannedBy: string;
  result:
    | "valid"
    | "already_checked_in"
    | "wrong_event"
    | "cancelled"
    | "refunded"
    | "suspended"
    | "expired"
    | "invalid";
  notes: string;
  scannedAt: string;
  reversedAt?: string;
  reversedBy?: string;
  reversalReason?: string;
};

export type EmailLog = {
  id: string;
  templateKey: string;
  to: string;
  subject: string;
  html: string;
  status: "queued" | "sent" | "failed" | "test_outbox";
  providerId?: string;
  error?: string;
  idempotencyKey: string;
  createdAt: string;
};

export type NotificationStatus =
  | "queued"
  | "processing"
  | "retry"
  | "claimed"
  | "sent"
  | "delivered"
  | "temporary_failure"
  | "failed"
  | "dry_run"
  | "cancelled";

export type NotificationPayload = {
  variables?: Record<string, string | number>;
  orderId?: string;
  requestedBy?: string;
  reason?: "workflow" | "ticket_resend" | "local_test" | "admin_manual";
};

export type NotificationChannel = "email" | "sms" | "in_app" | "whatsapp";

export type NotificationOutboxItem = {
  id: string;
  channel: NotificationChannel;
  templateKey: string;
  recipientUserId?: string;
  recipientAddress: string;
  eventId?: string;
  orderId?: string;
  payload: NotificationPayload;
  idempotencyKey: string;
  status: NotificationStatus;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  leaseExpiresAt?: string;
  leaseOwner?: string;
  providerMessageId?: string;
  safeErrorCode?: string;
  correlationId: string;
  sentAt?: string;
  deliveredAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type NotificationAttempt = {
  id: string;
  outboxId: string;
  attemptNumber: number;
  status: "processing" | "claimed" | "accepted" | "sent" | "delivered" | "retry" | "temporary_failure" | "permanent_failure" | "dry_run";
  providerMessageId?: string;
  safeErrorCode?: string;
  startedAt: string;
  finishedAt?: string;
};

export type NotificationPreference = {
  userId: string;
  channel: NotificationChannel;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type NotificationConsent = {
  id: string;
  userId: string;
  channel: "sms" | "whatsapp";
  consentType: "transactional";
  accepted: boolean;
  textShown: string;
  policyVersion: string;
  ipHash?: string;
  userAgent?: string;
  createdAt: string;
};

export type EntitlementRedemption = {
  id: string;
  entitlementId: string;
  eventId: string;
  quantity: number;
  redeemedBy: string;
  idempotencyKey: string;
  redeemedAt: string;
  reversedAt?: string;
  reversedBy?: string;
  reversalReason?: string;
};

export type NotificationChannelControl = {
  channel: NotificationChannel;
  enabled: boolean;
  updatedBy?: string;
  updatedAt: string;
};

export type EventNotificationControl = NotificationChannelControl & { eventId: string };

export type PromoCode = {
  id: string;
  code: string;
  internalName: string;
  description: string;
  active: boolean;
  discountType: "percentage" | "fixed" | "tracking";
  percentOff?: number;
  amountOffCents?: number;
  currency: "AUD";
  validFrom?: string;
  expiresAt?: string;
  maxRedemptions?: number;
  maxDiscountedTicketUnits?: number;
  maxUsesPerCustomer?: number;
  minimumOrderCents: number;
  firstPurchaseOnly: boolean;
  eventIds: string[];
  ticketTypeIds: string[];
  productIds: string[];
  status: "draft" | "active" | "inactive" | "expired" | "provider_error";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type PromoRedemption = {
  id: string;
  promoCodeId: string;
  reservationId: string;
  orderId: string;
  customerId: string;
  eventId: string;
  status: "reserved" | "released" | "finalized" | "refunded" | "disputed";
  discountedTicketUnits: number;
  originalSubtotalCents: number;
  discountCents: number;
  finalTotalCents: number;
  reservedUntil: string;
  finalizedAt?: string;
  releasedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type EventStaffRole = "scanner_only" | "door_staff" | "event_admin";

export type EventStaffAssignment = {
  id: string;
  userId: string;
  eventId: string;
  role: EventStaffRole;
  active: boolean;
  startsAt: string;
  endsAt?: string;
  assignedBy: string;
  revokedBy?: string;
  revokedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type EventStaffAssignmentAudit = {
  id: string;
  assignmentId: string;
  eventId: string;
  subjectUserId: string;
  actorId: string;
  action: "assigned" | "updated" | "revoked";
  role: EventStaffRole;
  startsAt: string;
  endsAt?: string;
  createdAt: string;
};

export type ReservationTicketLine = CartItem & {
  kind: "ticket";
  ticketTypeCapacity: number;
  eventPublicCapacity: number;
  customerLimit: number;
};

export type ReservationProductLine = CartItem & {
  kind: "product";
  stockQuantity: number;
  maxPerCustomer: number;
  unitsPerPurchase: number;
  redeemable: boolean;
};

export type Reservation = {
  id: string;
  reservationKey: string;
  version: number;
  orderId: string;
  checkoutAttemptId: string;
  customerId: string;
  customerEmail: string;
  customerName: string;
  eventId: string;
  eventTitle: string;
  allocationId?: string;
  promoCodeId?: string;
  status: ReservationStatus;
  ticketLines: ReservationTicketLine[];
  productLines: ReservationProductLine[];
  expectedSubtotalCents: number;
  expectedDiscountCents: number;
  expectedTotalCents: number;
  currency: string;
  expiresAt: string;
  correlationId: string;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
};

export type CheckoutAttempt = {
  id: string;
  reservationId: string;
  reservationVersion: number;
  orderId: string;
  status:
    | "creating_session"
    | "session_active"
    | "session_expired"
    | "session_failed"
    | "orphan_session"
    | "payment_received"
    | "fulfilled"
    | "manual_review"
    | "recovery_failed";
  idempotencyKey: string;
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  providerExpiresAt?: string;
  correlationId: string;
  failureCode?: string;
  recoveryAttempts: number;
  createdAt: string;
  updatedAt: string;
};

export type StripeWebhookEventRecord = {
  stripeEventId: string;
  eventType: string;
  livemode: boolean;
  objectId?: string;
  checkoutSessionId?: string;
  paymentIntentId?: string;
  chargeId?: string;
  refundId?: string;
  disputeId?: string;
  status: "received" | "processing" | "processed" | "temporary_failure" | "permanent_failure" | "manual_review";
  processingAttempts: number;
  correlationId: string;
  safeErrorCode?: string;
  providerCreatedAt: string;
  receivedAt: string;
  processedAt?: string;
};

export type PaymentAdjustment = {
  id: string;
  orderId: string;
  paymentId: string;
  kind: "refund" | "dispute";
  providerObjectId: string;
  status: "pending" | "succeeded" | "failed" | "needs_response" | "won" | "lost" | "closed" | "manual_review";
  amountCents: number;
  currency: string;
  lineAttribution?: Array<{
    referenceId: string;
    quantity: number;
    amountCents: number;
    ticketIds?: string[];
    entitlementIds?: string[];
  }>;
  createdAt: string;
  updatedAt: string;
};

export type PaymentRecoveryAction = {
  id: string;
  orderId?: string;
  reservationId?: string;
  action: string;
  actorId: string;
  actorLabel: string;
  idempotencyKey: string;
  status: "requested" | "completed" | "failed" | "manual_review";
  safeMetadata: Record<string, string | number | boolean | null>;
  safeErrorCode?: string;
  createdAt: string;
  completedAt?: string;
};

export type AuditLog = {
  id: string;
  actorId: string;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: string;
};

export type AdminSavedFilter = {
  id: string;
  actorId: string;
  scope: "applications" | "ticketing" | "notifications" | "analytics";
  name: string;
  filters: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
};

export type EventLaunchReadiness = {
  eventId: string;
  checklist: Record<string, boolean>;
  lowStockThreshold: number;
  capacityWarningPercent: number;
  updatedBy: string;
  updatedAt: string;
};

export type ContactMessage = {
  id: string;
  name: string;
  email: string;
  subject: string;
  message: string;
  status: "new" | "resolved";
  createdAt: string;
};

export type OperationsData = {
  users: UserProfile[];
  consents: ConsentRecord[];
  applications: Application[];
  allocations: TicketAllocation[];
  orders: Order[];
  payments: Payment[];
  tickets: Ticket[];
  entitlements: Entitlement[];
  entitlementRedemptions: EntitlementRedemption[];
  checkIns: CheckInRecord[];
  emailLogs: EmailLog[];
  auditLogs: AuditLog[];
  contacts: ContactMessage[];
  newsletter: Array<{ id: string; email: string; createdAt: string }>;
  reservations: Reservation[];
  checkoutAttempts: CheckoutAttempt[];
  stripeWebhookEvents: StripeWebhookEventRecord[];
  paymentAdjustments: PaymentAdjustment[];
  paymentRecoveryActions: PaymentRecoveryAction[];
  eventStaffAssignments: EventStaffAssignment[];
  eventStaffAssignmentAudits: EventStaffAssignmentAudit[];
  notificationOutbox: NotificationOutboxItem[];
  notificationAttempts: NotificationAttempt[];
  notificationPreferences: NotificationPreference[];
  notificationConsents: NotificationConsent[];
  notificationChannelControls: NotificationChannelControl[];
  eventNotificationControls: EventNotificationControl[];
  promoCodes: PromoCode[];
  promoRedemptions: PromoRedemption[];
  mediaObjects: MediaStorageObject[];
  mediaVideoAssets: MediaVideoAsset[];
  mediaProviderEvents: MediaProviderEvent[];
  analyticsEvents: AnalyticsEvent[];
  adminSavedFilters: AdminSavedFilter[];
  eventLaunchReadiness: EventLaunchReadiness[];
};

export type SessionUser = Pick<UserProfile, "id" | "firstName" | "lastName" | "email" | "role">;
