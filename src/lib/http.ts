import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

export class PublicApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "PublicApiError";
  }
}

type KnownOperationalError = {
  publicCode: string;
  message: string;
  status: number;
};

const KNOWN_OPERATIONAL_ERRORS: Record<string, KnownOperationalError> = {
  "Post-checkout approval is not currently enabled.": {
    publicCode: "POST_APPROVAL_DISABLED",
    message: "Application checkout is not active on the server yet. No payment authorisation was created.",
    status: 503,
  },
  "Post-checkout approval requires durable Supabase storage.": {
    publicCode: "POST_APPROVAL_STORE_INACTIVE",
    message: "Application checkout storage is not active. No payment authorisation was created.",
    status: 503,
  },
  "Post-checkout application availability could not be checked.": {
    publicCode: "POST_APPROVAL_STORE_UNAVAILABLE",
    message: "Application checkout could not verify its database state. Try again shortly.",
    status: 503,
  },
  "You already have an active application for this event. Open your account to continue it.": {
    publicCode: "POST_APPROVAL_ALREADY_ACTIVE",
    message: "You already started an application checkout for this event. Open My Account to continue it.",
    status: 409,
  },
  "This event does not have an application form configured.": {
    publicCode: "POST_APPROVAL_EVENT_CONFIGURATION",
    message: "This event application is temporarily unavailable because its form is not configured.",
    status: 503,
  },
  "This event application form is not available.": {
    publicCode: "POST_APPROVAL_EVENT_CONFIGURATION",
    message: "This event application is temporarily unavailable because its form is inactive.",
    status: 503,
  },
  ACTIVE_CHECKOUT_CONFLICT: {
    publicCode: "ACTIVE_CHECKOUT_CONFLICT",
    message: "You already have a checkout in progress for this event. Continue that checkout or wait for it to expire.",
    status: 409,
  },
  CHECKOUT_CREATION_CONFLICT: {
    publicCode: "CHECKOUT_CREATION_CONFLICT",
    message: "Another checkout request is already being processed. Wait a moment and try once.",
    status: 409,
  },
  ALLOCATION_LIMIT_EXCEEDED: {
    publicCode: "ALLOCATION_LIMIT_EXCEEDED",
    message: "This ticket allocation does not allow the selected quantity.",
    status: 409,
  },
  ALLOCATION_NOT_AVAILABLE: {
    publicCode: "ALLOCATION_NOT_AVAILABLE",
    message: "This ticket allocation is no longer available.",
    status: 409,
  },
  CUSTOMER_TICKET_LIMIT_EXCEEDED: {
    publicCode: "CUSTOMER_TICKET_LIMIT_EXCEEDED",
    message: "This account has reached its ticket limit for the event.",
    status: 409,
  },
  EVENT_CAPACITY_EXCEEDED: {
    publicCode: "EVENT_CAPACITY_EXCEEDED",
    message: "The remaining public event capacity is not enough for this order.",
    status: 409,
  },
  TICKET_CAPACITY_EXCEEDED: {
    publicCode: "TICKET_CAPACITY_EXCEEDED",
    message: "The selected ticket type does not have enough remaining tickets.",
    status: 409,
  },
  EVENT_SALES_CLOSED: {
    publicCode: "EVENT_SALES_CLOSED",
    message: "Ticket sales for this event are closed.",
    status: 409,
  },
  CUSTOMER_PRODUCT_LIMIT_EXCEEDED: {
    publicCode: "CUSTOMER_PRODUCT_LIMIT_EXCEEDED",
    message: "This account has reached the purchase limit for one of the selected extras.",
    status: 409,
  },
  PRODUCT_STOCK_EXCEEDED: {
    publicCode: "PRODUCT_STOCK_EXCEEDED",
    message: "One of the selected event extras no longer has enough stock.",
    status: 409,
  },
  PROMO_CUSTOMER_LIMIT: {
    publicCode: "PROMO_CUSTOMER_LIMIT",
    message: "This promo code has already reached its limit for this account.",
    status: 422,
  },
  PROMO_EVENT_RESTRICTED: {
    publicCode: "PROMO_EVENT_RESTRICTED",
    message: "This promo code cannot be used for this event.",
    status: 422,
  },
  PROMO_EXPIRED: {
    publicCode: "PROMO_EXPIRED",
    message: "This promo code has expired.",
    status: 422,
  },
  PROMO_FIRST_PURCHASE_ONLY: {
    publicCode: "PROMO_FIRST_PURCHASE_ONLY",
    message: "This promo code is only available for a first completed purchase.",
    status: 422,
  },
  PROMO_ITEMS_NOT_ELIGIBLE: {
    publicCode: "PROMO_ITEMS_NOT_ELIGIBLE",
    message: "The selected tickets or extras are not eligible for this promo code.",
    status: 422,
  },
  PROMO_MINIMUM_NOT_MET: {
    publicCode: "PROMO_MINIMUM_NOT_MET",
    message: "This order does not meet the promo code minimum.",
    status: 422,
  },
  PROMO_NOT_AVAILABLE: {
    publicCode: "PROMO_NOT_AVAILABLE",
    message: "This promo code is not currently available.",
    status: 422,
  },
  PROMO_NOT_FOUND: {
    publicCode: "PROMO_NOT_FOUND",
    message: "Promo code not found.",
    status: 422,
  },
  PROMO_NOT_STARTED: {
    publicCode: "PROMO_NOT_STARTED",
    message: "This promo code is not active yet.",
    status: 422,
  },
  PROMO_REDEMPTION_LIMIT: {
    publicCode: "PROMO_REDEMPTION_LIMIT",
    message: "This promo code has reached its total redemption limit.",
    status: 422,
  },
  PROMO_TICKET_UNIT_LIMIT: {
    publicCode: "PROMO_TICKET_UNIT_LIMIT",
    message: "The selected ticket quantity exceeds this promo code's limit.",
    status: 422,
  },
  CHECKOUT_ATTEMPT_NOT_FOUND: {
    publicCode: "CHECKOUT_ATTEMPT_NOT_FOUND",
    message: "The checkout reservation could not be found. Refresh the page and try once.",
    status: 409,
  },
  CHECKOUT_ATTEMPT_NOT_LINKABLE: {
    publicCode: "CHECKOUT_ATTEMPT_NOT_LINKABLE",
    message: "The checkout session is no longer in a linkable state. Refresh the page before retrying.",
    status: 409,
  },
  RESERVATION_NOT_LINKABLE: {
    publicCode: "RESERVATION_NOT_LINKABLE",
    message: "The ticket reservation is no longer active. Refresh the page before retrying.",
    status: 409,
  },
  ORPHAN_STRIPE_SESSION: {
    publicCode: "ORPHAN_STRIPE_SESSION",
    message: "The payment session requires automatic recovery before checkout can continue.",
    status: 503,
  },
  PAYMENT_AMOUNT_MISMATCH: {
    publicCode: "PAYMENT_AMOUNT_MISMATCH",
    message: "The payment amount no longer matches the reserved order. No payment was created.",
    status: 409,
  },
  PAYMENT_INTENT_MISMATCH: {
    publicCode: "PAYMENT_INTENT_MISMATCH",
    message: "The payment reference did not match the reserved order. No payment was completed.",
    status: 409,
  },
  PAYMENT_ORDER_REFERENCE_MISMATCH: {
    publicCode: "PAYMENT_ORDER_REFERENCE_MISMATCH",
    message: "The payment session did not match the reserved order.",
    status: 409,
  },
  POST_APPROVAL_STORE_UNAVAILABLE: {
    publicCode: "POST_APPROVAL_STORE_UNAVAILABLE",
    message: "Application checkout could not reach its database functions. Try again shortly.",
    status: 503,
  },
  TRANSACTION_STORE_UNAVAILABLE: {
    publicCode: "TRANSACTION_STORE_UNAVAILABLE",
    message: "Ticket inventory could not be reserved. No payment authorisation was created.",
    status: 503,
  },
  CHECKOUT_SESSION_RETRIEVAL_FAILED: {
    publicCode: "CHECKOUT_SESSION_RETRIEVAL_FAILED",
    message: "The existing Stripe checkout could not be reopened safely. Try again shortly.",
    status: 503,
  },
  CHECKOUT_SESSION_CREATION_FAILED: {
    publicCode: "STRIPE_CHECKOUT_SESSION_FAILED",
    message: "Stripe could not start the card authorisation. No charge was created.",
    status: 503,
  },
  CHECKOUT_SESSION_LINK_FAILED: {
    publicCode: "CHECKOUT_SESSION_LINK_FAILED",
    message: "The Stripe checkout could not be linked safely. Any temporary session was cancelled.",
    status: 503,
  },
  CHECKOUT_CREATION_RELEASE_FAILED: {
    publicCode: "CHECKOUT_RECOVERY_REQUIRED",
    message: "Checkout could not start and its reservation needs automatic recovery. Do not retry repeatedly.",
    status: 503,
  },
  CHECKOUT_MODE_MISMATCH: {
    publicCode: "CHECKOUT_MODE_MISMATCH",
    message: "Live checkout configuration is incomplete. No payment authorisation was created.",
    status: 503,
  },
  STRIPE_CONFIGURATION_INVALID: {
    publicCode: "STRIPE_CONFIGURATION_INVALID",
    message: "Stripe checkout is not configured correctly. No payment authorisation was created.",
    status: 503,
  },
};

export function createCorrelationId() {
  return randomUUID();
}

function jsonError(
  error: string,
  code: string,
  correlationId: string,
  status: number,
  headers: Record<string, string> = {},
) {
  return NextResponse.json(
    { error, code, correlationId },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Correlation-ID": correlationId,
        ...headers,
      },
    },
  );
}

function internalErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return "";
  if ("code" in error && typeof error.code === "string" && error.code.length <= 160) {
    return error.code;
  }
  if (error instanceof Error && error.message.length <= 160) return error.message;
  return "";
}

export function apiError(error: unknown, fallbackStatus = 400, suppliedCorrelationId?: string) {
  const correlationId = suppliedCorrelationId || createCorrelationId();
  if (error instanceof PublicApiError) {
    return jsonError(error.message, error.code, correlationId, error.status, error.headers);
  }
  if (error instanceof z.ZodError) {
    return jsonError(error.issues[0]?.message || "Invalid request.", "INVALID_REQUEST", correlationId, 422);
  }
  if (error instanceof Error && error.name === "PromoPolicyError" && "code" in error) {
    const code = String((error as Error & { code: string }).code);
    return jsonError(error.message, code, correlationId, 422);
  }
  if (error instanceof Error && error.name === "MediaSecurityError" && "code" in error && "status" in error) {
    const mediaError = error as Error & { code: string; status: number };
    return jsonError(mediaError.message, mediaError.code, correlationId, mediaError.status);
  }

  const internalCode = internalErrorCode(error);
  if (internalCode === "AUTH_REQUIRED") return jsonError("Please log in.", internalCode, correlationId, 401);
  if (internalCode === "FORBIDDEN") return jsonError("You do not have permission for this action.", internalCode, correlationId, 403);
  if (internalCode === "CMS_STALE_VERSION") {
    return jsonError(
      "A newer site version was saved. Reload the latest version before trying again.",
      internalCode,
      correlationId,
      409,
    );
  }

  const known = KNOWN_OPERATIONAL_ERRORS[internalCode];
  if (known) {
    console.error("API request failed with a known operational error.", {
      correlationId,
      code: known.publicCode,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return jsonError(known.message, known.publicCode, correlationId, known.status);
  }

  console.error("API request failed.", {
    correlationId,
    code: "REQUEST_FAILED",
    diagnosticCode: /^[A-Z0-9_]+$/.test(internalCode) ? internalCode : "UNCLASSIFIED",
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  return jsonError("The request could not be completed.", "REQUEST_FAILED", correlationId, fallbackStatus);
}

export function noStoreJson(data: unknown, status = 200, suppliedCorrelationId?: string) {
  const correlationId = suppliedCorrelationId || createCorrelationId();
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store", "X-Correlation-ID": correlationId },
  });
}

export async function parseJsonRequest<T>(request: Request, schema: z.ZodType<T>, maxBytes: number): Promise<T> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new PublicApiError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.", 415);
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PublicApiError("REQUEST_TOO_LARGE", "The request body is too large.", 413);
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (request.body) {
    const reader = request.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PublicApiError("REQUEST_TOO_LARGE", "The request body is too large.", 413);
      }
      chunks.push(value);
    }
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(combined);
    parsed = JSON.parse(raw);
  } catch {
    throw new PublicApiError("INVALID_JSON", "The request body must contain valid JSON.", 400);
  }
  return schema.parse(parsed);
}

export function assertRequestOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const host = process.env.VERCEL === "1"
    ? request.headers.get("x-forwarded-host") || request.headers.get("host")
    : request.headers.get("host");
  if (!host || new URL(origin).host !== host) {
    throw new PublicApiError("INVALID_ORIGIN", "Request origin was rejected.", 403);
  }
}
