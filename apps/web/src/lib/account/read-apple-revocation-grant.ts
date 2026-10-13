import * as Sentry from "@sentry/nextjs";
import type { NextRequest } from "next/server";
import { z } from "zod";
import type { AppleRevocationGrant } from "@drafto/shared";

/** Far above any real body, in bytes; a larger one is ignored rather than read in full. */
const MAX_BODY_BYTES = 16_384;

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
  // Refuse a declared oversized body without reading it. One sent without a
  // Content-Length is cut off by the bounded read below.
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return ignoreBody(userId, "too large");

  let text: string | null;
  try {
    text = await readBoundedText(request.body, MAX_BODY_BYTES);
  } catch (err) {
    Sentry.captureException(err, { extra: { where: "account-delete:readBody", userId } });
    return null;
  }
  if (text === null) return ignoreBody(userId, "too large");
  if (!text.trim()) return null;

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

/**
 * Reads a body stream as UTF-8 text, or returns `null` (and cancels the stream)
 * as soon as it passes `maxBytes`, so an oversized body is never held in memory.
 */
async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string | null> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function ignoreBody(userId: string, reason: string): null {
  Sentry.captureMessage("Ignored a malformed account deletion body", {
    level: "warning",
    extra: { where: "account-delete:body", userId, reason },
  });
  return null;
}
