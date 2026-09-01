import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "@/lib/config";
import { mutateOperationsData, readOperationsData, readSiteData } from "@/lib/data/documents";
import { PublicApiError } from "@/lib/http";
import { randomId } from "@/lib/security/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { MediaItem, MediaStorageObject, SessionUser } from "@/types/site";

export type RegisterMediaInput = Pick<MediaStorageObject, "bucket" | "objectKey" | "publicUrl" | "kind" | "mimeType" | "sizeBytes">;

export async function registerMediaObject(actor: SessionUser, input: RegisterMediaInput) {
  if (config.dataProvider === "supabase") {
    const result = await createSupabaseAdminClient().from("media_objects").insert({
      bucket_id: input.bucket, object_key: input.objectKey, public_url: input.publicUrl, kind: input.kind,
      mime_type: input.mimeType, size_bytes: input.sizeBytes, status: "orphan", uploaded_by: actor.id,
    }).select("id").single();
    if (result.error) throw new PublicApiError("MEDIA_REGISTRY_FAILED", "The uploaded object could not be registered.", 503);
    return String(result.data.id);
  }
  return mutateOperationsData((ops) => {
    const createdAt = new Date().toISOString();
    const object: MediaStorageObject = { id: randomId("media_object"), ...input, status: "orphan", uploadedBy: actor.id, createdAt };
    ops.mediaObjects.push(object);
    return object.id;
  });
}

export function referencedUrls(media: MediaItem[]) {
  return new Set(media.flatMap((item) => [item.url, item.posterUrl, item.manualPosterUrl, item.generatedPosterUrl, item.fallbackPosterUrl, item.thumbnailUrl, ...(item.captions || []).map((track) => track.src)]).filter((value): value is string => Boolean(value)));
}

export function selectOrphanCleanupCandidates<T extends Pick<MediaStorageObject, "publicUrl" | "status" | "createdAt" | "orphanedAt">>(
  objects: T[],
  media: MediaItem[],
  cutoff: number,
): T[] {
  const urls = referencedUrls(media);
  return objects.filter((item) => item.status === "orphan"
    && new Date(item.orphanedAt || item.createdAt).getTime() <= cutoff
    && !urls.has(item.publicUrl));
}

export async function reconcileMediaReferences(media: MediaItem[]) {
  const urls = referencedUrls(media);
  const timestamp = new Date().toISOString();
  if (config.dataProvider === "supabase") {
    const client = createSupabaseAdminClient();
    const current = await client.from("media_objects").select("id,public_url,status").neq("status", "deleted").limit(5000);
    if (current.error) throw new PublicApiError("MEDIA_REGISTRY_UNAVAILABLE", "Media references could not be synchronized.", 503);
    for (const row of current.data || []) {
      const referenced = urls.has(String(row.public_url));
      const status = referenced ? "referenced" : "orphan";
      if (row.status === status) continue;
      const updated = await client.from("media_objects").update({ status, referenced_at: referenced ? timestamp : null, orphaned_at: referenced ? null : timestamp }).eq("id", row.id);
      if (updated.error) throw new PublicApiError("MEDIA_REGISTRY_UNAVAILABLE", "Media references could not be synchronized.", 503);
    }
    return;
  }
  await mutateOperationsData((ops) => {
    for (const object of ops.mediaObjects.filter((item) => item.status !== "deleted")) {
      const referenced = urls.has(object.publicUrl);
      object.status = referenced ? "referenced" : "orphan";
      object.referencedAt = referenced ? (object.referencedAt || timestamp) : undefined;
      object.orphanedAt = referenced ? undefined : (object.orphanedAt || timestamp);
    }
  });
}

async function removeStoredObject(object: { bucket: string; objectKey: string; publicUrl: string }) {
  if (config.dataProvider === "supabase") {
    const result = await createSupabaseAdminClient().storage.from(object.bucket).remove([object.objectKey]);
    if (result.error) throw new PublicApiError("MEDIA_DELETE_FAILED", "The media object could not be deleted.", 503);
    return;
  }
  const uploadRoot = path.resolve(process.cwd(), "public", "uploads");
  const destination = path.resolve(uploadRoot, object.objectKey.replace(/^uploads\//, ""));
  if (destination === uploadRoot || !destination.startsWith(`${uploadRoot}${path.sep}`)) {
    throw new PublicApiError("MEDIA_PATH_INVALID", "The media object path is invalid.", 409);
  }
  try {
    await fs.unlink(destination);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw new PublicApiError("MEDIA_DELETE_FAILED", "The media object could not be deleted.", 503);
    }
  }
}

export async function deleteUnreferencedMedia(actor: SessionUser, publicUrl: string) {
  const site = await readSiteData();
  if (referencedUrls(site.media).has(publicUrl)) throw new PublicApiError("MEDIA_STILL_REFERENCED", "Remove and save every media reference before deleting this object.", 409);
  if (config.dataProvider === "supabase") {
    const client = createSupabaseAdminClient();
    const found = await client.from("media_objects").select("id,bucket_id,object_key,public_url,status").eq("public_url", publicUrl).neq("status", "deleted").maybeSingle();
    if (found.error || !found.data) throw new PublicApiError("MEDIA_OBJECT_NOT_FOUND", "The media object was not found.", 404);
    await removeStoredObject({ bucket: found.data.bucket_id, objectKey: found.data.object_key, publicUrl: found.data.public_url });
    const updated = await client.from("media_objects").update({ status: "deleted", deleted_at: new Date().toISOString(), deleted_by: actor.id }).eq("id", found.data.id);
    if (updated.error) throw new PublicApiError("MEDIA_REGISTRY_FAILED", "The media deletion could not be recorded.", 503);
    return;
  }
  await mutateOperationsData(async (ops) => {
    const object = ops.mediaObjects.find((item) => item.publicUrl === publicUrl && item.status !== "deleted");
    if (!object) throw new PublicApiError("MEDIA_OBJECT_NOT_FOUND", "The media object was not found.", 404);
    await removeStoredObject(object);
    object.status = "deleted"; object.deletedAt = new Date().toISOString();
  });
}

export async function cleanupOrphanedMedia(actor: SessionUser, minimumAgeHours = 24) {
  const cutoff = Date.now() - minimumAgeHours * 60 * 60 * 1000;
  const site = await readSiteData();
  const urls = referencedUrls(site.media);
  const candidates = config.dataProvider === "supabase"
    ? await (async () => {
      const result = await createSupabaseAdminClient().from("media_objects").select("public_url,status,created_at,orphaned_at").eq("status", "orphan").limit(25);
      if (result.error) throw new PublicApiError("MEDIA_REGISTRY_UNAVAILABLE", "Orphan cleanup is temporarily unavailable.", 503);
      return (result.data || []).map((row) => ({ url: String(row.public_url), age: new Date(String(row.orphaned_at || row.created_at)).getTime() }));
    })()
    : (await readOperationsData()).mediaObjects.filter((item) => item.status === "orphan").slice(0, 25).map((item) => ({ url: item.publicUrl, age: new Date(item.orphanedAt || item.createdAt).getTime() }));
  let deleted = 0;
  for (const candidate of candidates) {
    if (candidate.age > cutoff || urls.has(candidate.url)) continue;
    await deleteUnreferencedMedia(actor, candidate.url);
    deleted += 1;
  }
  return { inspected: candidates.length, deleted };
}
