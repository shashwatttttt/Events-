import "server-only";

import { PublicApiError } from "@/lib/http";
import {
  postCheckoutAuthorisationBlockers,
  postCheckoutAuthorisationHealthy,
  postCheckoutMonitoringOnlyBlockers,
  readPostCheckoutOperationsHealth,
} from "@/lib/post-approval/health";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

// Keep this version in lockstep with the fully deployed production schema.
// A mismatch pauses new authorisations before Stripe is called.
export const REQUIRED_POST_CHECKOUT_SCHEMA_VERSION = 45;
export const REQUIRED_GUESTLIST_APPLICATION_SCHEMA_VERSION = 39;

type HealthRow = {
  schema_version?: unknown;
  ready?: unknown;
  details?: unknown;
};

export async function assertPostCheckoutSchemaReady() {
  const { data, error } = await createSupabaseAdminClient()
    .rpc("skie_post_checkout_schema_health");

  const row = (Array.isArray(data) ? data[0] : data) as HealthRow | null;
  const schemaVersion = Number(row?.schema_version || 0);
  const ready = row?.ready === true;

  if (error || !row || !ready || schemaVersion < REQUIRED_POST_CHECKOUT_SCHEMA_VERSION) {
    console.error("Post-checkout production schema is not ready.", {
      code: "POST_APPROVAL_SCHEMA_NOT_READY",
      schemaVersion,
      requiredSchemaVersion: REQUIRED_POST_CHECKOUT_SCHEMA_VERSION,
      details: row?.details && typeof row.details === "object" ? row.details : undefined,
    });
    throw new PublicApiError(
      "POST_APPROVAL_SCHEMA_NOT_READY",
      "Application checkout is temporarily paused while a database update completes. No payment authorisation was created.",
      503,
    );
  }

  return { schemaVersion };
}

export async function assertGuestlistApprovalSchemaReady() {
  const { data, error } = await createSupabaseAdminClient()
    .rpc("skie_guestlist_application_schema_health");
  const row = (Array.isArray(data) ? data[0] : data) as HealthRow | null;
  const schemaVersion = Number(row?.schema_version || 0);
  const ready = row?.ready === true;

  if (error || !row || !ready || schemaVersion < REQUIRED_GUESTLIST_APPLICATION_SCHEMA_VERSION) {
    console.error("Guest-list application schema is not ready.", {
      code: "GUESTLIST_APPLICATION_SCHEMA_NOT_READY",
      schemaVersion,
      requiredSchemaVersion: REQUIRED_GUESTLIST_APPLICATION_SCHEMA_VERSION,
      details: row?.details && typeof row.details === "object" ? row.details : undefined,
    });
    throw new PublicApiError(
      "GUESTLIST_APPLICATION_SCHEMA_NOT_READY",
      "Guest-list applications are temporarily paused while a database update completes. No payment or ticket was created.",
      503,
    );
  }
  return { schemaVersion };
}

async function readAuthorisationHealthBestEffort() {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await readPostCheckoutOperationsHealth();
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise<void>((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
  }
  console.error("Post-checkout operations health could not be read after retries.", {
    code: "POST_APPROVAL_OPERATIONS_HEALTH_UNAVAILABLE",
    errorCode: lastError instanceof Error && /^[A-Z0-9_]{3,120}$/.test(lastError.message)
      ? lastError.message
      : "OPERATIONS_HEALTH_UNAVAILABLE",
  });
  return null;
}

export async function assertPostCheckoutOperationsReady() {
  const health = await readAuthorisationHealthBestEffort();

  // A temporary monitoring/read failure must not take manual-authorisation
  // checkout offline. Database schema readiness still fails closed, while
  // capture and fulfilment retain their durable idempotency protections.
  if (!health) return null;

  const blockers = postCheckoutAuthorisationBlockers(health);
  const monitoringOnlyBlockers = postCheckoutMonitoringOnlyBlockers(health);

  if (!postCheckoutAuthorisationHealthy(health)) {
    console.error("Post-checkout payment authorisation is not ready.", {
      code: "POST_APPROVAL_AUTOMATION_NOT_READY",
      blockers,
      monitoringOnlyBlockers,
      health: {
        paymentActionsRequiringReview: health.paymentActionsRequiringReview,
        stalledPaymentActions: health.stalledPaymentActions,
        paymentRecoveriesRequiringReview: health.paymentRecoveriesRequiringReview,
        orphanStripeSessions: health.orphanStripeSessions,
        webhooksRequiringReview: health.webhooksRequiringReview,
        staleTemporaryWebhooks: health.staleTemporaryWebhooks,
        notificationProviderConfigurationHealthy: health.notificationProviderConfigurationHealthy,
        workerHeartbeatHealthy: health.workerHeartbeatHealthy,
        failedNotifications: health.failedNotifications,
        stalledNotifications: health.stalledNotifications,
        overduePostCheckoutLifecycle: health.overduePostCheckoutLifecycle,
      },
    });
    throw new PublicApiError(
      "POST_APPROVAL_AUTOMATION_NOT_READY",
      "Application checkout is temporarily paused while payment operations recover. No payment authorisation was created.",
      503,
    );
  }

  if (monitoringOnlyBlockers.length > 0) {
    console.warn("Post-checkout monitoring has isolated background incidents.", {
      code: "POST_APPROVAL_MONITORING_DEGRADED",
      monitoringOnlyBlockers,
    });
  }

  return health;
}
