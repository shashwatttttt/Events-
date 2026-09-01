import type { AppMode } from "@/types/site";

function intEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function dataProviderEnv() {
  return process.env.DATA_PROVIDER?.trim().toLowerCase() === "supabase"
    ? "supabase"
    : "local";
}

function floatEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function normalizedEnv(name: string) {
  return process.env[name]?.trim().toLowerCase() || "";
}

function isVercelPreview() {
  return process.env.VERCEL_ENV === "preview";
}

const legacyFormMinutes = intEnv("POST_CHECKOUT_FORM_MINUTES", 60);
const actualFormHours = Math.max(1, Math.min(7 * 24, intEnv("POST_CHECKOUT_ACTUAL_FORM_HOURS", 5 * 24)));
const metaPixelId = (process.env.NEXT_PUBLIC_META_PIXEL_ID || "").trim();
const metaGraphApiVersion = (process.env.META_GRAPH_API_VERSION || "").trim();
const metaConversionsApiToken = (process.env.META_CONVERSIONS_API_TOKEN || "").trim();
const metaConversionsApiRequested = normalizedEnv("META_CONVERSIONS_API_ENABLED") === "true";

export const config = {
  brandName: process.env.NEXT_PUBLIC_BRAND_NAME || "SKIE EVENTS",
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
  appMode: (process.env.APP_MODE === "live" ? "live" : "test") as AppMode,
  dataProvider: dataProviderEnv(),
  timezone: process.env.APP_TIMEZONE || "Australia/Melbourne",
  currency: process.env.APP_CURRENCY || "AUD",
  defaultTicketLimit: intEnv("DEFAULT_TICKET_LIMIT", 2),
  defaultAllocationExpiryHours: intEnv("DEFAULT_ALLOCATION_EXPIRY_HOURS", 48),
  authSecret: process.env.AUTH_SECRET || "development-only-change-me-development-only",
  ticketSecret: process.env.TICKET_TOKEN_SECRET || process.env.AUTH_SECRET || "development-ticket-secret-change-me",
  adminEmail: (process.env.ADMIN_EMAIL || "admin@skieevents.com").toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || "skie-local-admin",
  emailFrom: process.env.EMAIL_FROM || "SKIE EVENTS <tickets@skieevents.com>",
  emailReplyTo: process.env.EMAIL_REPLY_TO || "hello@skieevents.com",
  emailProvider: normalizedEnv("EMAIL_PROVIDER") === "resend" ? "resend" : "local",
  smsProvider: normalizedEnv("SMS_PROVIDER") === "twilio" ? "twilio" : "local",
  notificationDefaultCountry: process.env.NOTIFICATION_DEFAULT_COUNTRY || "AU",
  whatsappNotificationsEnabled: normalizedEnv("WHATSAPP_NOTIFICATIONS_ENABLED") === "true",
  twilioStatusCallbackUrl: process.env.TWILIO_STATUS_CALLBACK_URL || "",
  mediaVideoProvider: normalizedEnv("MEDIA_VIDEO_PROVIDER") === "mux" ? "mux" : "local",
  mediaVideoAllowedInputTypes: (process.env.MEDIA_VIDEO_ALLOWED_INPUT_TYPES || "video/mp4,video/quicktime,video/webm").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
  mediaVideoMaxUploadBytes: Math.max(1, intEnv("MEDIA_VIDEO_MAX_UPLOAD_BYTES", 5 * 1024 * 1024 * 1024)),
  muxDefaultPlaybackPolicy: normalizedEnv("MUX_DEFAULT_PLAYBACK_POLICY") === "signed" ? "signed" : "public",
  muxPosterDefaultTimeSeconds: Math.max(0, floatEnv("MUX_POSTER_DEFAULT_TIME_SECONDS", 1)),
  notificationWorkerSecret: process.env.NOTIFICATION_WORKER_SECRET || "local-notification-worker-only",
  postCheckoutApprovalEnabled: normalizedEnv("POST_CHECKOUT_APPROVAL_ENABLED") === "true",
  postCheckoutFormMinutes: actualFormHours * 60,
  postCheckoutCustomerUrgencyMinutes: Math.max(15, Math.min(24 * 60, intEnv("POST_CHECKOUT_CUSTOMER_URGENCY_MINUTES", legacyFormMinutes))),
  postCheckoutActualFormHours: actualFormHours,
  postCheckoutReviewHours: Math.max(1, Math.min(120, intEnv("POST_CHECKOUT_REVIEW_HOURS", 24))),
  postCheckoutCaptureSafetyMinutes: Math.max(30, Math.min(24 * 60, intEnv("POST_CHECKOUT_CAPTURE_SAFETY_MINUTES", 60))),
  postCheckoutWorkerSecret: process.env.POST_CHECKOUT_WORKER_SECRET || "local-post-checkout-worker-only",
  metaPixelId,
  metaConversionsApiRequested,
  metaConversionsApiEnabled: metaConversionsApiRequested
    && Boolean(metaPixelId && metaGraphApiVersion && metaConversionsApiToken),
  metaConversionsApiConfigured: Boolean(metaPixelId && metaGraphApiVersion && metaConversionsApiToken),
  metaGraphApiVersion,
  metaConversionsApiToken,
  metaTestEventCode: (process.env.META_TEST_EVENT_CODE || "").trim(),
  metaAdsConsentVersion: (process.env.META_ADS_CONSENT_VERSION || "2026-07-30").trim(),
  isTest: process.env.APP_MODE !== "live",
} as const;

export function assertLiveDataProvider() {
  if (config.appMode === "live" && config.dataProvider !== "supabase") {
    throw new Error("Live mode requires DATA_PROVIDER=supabase.");
  }
}

export function assertLiveConfiguration() {
  assertLiveDataProvider();
  if (config.appMode !== "live") return;

  const required = [
    "NEXT_PUBLIC_SITE_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "AUTH_SECRET",
    "TICKET_TOKEN_SECRET",
  ];

  // Preview deployments must be able to build before staging-only provider
  // credentials and webhook signing secrets are connected. Production remains
  // fail-closed, while each runtime integration also validates its own secret.
  if (!isVercelPreview()) {
    required.push(
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "RESEND_API_KEY",
      "RESEND_WEBHOOK_SECRET",
      "EMAIL_FROM",
      "EMAIL_REPLY_TO",
      "EMAIL_PROVIDER",
      "NOTIFICATION_WORKER_SECRET",
    );
    if (config.postCheckoutApprovalEnabled) required.push("POST_CHECKOUT_WORKER_SECRET");
  }

  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing live environment variables: ${missing.join(", ")}`);
  if (!config.siteUrl.startsWith("https://")) throw new Error("Live NEXT_PUBLIC_SITE_URL must use HTTPS.");
  if (config.authSecret.length < 32 || config.ticketSecret.length < 32) throw new Error("AUTH_SECRET and TICKET_TOKEN_SECRET must be at least 32 characters.");
  if (config.authSecret === config.ticketSecret) throw new Error("AUTH_SECRET and TICKET_TOKEN_SECRET must be different values.");
  if (!isVercelPreview() && config.postCheckoutApprovalEnabled && config.postCheckoutWorkerSecret.length < 32) {
    throw new Error("POST_CHECKOUT_WORKER_SECRET must be at least 32 characters when post-checkout approval is enabled.");
  }
  if (!isVercelPreview() && config.metaConversionsApiRequested && !config.metaConversionsApiConfigured) {
    throw new Error("Meta Conversions API is enabled but its Pixel ID, Graph API version, or access token is missing.");
  }
  if (!isVercelPreview() && config.smsProvider === "twilio") {
    const twilioRequired = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_STATUS_CALLBACK_URL"];
    const twilioMissing = twilioRequired.filter((name) => !process.env[name]);
    if (!process.env.TWILIO_MESSAGING_SERVICE_SID && !process.env.TWILIO_FROM_NUMBER) twilioMissing.push("TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER");
    if (twilioMissing.length) throw new Error(`Missing Twilio environment variables: ${twilioMissing.join(", ")}`);
    if (!config.twilioStatusCallbackUrl.startsWith("https://")) throw new Error("TWILIO_STATUS_CALLBACK_URL must use HTTPS in live mode.");
  }
  if (!isVercelPreview() && config.whatsappNotificationsEnabled && !process.env.TWILIO_WHATSAPP_FROM) throw new Error("TWILIO_WHATSAPP_FROM is required when WhatsApp notifications are enabled.");
  if (!isVercelPreview() && config.mediaVideoProvider === "mux") {
    const muxRequired = ["MUX_TOKEN_ID", "MUX_TOKEN_SECRET", "MUX_WEBHOOK_SECRET"];
    const muxMissing = muxRequired.filter((name) => !process.env[name]);
    if (muxMissing.length) throw new Error(`Missing Mux environment variables: ${muxMissing.join(", ")}`);
  }
}
