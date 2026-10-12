import * as Sentry from "@sentry/nextjs";
import type { NextRequest } from "next/server";
import { z } from "zod";
import type { AppleRevocationGrant } from "@drafto/shared";

/** Far above any real body; a larger one is ignored rather than parsed. */
const MAX_BODY_LENGTH = 16_384;

const bodySchema = z.object({
  apple: z
    .object({
      authorizationCode: z.string().min(1).max(4_096),
      clientId: z.string().min(1).max(255),
    })
    .optional(),
});

/**
 * Reads the optional Apple revocation grant from a `DELETE /api/account` body.
 *
 * The body is advisory: it can only ask for Apple tokens to be revoked, never
 * name an account. A missing body (web, macOS, older apps) means no grant. A
 * malformed one is reported to Sentry, without its contents, and also means no
 * grant, so it can never stop a deletion.
 */
export async function readAppleRevocationGrant(
  request: NextRequest,
  userId: string,
): Promise<AppleRevocationGrant | null> {
  // Refuse a declared oversized body before buffering it. A body without a
  // Content-Length is still checked after reading, within the platform's limit.
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_LENGTH) return ignoreBody(userId, "too large");

  let text: string;
  try {
    text = await request.text();
  } catch (err) {
    Sentry.captureException(err, { extra: { where: "account-delete:readBody", userId } });
    return null;
  }
  if (!text.trim()) return null;

  if (text.length > MAX_BODY_LENGTH) return ignoreBody(userId, "too large");

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return ignoreBody(userId, "not JSON");
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return ignoreBody(userId, "invalid Apple grant");
  return parsed.data.apple ?? null;
}

function ignoreBody(userId: string, reason: string): null {
  Sentry.captureMessage("Ignored a malformed account deletion body", {
    level: "warning",
    extra: { where: "account-delete:body", userId, reason },
  });
  return null;
}
