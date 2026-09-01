import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";

export function randomId(prefix: string) {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function hmac(value: string, secret = config.authSecret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hashRequestIdentity(value: string) {
  return sha256(`${config.authSecret}:${value}`).slice(0, 32);
}
