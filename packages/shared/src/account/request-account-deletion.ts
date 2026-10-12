/** The web route that permanently deletes the caller's own account. */
export const ACCOUNT_DELETION_PATH = "/api/account";

/**
 * Outcome of a `DELETE /api/account` call, reduced to what a client can act on.
 *
 * - `ok` — the server confirmed the deletion. Only now may a client wipe local data.
 * - `unauthorized` — the token or session was rejected (expired, revoked, wrong environment).
 * - `last-admin` — the caller is the only admin; nothing was deleted.
 * - `failed` — any other response, including a redirect that landed on an HTML page.
 * - `network` — no response arrived. The server may still have received and completed the
 *   request (e.g. the connection dropped mid-deletion), so the copy must not promise otherwise.
 */
export type AccountDeletionResult =
  | { status: "ok" }
  | { status: "unauthorized" }
  | { status: "last-admin" }
  | { status: "failed"; httpStatus: number }
  | { status: "network" };

/**
 * The iOS bundle ID: the Sign in with Apple client that the native sheet issues codes to.
 * The only client whose codes the server redeems for revocation.
 */
export const APPLE_NATIVE_CLIENT_ID = "eu.drafto.mobile";

/**
 * A fresh Sign in with Apple authorization code, sent with the deletion so the server
 * can revoke the user's Apple tokens once the account is gone (App Store Review
 * Guideline 5.1.1(v)). Revocation is best-effort and never decides the deletion.
 */
export interface AppleRevocationGrant {
  /** The `authorizationCode` Apple just returned. Single-use, valid for five minutes. */
  authorizationCode: string;
  /** The client the code was issued to: the iOS bundle ID for the native sheet. */
  clientId: string;
}

/** JSON body of `DELETE /api/account`. It never names the account: that comes from the credential. */
export interface AccountDeletionRequestBody {
  apple?: AppleRevocationGrant;
}

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  json: () => Promise<unknown>;
}>;

export interface RequestAccountDeletionOptions {
  /** Origin that serves the web API, e.g. `https://drafto.eu`. Pass `""` for a same-origin browser call. */
  baseUrl: string;
  /**
   * Supabase access token, sent as `Authorization: Bearer`. Native clients must pass it.
   * The web app omits it and relies on its same-origin session cookie instead.
   */
  accessToken?: string;
  /** Sent only for a user linked to Sign in with Apple, once a fresh code was obtained. */
  appleRevocation?: AppleRevocationGrant;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

/**
 * Asks the server to permanently delete the signed-in user's account.
 *
 * The request carries no user id: the server derives it from the verified token
 * or session. Its only possible body is an Apple revocation grant. Only a JSON
 * response with `success === true` counts as success, so a middleware redirect
 * that `fetch` silently followed to a 200 HTML page is reported as `failed`,
 * never as `ok`.
 */
export async function requestAccountDeletion({
  baseUrl,
  accessToken,
  appleRevocation,
  fetchImpl,
}: RequestAccountDeletionOptions): Promise<AccountDeletionResult> {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  const headers: Record<string, string> = { Accept: "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  // Without a grant the request stays body-less, exactly as before.
  const init: Parameters<FetchLike>[1] = { method: "DELETE", headers };
  if (appleRevocation) {
    const body: AccountDeletionRequestBody = { apple: appleRevocation };
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await doFetch(`${baseUrl.replace(/\/+$/, "")}${ACCOUNT_DELETION_PATH}`, init);
  } catch {
    return { status: "network" };
  }

  if (response.status === 401) return { status: "unauthorized" };
  if (response.status === 409) return { status: "last-admin" };

  if (response.status === 200) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (isSuccessBody(body)) return { status: "ok" };
  }

  return { status: "failed", httpStatus: response.status };
}

function isSuccessBody(body: unknown): boolean {
  return (
    typeof body === "object" && body !== null && (body as { success?: unknown }).success === true
  );
}

/** User-facing copy for every non-`ok` result, shared so all platforms say the same thing. */
export function describeAccountDeletionFailure(
  result: Exclude<AccountDeletionResult, { status: "ok" }>,
): string {
  switch (result.status) {
    case "unauthorized":
      return "Your session has expired. Sign out, sign back in, and try again.";
    case "last-admin":
      return "You are the only admin. Make another user an admin before deleting your account.";
    case "network":
      return "Couldn't reach Drafto. Check your connection and try again.";
    case "failed":
      return "Something went wrong while deleting your account. Please try again.";
  }
}
