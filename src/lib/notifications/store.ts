import "server-only";

import { config } from "@/lib/config";
import { mutateOperationsData, readOperationsData } from "@/lib/data/documents";
import { PublicApiError } from "@/lib/http";
import { randomId, sha256 } from "@/lib/security/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { normalizePhoneToE164, redactPhone } from "@/lib/phone";
import type { ClaimedNotification, NotificationProviderResult, NotificationTemplateKey } from "@/lib/notifications/types";
import type { EventNotificationControl, NotificationAttempt, NotificationChannel, NotificationChannelControl, NotificationOutboxItem, NotificationPayload, SessionUser } from "@/types/site";

function mapOutbox(row: Record<string, unknown>): NotificationOutboxItem {
  return {
    id: String(row.id),
    channel: String(row.channel) as NotificationChannel,
    templateKey: String(row.template_key),
    recipientUserId: row.recipient_user_id ? String(row.recipient_user_id) : undefined,
    recipientAddress: String(row.recipient_address),
    eventId: row.event_id ? String(row.event_id) : undefined,
    orderId: row.order_id ? String(row.order_id) : undefined,
    payload: (row.payload || {}) as NotificationPayload,
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as NotificationOutboxItem["status"],
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    availableAt: String(row.available_at),
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
    leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
    providerMessageId: row.provider_message_id ? String(row.provider_message_id) : undefined,
    safeErrorCode: row.safe_error_code ? String(row.safe_error_code) : undefined,
    correlationId: String(row.correlation_id),
    sentAt: row.sent_at ? String(row.sent_at) : undefined,
    deliveredAt: row.delivered_at ? String(row.delivered_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapAttempt(row: Record<string, unknown>): NotificationAttempt {
  return {
    id: String(row.id),
    outboxId: String(row.outbox_id),
    attemptNumber: Number(row.attempt_number),
    status: String(row.status) as NotificationAttempt["status"],
    providerMessageId: row.provider_message_id ? String(row.provider_message_id) : undefined,
    safeErrorCode: row.safe_error_code ? String(row.safe_error_code) : undefined,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : undefined,
  };
}

export type EnqueueNotificationInput = {
  channel: NotificationChannel;
  templateKey: NotificationTemplateKey;
  recipientAddress: string;
  recipientUserId?: string;
  eventId?: string;
  orderId?: string;
  payload?: NotificationPayload;
  idempotencyKey: string;
  maxAttempts?: number;
};

function normalizeRecipient(channel: NotificationChannel, value: string) {
  if (channel === "email") {
    const recipient = value.trim().toLowerCase();
    if (!recipient || recipient.length > 254 || !recipient.includes("@")) throw new PublicApiError("INVALID_NOTIFICATION_RECIPIENT", "A valid email recipient is required.", 422);
    return recipient;
  }
  if (channel === "sms" || channel === "whatsapp") {
    try { return normalizePhoneToE164(value, config.notificationDefaultCountry); }
    catch { throw new PublicApiError("INVALID_NOTIFICATION_RECIPIENT", "A valid international phone recipient is required.", 422); }
  }
  const recipient = value.trim();
  if (!recipient || recipient.length > 100) throw new PublicApiError("INVALID_NOTIFICATION_RECIPIENT", "A valid in-app recipient is required.", 422);
  return recipient;
}

export async function enqueueNotification(input: EnqueueNotificationInput) {
  const recipient = normalizeRecipient(input.channel, input.recipientAddress);
  if (config.dataProvider === "supabase") {
    const { data, error } = await createSupabaseAdminClient().rpc("skie_enqueue_notification", {
      p_channel: input.channel,
      p_template_key: input.templateKey,
      p_recipient_user_id: input.recipientUserId || null,
      p_recipient_address: recipient,
      p_recipient_hash: sha256(recipient),
      p_event_id: input.eventId || null,
      p_order_id: input.orderId || null,
      p_payload: input.payload || {},
      p_idempotency_key: input.idempotencyKey,
      p_max_attempts: input.maxAttempts || 5,
    });
    if (error || !data) throw new PublicApiError("NOTIFICATION_ENQUEUE_FAILED", "The notification could not be queued.", 503);
    const row = Array.isArray(data) ? data[0] : data;
    return { item: mapOutbox(row.item as Record<string, unknown>), duplicate: !Boolean(row.inserted) };
  }
  return mutateOperationsData((operations) => {
    const existing = operations.notificationOutbox.find((item) => item.idempotencyKey === input.idempotencyKey);
    if (existing) return { item: existing, duplicate: true };
    const now = new Date().toISOString();
    const item: NotificationOutboxItem = {
      id: randomId("notification"), channel: input.channel, templateKey: input.templateKey,
      recipientUserId: input.recipientUserId, recipientAddress: recipient,
      eventId: input.eventId, orderId: input.orderId, payload: input.payload || {},
      idempotencyKey: input.idempotencyKey, status: "queued", attemptCount: 0,
      maxAttempts: input.maxAttempts || 5, availableAt: now, correlationId: randomId("corr"),
      createdAt: now, updatedAt: now,
    };
    operations.notificationOutbox.push(item);
    return { item, duplicate: false };
  });
}

export type EnqueueEmailInput = Omit<EnqueueNotificationInput, "channel">;
export const enqueueEmail = (input: EnqueueEmailInput) => enqueueNotification({ ...input, channel: "email" });

export async function claimNotifications(workerId: string, batchSize: number, leaseSeconds = 60, channel: NotificationChannel = "email"): Promise<ClaimedNotification[]> {
  const safeBatch = Math.max(1, Math.min(batchSize, 25));
  if (config.dataProvider === "supabase") {
    const { data, error } = await createSupabaseAdminClient().rpc("skie_claim_notification_batch", {
      p_channel: channel, p_worker_id: workerId, p_batch_size: safeBatch, p_lease_seconds: leaseSeconds,
    });
    if (error) throw new PublicApiError("NOTIFICATION_CLAIM_FAILED", "Notifications are temporarily unavailable.", 503);
    return (data || []).map((row: Record<string, unknown>) => mapOutbox(row));
  }
  return mutateOperationsData((operations) => {
    const now = new Date();
    for (const item of operations.notificationOutbox) {
      if (["claimed", "processing"].includes(item.status) && item.leaseExpiresAt && new Date(item.leaseExpiresAt) <= now) {
        item.status = "retry";
        item.safeErrorCode = "NOTIFICATION_CLAIM_TIMEOUT";
        item.leaseExpiresAt = undefined;
        item.leaseOwner = undefined;
        item.availableAt = now.toISOString();
        item.updatedAt = now.toISOString();
      }
    }
    const claimed = operations.notificationOutbox
      .filter((item) => item.channel === channel && ["queued", "retry", "temporary_failure"].includes(item.status)
        && new Date(item.availableAt) <= now && item.attemptCount < item.maxAttempts)
      .sort((a, b) => a.availableAt.localeCompare(b.availableAt) || a.id.localeCompare(b.id))
      .slice(0, safeBatch);
    for (const item of claimed) {
      item.status = "processing";
      item.attemptCount += 1;
      item.leaseOwner = workerId;
      item.leaseExpiresAt = new Date(now.getTime() + Math.max(10, Math.min(leaseSeconds, 300)) * 1000).toISOString();
      item.updatedAt = now.toISOString();
      operations.notificationAttempts.push({
        id: randomId("notification_attempt"), outboxId: item.id, attemptNumber: item.attemptCount,
        status: "processing", startedAt: now.toISOString(),
      });
    }
    return claimed.map((item) => structuredClone(item));
  });
}

export async function finishNotification(item: ClaimedNotification, workerId: string, result: NotificationProviderResult) {
  const retryDelay = Math.min(3600, 30 * (2 ** Math.max(0, item.attemptCount - 1)));
  if (config.dataProvider === "supabase") {
    const { error } = await createSupabaseAdminClient().rpc("skie_finish_notification", {
      p_outbox_id: item.id,
      p_worker_id: workerId,
      p_result: result.status,
      p_provider_message_id: "providerMessageId" in result ? result.providerMessageId || null : null,
      p_safe_error_code: "safeErrorCode" in result ? result.safeErrorCode : null,
      p_retry_delay_seconds: retryDelay,
    });
    if (error) throw new PublicApiError("NOTIFICATION_RESULT_FAILED", "The notification result could not be recorded.", 503);
    return;
  }
  await mutateOperationsData((operations) => {
    const target = operations.notificationOutbox.find((candidate) => candidate.id === item.id);
    if (!target || !["claimed", "processing"].includes(target.status) || target.leaseOwner !== workerId) {
      throw new PublicApiError("NOTIFICATION_LEASE_LOST", "The notification claim has expired.", 409);
    }
    const attempt = operations.notificationAttempts.find((candidate) => candidate.outboxId === item.id && candidate.attemptNumber === target.attemptCount);
    const now = new Date();
    const providerId = "providerMessageId" in result ? result.providerMessageId : undefined;
    const safeCode = "safeErrorCode" in result ? result.safeErrorCode : undefined;
    const terminalFailure = result.status === "permanent_failure" || target.attemptCount >= target.maxAttempts;
    target.status = result.status === "dry_run" ? "dry_run"
      : result.status === "delivered" ? "delivered"
      : result.status === "accepted" || result.status === "sent" ? "sent"
      : terminalFailure ? "failed" : "retry";
    target.providerMessageId = providerId;
    target.safeErrorCode = safeCode;
    target.sentAt = ["accepted", "sent", "delivered", "dry_run"].includes(result.status) ? now.toISOString() : target.sentAt;
    target.deliveredAt = result.status === "delivered" ? now.toISOString() : target.deliveredAt;
    target.availableAt = result.status === "temporary_failure" && !terminalFailure
      ? new Date(now.getTime() + retryDelay * 1000).toISOString() : target.availableAt;
    target.leaseExpiresAt = undefined;
    target.leaseOwner = undefined;
    target.updatedAt = now.toISOString();
    if (attempt) {
      attempt.status = result.status === "permanent_failure" ? "permanent_failure" : result.status;
      attempt.providerMessageId = providerId;
      attempt.safeErrorCode = safeCode;
      attempt.finishedAt = now.toISOString();
    }
  });
}

export function redactRecipient(address: string) {
  if (address.startsWith("+")) return redactPhone(address);
  const [local, domain] = address.split("@");
  if (!domain) return "redacted";
  return `${local.slice(0, 1)}***@${domain}`;
}

export async function listNotifications(filters: { eventId?: string; orderId?: string; status?: string; customer?: string; channel?: NotificationChannel } = {}) {
  if (config.dataProvider === "supabase") {
    let query = createSupabaseAdminClient().from("notification_outbox").select("*").order("created_at", { ascending: false }).limit(250);
    if (filters.channel) query = query.eq("channel", filters.channel);
    if (filters.eventId) query = query.eq("event_id", filters.eventId);
    if (filters.orderId) query = query.eq("order_id", filters.orderId);
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.customer) query = query.eq("recipient_user_id", filters.customer);
    const { data, error } = await query;
    if (error) throw new PublicApiError("NOTIFICATION_LIST_FAILED", "Notification history is temporarily unavailable.", 503);
    const ids = (data || []).map((row) => row.id);
    const attemptsResult = ids.length
      ? await createSupabaseAdminClient().from("notification_attempts").select("*").in("outbox_id", ids).order("attempt_number")
      : { data: [], error: null };
    if (attemptsResult.error) throw new PublicApiError("NOTIFICATION_LIST_FAILED", "Notification history is temporarily unavailable.", 503);
    return {
      items: (data || []).map((row) => ({ ...mapOutbox(row), recipientAddress: redactRecipient(String(row.recipient_address)) })),
      attempts: (attemptsResult.data || []).map((row) => mapAttempt(row)),
    };
  }
  const operations = await readOperationsData();
  const items = operations.notificationOutbox.filter((item) => (!filters.channel || item.channel === filters.channel)
    && (!filters.eventId || item.eventId === filters.eventId)
    && (!filters.orderId || item.orderId === filters.orderId)
    && (!filters.status || item.status === filters.status)
    && (!filters.customer || item.recipientUserId === filters.customer));
  return {
    items: items.slice(-250).reverse().map((item) => ({ ...item, recipientAddress: redactRecipient(item.recipientAddress) })),
    attempts: operations.notificationAttempts.filter((attempt) => items.some((item) => item.id === attempt.outboxId)),
  };
}

export async function manageNotification(actor: SessionUser, id: string, action: "retry" | "cancel") {
  if (config.dataProvider === "supabase") {
    const { data, error } = await createSupabaseAdminClient().rpc("skie_manage_notification", {
      p_outbox_id: id, p_action: action, p_actor_id: actor.id,
    });
    if (error || !data) throw new PublicApiError("NOTIFICATION_ACTION_REJECTED", "The notification could not be changed.", 409);
    return mapOutbox((Array.isArray(data) ? data[0] : data) as Record<string, unknown>);
  }
  return mutateOperationsData((operations) => {
    const item = operations.notificationOutbox.find((candidate) => candidate.id === id);
    if (!item) throw new PublicApiError("NOTIFICATION_NOT_FOUND", "Notification was not found.", 404);
    if (action === "cancel") {
      if (!["queued", "retry", "temporary_failure"].includes(item.status)) throw new PublicApiError("NOTIFICATION_NOT_CANCELLABLE", "Only pending notifications can be cancelled.", 409);
      item.status = "cancelled";
    } else {
      if (!["retry", "temporary_failure", "failed"].includes(item.status)) throw new PublicApiError("NOTIFICATION_NOT_RETRYABLE", "This notification is not eligible for retry.", 409);
      item.status = "queued";
      item.maxAttempts = Math.min(20, Math.max(item.maxAttempts, item.attemptCount + 1));
      item.availableAt = new Date().toISOString();
      item.safeErrorCode = undefined;
    }
    item.updatedAt = new Date().toISOString();
    operations.auditLogs.push({
      id: randomId("audit"), actorId: actor.id, actorEmail: actor.email,
      action: `notification.${action}`, entityType: "notification", entityId: item.id,
      metadata: { orderId: item.orderId || null, eventId: item.eventId || null }, createdAt: item.updatedAt,
    });
    return item;
  });
}

const defaultChannels: NotificationChannelControl[] = [
  { channel: "email", enabled: true, updatedAt: new Date(0).toISOString() },
  { channel: "sms", enabled: false, updatedAt: new Date(0).toISOString() },
  { channel: "in_app", enabled: true, updatedAt: new Date(0).toISOString() },
  { channel: "whatsapp", enabled: false, updatedAt: new Date(0).toISOString() },
];

export async function getNotificationSettings(userId: string, eventId?: string) {
  if (config.dataProvider === "supabase") {
    const client = createSupabaseAdminClient();
    const [preferences, consents, globalControls, eventControls] = await Promise.all([
      client.from("notification_preferences").select("*").eq("user_id", userId),
      client.from("notification_consents").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
      client.from("notification_channel_controls").select("*"),
      eventId ? client.from("event_notification_controls").select("*").eq("event_id", eventId) : Promise.resolve({ data: [], error: null }),
    ]);
    if (preferences.error || consents.error || globalControls.error || eventControls.error) throw new PublicApiError("NOTIFICATION_SETTINGS_UNAVAILABLE", "Notification settings are temporarily unavailable.", 503);
    return {
      preferences: (preferences.data || []).map((row) => ({ userId: String(row.user_id), channel: row.channel as NotificationChannel, enabled: Boolean(row.enabled), createdAt: String(row.created_at), updatedAt: String(row.updated_at) })),
      consents: (consents.data || []).map((row) => ({ id: String(row.id), userId: String(row.user_id), channel: row.channel as "sms" | "whatsapp", consentType: "transactional" as const, accepted: Boolean(row.accepted), textShown: String(row.text_shown), policyVersion: String(row.policy_version), ipHash: row.ip_hash || undefined, userAgent: row.user_agent || undefined, createdAt: String(row.created_at) })),
      globalControls: (globalControls.data || []).map((row) => ({ channel: row.channel as NotificationChannel, enabled: Boolean(row.enabled), updatedBy: row.updated_by || undefined, updatedAt: String(row.updated_at) })),
      eventControls: (eventControls.data || []).map((row) => ({ eventId: String(row.event_id), channel: row.channel as NotificationChannel, enabled: Boolean(row.enabled), updatedBy: row.updated_by || undefined, updatedAt: String(row.updated_at) })),
    };
  }
  const operations = await readOperationsData();
  return {
    preferences: operations.notificationPreferences.filter((item) => item.userId === userId),
    consents: operations.notificationConsents.filter((item) => item.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    globalControls: operations.notificationChannelControls.length ? operations.notificationChannelControls : defaultChannels,
    eventControls: eventId ? operations.eventNotificationControls.filter((item) => item.eventId === eventId) : [],
  };
}

export async function setNotificationPreferences(userId: string, values: Partial<Record<NotificationChannel, boolean>>, consent?: { smsAccepted: boolean; textShown: string; policyVersion: string; ipHash?: string; userAgent?: string }) {
  const now = new Date().toISOString();
  if (config.dataProvider === "supabase") {
    const client = createSupabaseAdminClient();
    const rows = Object.entries(values).map(([channel, enabled]) => ({ user_id: userId, channel, enabled: Boolean(enabled), updated_at: now }));
    if (rows.length) {
      const { error } = await client.from("notification_preferences").upsert(rows, { onConflict: "user_id,channel" });
      if (error) throw new PublicApiError("NOTIFICATION_PREFERENCES_FAILED", "Notification preferences could not be saved.", 503);
    }
    if (consent) {
      const { error } = await client.from("notification_consents").insert({ user_id: userId, channel: "sms", consent_type: "transactional", accepted: consent.smsAccepted, text_shown: consent.textShown, policy_version: consent.policyVersion, ip_hash: consent.ipHash || null, user_agent: consent.userAgent?.slice(0, 500) || null });
      if (error) throw new PublicApiError("NOTIFICATION_CONSENT_FAILED", "SMS consent could not be saved.", 503);
    }
  } else {
    await mutateOperationsData((operations) => {
      for (const [channel, enabled] of Object.entries(values) as Array<[NotificationChannel, boolean]>) {
        const current = operations.notificationPreferences.find((item) => item.userId === userId && item.channel === channel);
        if (current) Object.assign(current, { enabled, updatedAt: now });
        else operations.notificationPreferences.push({ userId, channel, enabled, createdAt: now, updatedAt: now });
      }
      if (consent) operations.notificationConsents.push({ id: randomId("notification_consent"), userId, channel: "sms", consentType: "transactional", accepted: consent.smsAccepted, textShown: consent.textShown, policyVersion: consent.policyVersion, ipHash: consent.ipHash, userAgent: consent.userAgent?.slice(0, 500), createdAt: now });
    });
  }
  return getNotificationSettings(userId);
}

export async function setNotificationControl(actor: SessionUser, channel: NotificationChannel, enabled: boolean, eventId?: string) {
  const now = new Date().toISOString();
  if (config.dataProvider === "supabase") {
    const { data, error } = await createSupabaseAdminClient().rpc("skie_set_notification_control", { p_actor_id: actor.id, p_channel: channel, p_enabled: enabled, p_event_id: eventId || null });
    if (error || !data) throw new PublicApiError("NOTIFICATION_CONTROL_FAILED", "Notification controls could not be saved.", 409);
    return data;
  }
  return mutateOperationsData((operations) => {
    const list = eventId ? operations.eventNotificationControls : operations.notificationChannelControls;
    const current = list.find((item) => item.channel === channel && (!("eventId" in item) || item.eventId === eventId));
    if (current) Object.assign(current, { enabled, updatedBy: actor.id, updatedAt: now });
    else if (eventId) (list as EventNotificationControl[]).push({ eventId, channel, enabled, updatedBy: actor.id, updatedAt: now });
    else (list as NotificationChannelControl[]).push({ channel, enabled, updatedBy: actor.id, updatedAt: now });
    operations.auditLogs.push({ id: randomId("audit"), actorId: actor.id, actorEmail: actor.email, action: "notification.control_updated", entityType: eventId ? "event" : "notification_channel", entityId: eventId || channel, metadata: { channel, enabled }, createdAt: now });
    return { channel, enabled, eventId: eventId || null };
  });
}

export async function auditNotificationAdminAction(actor: SessionUser, outboxIds: string[], action: "ticket_resend" | "test_send" | "manual_message") {
  if (!outboxIds.length) return 0;
  if (config.dataProvider === "supabase") {
    const { data, error } = await createSupabaseAdminClient().rpc("skie_record_notification_admin_action", { p_actor_id: actor.id, p_outbox_ids: outboxIds, p_action: action });
    if (error) throw new PublicApiError("NOTIFICATION_AUDIT_FAILED", "The notification audit could not be recorded.", 503);
    return Number(data || 0);
  }
  return mutateOperationsData((operations) => {
    const validIds = outboxIds.filter((id) => operations.notificationOutbox.some((item) => item.id === id));
    const now = new Date().toISOString();
    for (const id of validIds) operations.auditLogs.push({ id: randomId("audit"), actorId: actor.id, actorEmail: actor.email, action: `notification.${action}`, entityType: "notification", entityId: id, metadata: {}, createdAt: now });
    return validIds.length;
  });
}

export async function recordProviderCallback(input: { provider: "twilio" | "resend"; providerEventId: string; providerMessageId: string; providerStatus: string; mappedStatus: "sent" | "delivered" | "failed" }) {
  if (config.dataProvider === "supabase") {
    const { data, error } = await createSupabaseAdminClient().rpc("skie_record_notification_callback", {
      p_provider: input.provider, p_provider_event_id: input.providerEventId, p_provider_message_id: input.providerMessageId,
      p_provider_status: input.providerStatus, p_mapped_status: input.mappedStatus,
    });
    if (error) throw new PublicApiError("NOTIFICATION_CALLBACK_FAILED", "The delivery update could not be recorded.", 503);
    return data;
  }
  return mutateOperationsData((operations) => {
    const item = operations.notificationOutbox.find((candidate) => candidate.providerMessageId === input.providerMessageId);
    if (!item) return { matched: false, duplicate: false };
    if (item.payload.variables?.provider_event_id === input.providerEventId) return { matched: true, duplicate: true };
    item.status = input.mappedStatus;
    item.updatedAt = new Date().toISOString();
    if (input.mappedStatus === "delivered") item.deliveredAt = item.updatedAt;
    if (input.mappedStatus === "failed") item.safeErrorCode = input.provider === "twilio" ? "SMS_PROVIDER_DELIVERY_FAILED" : "EMAIL_PROVIDER_DELIVERY_FAILED";
    item.payload.variables = { ...item.payload.variables, provider_event_id: input.providerEventId, provider_status: input.providerStatus };
    return { matched: true, duplicate: false };
  });
}

export async function listInAppNotifications(userId: string) {
  const result = await listNotifications({ customer: userId, channel: "in_app" });
  return result.items.filter((item) => !["cancelled", "failed"].includes(item.status));
}

export async function getNotification(id: string) {
  if (config.dataProvider === "supabase") {
    const { data, error } = await createSupabaseAdminClient().from("notification_outbox").select("*").eq("id", id).maybeSingle();
    if (error || !data) return null;
    return mapOutbox(data);
  }
  return (await readOperationsData()).notificationOutbox.find((item) => item.id === id) || null;
}
