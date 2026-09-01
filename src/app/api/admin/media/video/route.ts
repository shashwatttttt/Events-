import { z } from "zod";
import { config } from "@/lib/config";
import { assertRequestOrigin, apiError, noStoreJson, parseJsonRequest } from "@/lib/http";
import { redactProviderId } from "@/lib/media/mux";
import { listVideoAssets } from "@/lib/media/video-store";
import { createVideoUploadIntent, deleteVideoAsset, retryVideoUpload, updateVideoCaptions, updateVideoPoster } from "@/lib/media/video-service";
import { requireUser } from "@/lib/security/session";

const id = z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/);
const optionalUrl = z.string().trim().max(2000).optional();
const caption = z.object({ id, kind: z.enum(["captions", "subtitles"]), label: z.string().trim().min(1).max(100), language: z.string().trim().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/), src: z.string().trim().min(1).max(2000), default: z.boolean().optional() }).strict();
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), mediaItemId: id, eventId: id.optional(), fallbackPosterUrl: optionalUrl, playbackPolicy: z.enum(["public", "signed"]).optional(), mimeType: z.string().trim().min(1).max(100), sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ action: z.literal("retry"), assetId: id, mimeType: z.string().trim().min(1).max(100), sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ action: z.literal("poster"), assetId: id, manualPosterUrl: optionalUrl, posterTimeSeconds: z.number().min(0).max(86400) }).strict(),
  z.object({ action: z.literal("captions"), assetId: id, captions: z.array(caption).max(10) }).strict(),
  z.object({ action: z.literal("delete"), assetId: id }).strict(),
]);

function present(asset: Awaited<ReturnType<typeof listVideoAssets>>[number]) {
  const { providerUploadId, providerAssetId, ...safeAsset } = asset;
  return { ...safeAsset, providerUploadIdRedacted: redactProviderId(providerUploadId), providerAssetIdRedacted: redactProviderId(providerAssetId), playbackIdRedacted: redactProviderId(asset.playbackId) };
}

export async function GET() {
  try {
    await requireUser(["admin", "super_admin"]);
    return noStoreJson({ assets: (await listVideoAssets()).map(present), allowedInputTypes: config.mediaVideoAllowedInputTypes, maxUploadBytes: config.mediaVideoMaxUploadBytes, provider: config.mediaVideoProvider });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    assertRequestOrigin(request);
    const actor = await requireUser(["admin", "super_admin"]);
    const input = await parseJsonRequest(request, schema, 32_768);
    if (input.action === "create") {
      const result = await createVideoUploadIntent(actor, input);
      return noStoreJson({ ...result, asset: present(result.asset) }, 201);
    }
    if (input.action === "retry") {
      const result = await retryVideoUpload(actor, input.assetId, input);
      return noStoreJson({ ...result, asset: present(result.asset) }, 201);
    }
    if (input.action === "poster") return noStoreJson({ asset: present(await updateVideoPoster(actor, input.assetId, input)) });
    if (input.action === "captions") return noStoreJson({ asset: present(await updateVideoCaptions(actor, input.assetId, input.captions)) });
    return noStoreJson({ asset: present(await deleteVideoAsset(actor, input.assetId)), deleted: true });
  } catch (error) { return apiError(error); }
}
