import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "@/lib/config";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest, PublicApiError } from "@/lib/http";
import { inspectMedia, assertSafeUploadName, MEDIA_REQUEST_LIMIT } from "@/lib/media/security";
import { cleanupOrphanedMedia, deleteUnreferencedMedia, registerMediaObject } from "@/lib/media/store";
import { requireUser } from "@/lib/security/session";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const deleteSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete"), publicUrl: z.string().min(1).max(2000) }).strict(),
  z.object({ action: z.literal("cleanup"), minimumAgeHours: z.number().int().min(24).max(24 * 30).default(24) }).strict(),
]);

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["admin", "super_admin"]);
    const declaredLength = Number(request.headers.get("content-length"));
    if (!Number.isFinite(declaredLength) || declaredLength < 1) throw new PublicApiError("CONTENT_LENGTH_REQUIRED", "A valid Content-Length header is required.", 411);
    if (declaredLength > MEDIA_REQUEST_LIMIT) throw new PublicApiError("MEDIA_REQUEST_TOO_LARGE", "The upload request is too large.", 413);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new PublicApiError("MEDIA_FILE_REQUIRED", "Select a file to upload.", 422);
    assertSafeUploadName(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const inspected = inspectMedia(bytes, file.type);
    const purpose = form.get("purpose");
    if (purpose !== null && purpose !== "media" && purpose !== "poster") throw new PublicApiError("MEDIA_PURPOSE_INVALID", "The upload purpose is invalid.", 422);
    if (purpose === "poster" && inspected.kind !== "image") throw new PublicApiError("MEDIA_POSTER_IMAGE_REQUIRED", "A video poster must be an image.", 422);
    const now = new Date();
    const objectKey = `${inspected.kind === "image" ? "images" : "videos"}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}.${inspected.extension}`;
    let publicUrl: string;
    if (config.dataProvider === "supabase") {
      const client = createSupabaseAdminClient();
      const uploaded = await client.storage.from("media").upload(objectKey, bytes, { contentType: inspected.mimeType, upsert: false, cacheControl: "31536000" });
      if (uploaded.error) throw new PublicApiError("MEDIA_UPLOAD_FAILED", "The media object could not be stored.", 503);
      publicUrl = client.storage.from("media").getPublicUrl(objectKey).data.publicUrl;
      try {
        await registerMediaObject(actor, { bucket: "media", objectKey, publicUrl, kind: inspected.kind, mimeType: inspected.mimeType, sizeBytes: bytes.byteLength });
      } catch {
        const cleanup = await client.storage.from("media").remove([objectKey]);
        if (cleanup.error) throw new PublicApiError("MEDIA_REGISTRY_AND_CLEANUP_FAILED", "The upload needs administrator cleanup.", 503);
        throw new PublicApiError("MEDIA_REGISTRY_FAILED", "The uploaded object could not be registered.", 503);
      }
    } else {
      const uploadRoot = path.resolve(process.cwd(), "public", "uploads");
      const destination = path.resolve(uploadRoot, objectKey);
      if (!destination.startsWith(`${uploadRoot}${path.sep}`)) throw new PublicApiError("MEDIA_PATH_INVALID", "The media path is invalid.", 409);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { flag: "wx" });
      publicUrl = `/uploads/${objectKey.replaceAll("\\", "/")}`;
      try {
        await registerMediaObject(actor, { bucket: "media", objectKey, publicUrl, kind: inspected.kind, mimeType: inspected.mimeType, sizeBytes: bytes.byteLength });
      } catch {
        try {
          await fs.unlink(destination);
        } catch {
          throw new PublicApiError("MEDIA_REGISTRY_AND_CLEANUP_FAILED", "The upload needs administrator cleanup.", 503);
        }
        throw new PublicApiError("MEDIA_REGISTRY_FAILED", "The uploaded object could not be registered.", 503);
      }
    }
    return noStoreJson({ url: publicUrl, objectKey, kind: inspected.kind, mimeType: inspected.mimeType, sizeBytes: bytes.byteLength, width: inspected.width, height: inspected.height }, 201);
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["admin", "super_admin"]);
    const input = await parseJsonRequest(request, deleteSchema, 4_096);
    if (input.action === "cleanup") return noStoreJson(await cleanupOrphanedMedia(actor, input.minimumAgeHours));
    await deleteUnreferencedMedia(actor, input.publicUrl);
    return noStoreJson({ deleted: true });
  } catch (error) {
    return apiError(error);
  }
}
