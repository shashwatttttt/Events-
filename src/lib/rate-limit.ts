import "server-only";

import { isIP } from "node:net";
import { config } from "@/lib/config";
import { PublicApiError } from "@/lib/http";
import { hashRequestIdentity } from "@/lib/security/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Bucket = { count: number; resetAt: number };
export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

const buckets = new Map<string, Bucket>();

function localRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  for (const [bucketKey, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(bucketKey);
  }
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }
  const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
  if (current.count >= limit) return { allowed: false, remaining: 0, retryAfterSeconds };
  current.count += 1;
  return { allowed: true, remaining: Math.max(0, limit - current.count), retryAfterSeconds };
}

export async function rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const safeLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
  const windowSeconds = Math.max(1, Math.min(86_400, Math.ceil(windowMs / 1000)));
  const keyHash = hashRequestIdentity(key);
  if (config.dataProvider !== "supabase") return localRateLimit(keyHash, safeLimit, windowSeconds * 1000);

  const { data, error } = await createSupabaseAdminClient().rpc("skie_consume_rate_limit", {
    p_key_hash: keyHash,
    p_limit: safeLimit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw new PublicApiError("RATE_LIMIT_UNAVAILABLE", "Request protection is temporarily unavailable.", 503);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") throw new PublicApiError("RATE_LIMIT_UNAVAILABLE", "Request protection is temporarily unavailable.", 503);
  const value = row as Record<string, unknown>;
  return {
    allowed: Boolean(value.allowed),
    remaining: Math.max(0, Number(value.remaining || 0)),
    retryAfterSeconds: Math.max(1, Number(value.retry_after_seconds || 1)),
  };
}

export async function enforceRateLimit(key: string, limit: number, windowMs: number) {
  const result = await rateLimit(key, limit, windowMs);
  if (!result.allowed) {
    throw new PublicApiError(
      "RATE_LIMITED",
      "Too many attempts. Try again later.",
      429,
      { "Retry-After": String(result.retryAfterSeconds) },
    );
  }
  return result;
}

function trustedClientIp(request: Request) {
  if (process.env.VERCEL !== "1") return "direct";
  const candidate = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "";
  return isIP(candidate) ? candidate : "direct";
}

export function requestKey(request: Request, namespace: string, discriminator?: string) {
  const safeNamespace = namespace.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 60) || "request";
  const identity = [trustedClientIp(request), discriminator?.trim().toLowerCase().slice(0, 254) || ""].join("|");
  return `${safeNamespace}:${hashRequestIdentity(identity)}`;
}

export function resetLocalRateLimitsForTests() {
  if (process.env.NODE_ENV === "test") buckets.clear();
}
