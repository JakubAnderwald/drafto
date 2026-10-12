import * as Sentry from "@sentry/nextjs";
import { APPLE_NATIVE_CLIENT_ID, type AppleRevocationGrant } from "@drafto/shared";
import { buildClientSecret } from "@/lib/apple/client-secret.mjs";
import type { AppleSignInKey } from "@/lib/apple/config";

export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

/**
 * Clients whose authorization codes the server redeems. Only the native iOS sheet
 * sends one today. A Services ID code (web) would also need the `redirect_uri` it
 * was issued for, so adding `APPLE_SERVICES_ID` here is not enough on its own.
 */
export const REVOCABLE_CLIENT_IDS: readonly string[] = [APPLE_NATIVE_CLIENT_ID];

/** Per request to Apple, so a slow Apple can delay the deletion response by at most twice this. */
export const APPLE_REQUEST_TIMEOUT_MS = 5_000;

/** A request to Apple is not started with less time than this left before the deadline. */
export const MIN_APPLE_REQUEST_MS = 1_000;

/** Each `client_secret` is signed for one deletion, so it only needs to outlive two requests. */
const CLIENT_SECRET_LIFETIME_SECONDS = 300;

/** Apple's documented error codes are short snake_case words; anything else is not reported. */
const APPLE_ERROR_CODE = /^[a-z_]{1,64}$/;

export type AppleRevocationOutcome =
  | "revoked"
  /** Revoked, but for an Apple ID the account was not linked to (see `revokeAppleSignIn`). */
  | "revoked-other-apple-id"
  | "not-configured"
  | "unsupported-client"
  | "no-apple-identity"
  | "client-secret-failed"
  | "token-exchange-failed"
  | "revoke-failed"
  /** The caller's deadline left no time for a request to Apple. */
  | "out-of-time";

export interface RevokeAppleSignInOptions {
  /** The Sign in with Apple key, or `null` when the environment does not configure one. */
  key: AppleSignInKey | null;
  /**
   * Apple `sub` values of the deleted account's Apple identities (see `appleSubjectsOf`).
   * An account with none is never sent to Apple; a code for another Apple ID is reported.
   */
  appleSubjects: readonly string[];
  /** Only for Sentry context. */
  userId: string;
  /**
   * Epoch milliseconds by which every request to Apple must have finished. Each
   * request's timeout is cut to fit, and none starts with less than
   * `MIN_APPLE_REQUEST_MS` left, so the caller can still send its response.
   */
  deadline?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type AppleResponse =
  { ok: true; body: unknown } | { ok: false; error: Error; status?: number; appleError?: string };

/**
 * Revokes the user's Sign in with Apple authorization, as App Store Review
 * Guideline 5.1.1(v) requires when an account is deleted.
 *
 * Supabase keeps no Apple refresh token, so the client sends a fresh
 * authorization code. It is exchanged at `/auth/token` for a refresh token, and
 * that token is revoked at `/auth/revoke`, which removes Drafto from the user's
 * "Sign in with Apple" apps.
 *
 * The token is revoked even when the ID token names an Apple ID the account was
 * never linked to: a phone signed in to another Apple ID. The person on that
 * phone has just authenticated as that Apple ID in Apple's sheet, and the sheet
 * may have authorized Drafto for it on the spot, so leaving the token live would
 * leave Drafto in that Apple ID's list. Revoking costs that Apple ID nothing but
 * a fresh consent prompt at its next Apple sign-in. That case is reported as a
 * warning, because the account's own Apple authorization was not revoked.
 *
 * Best-effort and never throws: every failure is reported to Sentry, without
 * codes, tokens or the client secret, and returned as an outcome. The caller
 * has already deleted the account, so a throw here would turn a completed
 * deletion into an error response.
 */
export async function revokeAppleSignIn(
  grant: AppleRevocationGrant,
  options: RevokeAppleSignInOptions,
): Promise<AppleRevocationOutcome> {
  try {
    return await runRevocation(grant, options);
  } catch (err) {
    Sentry.captureException(err, {
      extra: { where: "apple-revoke:unexpected", userId: options.userId },
    });
    return "revoke-failed";
  }
}

async function runRevocation(
  grant: AppleRevocationGrant,
  {
    key,
    appleSubjects,
    userId,
    deadline = Number.POSITIVE_INFINITY,
    fetchImpl = fetch,
    timeoutMs = APPLE_REQUEST_TIMEOUT_MS,
  }: RevokeAppleSignInOptions,
): Promise<AppleRevocationOutcome> {
  const { clientId } = grant;
  /** The timeout for the next request to Apple, or `null` when there is no time left for one. */
  const nextTimeout = (): number | null => {
    const remaining = deadline - Date.now();
    return remaining < MIN_APPLE_REQUEST_MS ? null : Math.min(timeoutMs, remaining);
  };
  const outOfTime = (step: string): AppleRevocationOutcome => {
    warn("Sign in with Apple revocation stopped: no time left before the response deadline", {
      where: "apple-revoke:out-of-time",
      userId,
      step,
    });
    return "out-of-time";
  };

  if (!key) {
    warn("Sign in with Apple revocation skipped: no Apple key is configured", {
      where: "apple-revoke:not-configured",
      userId,
    });
    return "not-configured";
  }
  if (!REVOCABLE_CLIENT_IDS.includes(clientId)) {
    warn("Sign in with Apple revocation skipped: unsupported client", {
      where: "apple-revoke:unsupported-client",
      userId,
      clientId,
    });
    return "unsupported-client";
  }
  if (appleSubjects.length === 0) {
    warn("Sign in with Apple revocation skipped: the account has no Apple identity", {
      where: "apple-revoke:no-apple-identity",
      userId,
    });
    return "no-apple-identity";
  }

  let clientSecret: string;
  try {
    clientSecret = buildClientSecret({
      ...key,
      clientId,
      lifetimeSeconds: CLIENT_SECRET_LIFETIME_SECONDS,
    });
  } catch (err) {
    Sentry.captureException(err, { extra: { where: "apple-revoke:client-secret", userId } });
    return "client-secret-failed";
  }

  const exchangeTimeout = nextTimeout();
  if (exchangeTimeout === null) return outOfTime("token");
  const exchange = await postToApple(
    APPLE_TOKEN_URL,
    {
      client_id: clientId,
      client_secret: clientSecret,
      code: grant.authorizationCode,
      grant_type: "authorization_code",
    },
    fetchImpl,
    exchangeTimeout,
  );
  if (!exchange.ok) {
    report(exchange, { where: "apple-revoke:token", userId, clientId });
    return "token-exchange-failed";
  }

  const tokens = readTokens(exchange.body);
  if (!tokens) {
    report(
      { ok: false, error: new Error("Apple's token response carried no token to revoke") },
      { where: "apple-revoke:token", userId, clientId },
    );
    return "token-exchange-failed";
  }

  const revokeTimeout = nextTimeout();
  if (revokeTimeout === null) return outOfTime("revoke");
  const revoke = await postToApple(
    APPLE_REVOKE_URL,
    {
      client_id: clientId,
      client_secret: clientSecret,
      token: tokens.token,
      token_type_hint: tokens.tokenTypeHint,
    },
    fetchImpl,
    revokeTimeout,
  );
  if (!revoke.ok) {
    report(revoke, { where: "apple-revoke:revoke", userId, clientId });
    return "revoke-failed";
  }

  const subject = tokens.idToken ? jwtSubject(tokens.idToken) : null;
  if (!subject || !appleSubjects.includes(subject)) {
    warn("Revoked Sign in with Apple for an Apple ID the account was not linked to", {
      where: "apple-revoke:subject-mismatch",
      userId,
    });
    return "revoked-other-apple-id";
  }

  return "revoked";
}

/** POSTs a form to Apple. Never throws: network errors, timeouts and non-2xx come back as `ok: false`. */
async function postToApple(
  url: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<AppleResponse> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }

  // /auth/revoke answers 200 with an empty body; /auth/token with JSON.
  const text = await response.text().catch(() => "");
  const body = parseJson(text);

  if (!response.ok) {
    const appleError =
      isRecord(body) && typeof body.error === "string" && APPLE_ERROR_CODE.test(body.error)
        ? body.error
        : undefined;
    return {
      ok: false,
      error: new Error(`Apple answered HTTP ${response.status}`),
      status: response.status,
      appleError,
    };
  }
  return { ok: true, body };
}

/** The token to revoke (the refresh token when Apple issued one) and the ID token. */
function readTokens(
  body: unknown,
): { token: string; tokenTypeHint: string; idToken: string | null } | null {
  if (!isRecord(body)) return null;
  const idToken = typeof body.id_token === "string" ? body.id_token : null;
  if (typeof body.refresh_token === "string" && body.refresh_token) {
    return { token: body.refresh_token, tokenTypeHint: "refresh_token", idToken };
  }
  if (typeof body.access_token === "string" && body.access_token) {
    return { token: body.access_token, tokenTypeHint: "access_token", idToken };
  }
  return null;
}

/**
 * Reads `sub` from an ID token without verifying its signature. It only decides
 * what is reported, and the token came straight from Apple's token endpoint over
 * TLS, in answer to a request authenticated with our own client secret.
 */
function jwtSubject(idToken: string): string | null {
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(claims) && typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function report(
  failure: Extract<AppleResponse, { ok: false }>,
  extra: { where: string; userId: string; clientId: string },
): void {
  Sentry.captureException(failure.error, {
    extra: {
      ...extra,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(failure.appleError === undefined ? {} : { appleError: failure.appleError }),
    },
  });
}

function warn(message: string, extra: Record<string, string>): void {
  Sentry.captureMessage(message, { level: "warning", extra });
}
