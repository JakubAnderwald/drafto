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

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string> },
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
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

/**
 * Asks the server to permanently delete the signed-in user's account.
 *
 * The request carries no user id: the server derives it from the verified token
 * or session. Only a JSON body with `success === true` counts as success, so a
 * middleware redirect that `fetch` silently followed to a 200 HTML page is
 * reported as `failed`, never as `ok`.
 */
export async function requestAccountDeletion({
  baseUrl,
  accessToken,
  fetchImpl,
}: RequestAccountDeletionOptions): Promise<AccountDeletionResult> {
  const doFetch: FetchLike = fetchImpl ?? ((input, init) => fetch(input, init));
  const headers: Record<string, string> = { Accept: "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await doFetch(`${baseUrl.replace(/\/+$/, "")}${ACCOUNT_DELETION_PATH}`, {
      method: "DELETE",
      headers,
    });
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
