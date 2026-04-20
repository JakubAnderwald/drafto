import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/env";

const TOKEN_VERSION = "v1";
const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000;

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hmac(message: string): string {
  if (!env.APPROVAL_LINK_SECRET) {
    throw new Error("APPROVAL_LINK_SECRET is not configured");
  }
  return base64UrlEncode(createHmac("sha256", env.APPROVAL_LINK_SECRET).update(message).digest());
}

export function signApprovalToken(userId: string, now: Date = new Date()): string {
  const expiresAt = now.getTime() + DEFAULT_TTL_MS;
  const payload = `${TOKEN_VERSION}.${userId}.${expiresAt}`;
  const signature = hmac(payload);
  return `${payload}.${signature}`;
}

export interface VerifiedApprovalToken {
  userId: string;
  expiresAt: number;
}

export function verifyApprovalToken(
  token: string,
  now: Date = new Date(),
): VerifiedApprovalToken | null {
  if (!env.APPROVAL_LINK_SECRET) return null;

  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [version, userId, expiresAtRaw, signature] = parts;
  if (version !== TOKEN_VERSION) return null;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) return null;
  if (expiresAt < now.getTime()) return null;

  const expectedSignature = hmac(`${version}.${userId}.${expiresAtRaw}`);

  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (actualBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(actualBuf, expectedBuf)) return null;

  return { userId, expiresAt };
}
