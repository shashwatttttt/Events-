import "server-only";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertLiveDataProvider, config } from "@/lib/config";
import { normalizeSiteData } from "@/lib/site-content";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { OperationsData, SiteData } from "@/types/site";

type DocumentKey = "site" | "operations";
type DocMap = { site: SiteData; operations: OperationsData };
type DocumentMetadata = { version: number | null; updatedAt: string | null };
export type DocumentVersion = string;
export type DocumentSnapshot<T> = { value: T; version: DocumentVersion; updatedAt: string | null };
export class StaleDocumentVersionError extends Error {
  constructor() {
    super("CMS_STALE_VERSION");
    this.name = "StaleDocumentVersionError";
  }
}
export type PersistenceMetadata = {
  site: DocumentMetadata;
  operations: DocumentMetadata;
};
const localFiles: Record<DocumentKey, string> = {
  site: path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "site.json"),
  operations: path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "operations.json")
};

type QueueState = { queue: Promise<void> };
const globalQueue = globalThis as typeof globalThis & { __skieDocumentQueue?: QueueState };
const queueState = globalQueue.__skieDocumentQueue ?? { queue: Promise.resolve() };
globalQueue.__skieDocumentQueue = queueState;

function assertDataProviderReady() {
  assertLiveDataProvider();
}

async function readLocal<K extends DocumentKey>(key: K): Promise<DocMap[K]> {
  const raw = await fs.readFile(/*turbopackIgnore: true*/ localFiles[key], "utf8");
  return JSON.parse(raw) as DocMap[K];
}

function localVersion(raw: string) {
  return `local:${createHash("sha256").update(raw).digest("hex")}`;
}

async function readLocalSnapshot<K extends DocumentKey>(key: K): Promise<DocumentSnapshot<DocMap[K]>> {
  const raw = await fs.readFile(/*turbopackIgnore: true*/ localFiles[key], "utf8");
  const stats = await fs.stat(/*turbopackIgnore: true*/ localFiles[key]);
  return { value: JSON.parse(raw) as DocMap[K], version: localVersion(raw), updatedAt: stats.mtime.toISOString() };
}

async function writeLocal<K extends DocumentKey>(key: K, value: DocMap[K]) {
  const target = localFiles[key];
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(/*turbopackIgnore: true*/ temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(/*turbopackIgnore: true*/ temp, target);
}

async function readSupabase<K extends DocumentKey>(key: K): Promise<DocMap[K]> {
  const client = createSupabaseAdminClient();
  const { data, error } = await client.from("platform_documents").select("payload").eq("key", key).single();
  if (error) throw new Error(`Could not read Supabase document ${key}: ${error.message}`);
  return data.payload as DocMap[K];
}

async function writeSupabase<K extends DocumentKey>(key: K, value: DocMap[K]) {
  const client = createSupabaseAdminClient();
  const { error } = await client.from("platform_documents").upsert({ key, payload: value, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Could not write Supabase document ${key}: ${error.message}`);
}

export async function readDocument<K extends DocumentKey>(key: K): Promise<DocMap[K]> {
  assertDataProviderReady();
  return config.dataProvider === "supabase" ? readSupabase(key) : readLocal(key);
}

export async function readDocumentSnapshot<K extends DocumentKey>(key: K): Promise<DocumentSnapshot<DocMap[K]>> {
  assertDataProviderReady();
  return config.dataProvider === "supabase" ? readSupabaseSnapshot(key) : readLocalSnapshot(key);
}

export async function replaceDocument<K extends DocumentKey>(
  key: K,
  value: DocMap[K],
  expectedVersion: DocumentVersion,
): Promise<DocumentSnapshot<DocMap[K]>> {
  assertDataProviderReady();
  if (config.dataProvider === "supabase") {
    const match = /^supabase:(\d+)$/.exec(expectedVersion);
    if (!match) throw new StaleDocumentVersionError();
    const currentVersion = Number(match[1]);
    const updatedAt = new Date().toISOString();
    const { data, error } = await createSupabaseAdminClient().from("platform_documents")
      .update({ payload: value, version: currentVersion + 1, updated_at: updatedAt })
      .eq("key", key)
      .eq("version", currentVersion)
      .select("payload,version,updated_at")
      .maybeSingle();
    if (error) throw new Error(`Could not write Supabase document ${key}: ${error.message}`);
    if (!data) throw new StaleDocumentVersionError();
    return {
      value: data.payload as DocMap[K],
      version: `supabase:${Number(data.version)}`,
      updatedAt: typeof data.updated_at === "string" ? data.updated_at : updatedAt,
    };
  }

  let resolveOuter!: (value: DocumentSnapshot<DocMap[K]> | PromiseLike<DocumentSnapshot<DocMap[K]>>) => void;
  let rejectOuter!: (reason?: unknown) => void;
  const result = new Promise<DocumentSnapshot<DocMap[K]>>((resolve, reject) => { resolveOuter = resolve; rejectOuter = reject; });
  queueState.queue = queueState.queue.then(async () => {
    try {
      const current = await readLocalSnapshot(key);
      if (current.version !== expectedVersion) throw new StaleDocumentVersionError();
      await writeLocal(key, value);
      resolveOuter(await readLocalSnapshot(key));
    } catch (error) {
      rejectOuter(error);
    }
  });
  return result;
}

async function readSupabaseSnapshot<K extends DocumentKey>(key: K): Promise<DocumentSnapshot<DocMap[K]>> {
  const client = createSupabaseAdminClient();
  const { data, error } = await client.from("platform_documents").select("payload,version,updated_at").eq("key", key).single();
  if (error) throw new Error(`Could not read Supabase document ${key}: ${error.message}`);
  return {
    value: data.payload as DocMap[K],
    version: `supabase:${Number(data.version)}`,
    updatedAt: typeof data.updated_at === "string" ? data.updated_at : null,
  };
}

export async function writeDocument<K extends DocumentKey>(key: K, value: DocMap[K]) {
  assertDataProviderReady();
  if (config.dataProvider === "supabase") return writeSupabase(key, value);
  return writeLocal(key, value);
}

export async function mutateDocument<K extends DocumentKey, T>(key: K, mutator: (current: DocMap[K]) => Promise<T> | T): Promise<T> {
  assertDataProviderReady();
  if (config.dataProvider === "supabase") {
    const client = createSupabaseAdminClient();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const { data, error } = await client.from("platform_documents").select("payload,version").eq("key", key).single();
      if (error) throw new Error(`Could not read Supabase document ${key}: ${error.message}`);
      const current = structuredClone(data.payload) as DocMap[K];
      const output = await mutator(current);
      const { data: updated, error: updateError } = await client
        .from("platform_documents")
        .update({ payload: current, version: Number(data.version) + 1, updated_at: new Date().toISOString() })
        .eq("key", key)
        .eq("version", data.version)
        .select("version");
      if (updateError) throw new Error(`Could not write Supabase document ${key}: ${updateError.message}`);
      if (updated?.length) return output;
    }
    throw new Error(`Concurrent update conflict for ${key}. Please try again.`);
  }
  let resolveOuter!: (value: T | PromiseLike<T>) => void;
  let rejectOuter!: (reason?: unknown) => void;
  const result = new Promise<T>((resolve, reject) => { resolveOuter = resolve; rejectOuter = reject; });
  queueState.queue = queueState.queue.then(async () => {
    try {
      const current = await readLocal(key);
      const output = await mutator(current);
      await writeLocal(key, current);
      resolveOuter(output);
    } catch (error) {
      rejectOuter(error);
    }
  });
  return result;
}

export async function readPersistenceMetadata(): Promise<PersistenceMetadata> {
  const empty: PersistenceMetadata = {
    site: { version: null, updatedAt: null },
    operations: { version: null, updatedAt: null },
  };
  if (config.dataProvider !== "supabase") return empty;

  const client = createSupabaseAdminClient();
  const { data, error } = await client
    .from("platform_documents")
    .select("key,version,updated_at")
    .in("key", ["site", "operations"]);
  if (error) throw new Error("Could not read persistence metadata.");

  for (const row of data || []) {
    const key = row.key as unknown;
    if (key !== "site" && key !== "operations") continue;
    empty[key] = {
      version: Number.isFinite(Number(row.version)) ? Number(row.version) : null,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    };
  }
  return empty;
}

export const readSiteData = async () => normalizeSiteData(await readDocument("site"));
export const readSiteDataSnapshot = async () => {
  const snapshot = await readDocumentSnapshot("site");
  return { ...snapshot, value: normalizeSiteData(snapshot.value) };
};
export const replaceSiteData = async (
  site: SiteData,
  expectedVersion: DocumentVersion,
  options?: { actorId?: string; correlationId?: string },
) => {
  if (config.dataProvider === "supabase") {
    const match = /^supabase:(\d+)$/.exec(expectedVersion);
    if (!match || !options?.actorId || !options.correlationId) throw new StaleDocumentVersionError();
    const { data, error } = await createSupabaseAdminClient().rpc("skie_replace_site_document", {
      p_expected_version: Number(match[1]),
      p_payload: normalizeSiteData(site),
      p_actor_id: options.actorId,
      p_correlation_id: options.correlationId,
    });
    if (error) {
      if (String(error.message || "").includes("CMS_STALE_VERSION")) throw new StaleDocumentVersionError();
      throw new Error("CMS_SAVE_UNAVAILABLE");
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("CMS_SAVE_UNAVAILABLE");
    return {
      value: normalizeSiteData(row.saved_payload as SiteData),
      version: `supabase:${Number(row.saved_version)}`,
      updatedAt: typeof row.saved_updated_at === "string" ? row.saved_updated_at : null,
      closedEventIds: Array.isArray(row.closed_event_ids) ? row.closed_event_ids.map(String) : [],
    };
  }
  const snapshot = await replaceDocument("site", normalizeSiteData(site), expectedVersion);
  return { ...snapshot, value: normalizeSiteData(snapshot.value), closedEventIds: [] as string[] };
};
function normalizeOperationsData(operations: OperationsData): OperationsData {
  return {
    ...operations,
    reservations: Array.isArray(operations.reservations) ? operations.reservations : [],
    checkoutAttempts: Array.isArray(operations.checkoutAttempts) ? operations.checkoutAttempts : [],
    stripeWebhookEvents: Array.isArray(operations.stripeWebhookEvents) ? operations.stripeWebhookEvents : [],
    paymentAdjustments: Array.isArray(operations.paymentAdjustments) ? operations.paymentAdjustments : [],
    paymentRecoveryActions: Array.isArray(operations.paymentRecoveryActions) ? operations.paymentRecoveryActions : [],
    eventStaffAssignments: Array.isArray(operations.eventStaffAssignments) ? operations.eventStaffAssignments : [],
    eventStaffAssignmentAudits: Array.isArray(operations.eventStaffAssignmentAudits) ? operations.eventStaffAssignmentAudits : [],
    notificationOutbox: Array.isArray(operations.notificationOutbox) ? operations.notificationOutbox : [],
    notificationAttempts: Array.isArray(operations.notificationAttempts) ? operations.notificationAttempts : [],
    notificationPreferences: Array.isArray(operations.notificationPreferences) ? operations.notificationPreferences : [],
    notificationConsents: Array.isArray(operations.notificationConsents) ? operations.notificationConsents : [],
    notificationChannelControls: Array.isArray(operations.notificationChannelControls) ? operations.notificationChannelControls : [],
    eventNotificationControls: Array.isArray(operations.eventNotificationControls) ? operations.eventNotificationControls : [],
    promoCodes: Array.isArray(operations.promoCodes) ? operations.promoCodes : [],
    promoRedemptions: Array.isArray(operations.promoRedemptions) ? operations.promoRedemptions : [],
    mediaObjects: Array.isArray(operations.mediaObjects) ? operations.mediaObjects : [],
    mediaVideoAssets: Array.isArray(operations.mediaVideoAssets) ? operations.mediaVideoAssets : [],
    mediaProviderEvents: Array.isArray(operations.mediaProviderEvents) ? operations.mediaProviderEvents : [],
    analyticsEvents: Array.isArray(operations.analyticsEvents) ? operations.analyticsEvents : [],
    entitlementRedemptions: Array.isArray(operations.entitlementRedemptions) ? operations.entitlementRedemptions : [],
    adminSavedFilters: Array.isArray(operations.adminSavedFilters) ? operations.adminSavedFilters : [],
    eventLaunchReadiness: Array.isArray(operations.eventLaunchReadiness) ? operations.eventLaunchReadiness : [],
  };
}
export const readOperationsData = async () => normalizeOperationsData(await readDocument("operations"));
export const mutateSiteData = <T>(mutator: (site: SiteData) => Promise<T> | T) =>
  mutateDocument("site", (site) => {
    Object.assign(site, normalizeSiteData(site));
    return mutator(site);
  });
export const mutateOperationsData = <T>(mutator: (ops: OperationsData) => Promise<T> | T) =>
  mutateDocument("operations", (operations) => {
    Object.assign(operations, normalizeOperationsData(operations));
    return mutator(operations);
  });
