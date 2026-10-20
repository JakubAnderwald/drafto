import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@drafto/shared";

/** The production Supabase project. E2E cleanup deletes data, so it must never run there. */
export const PRODUCTION_PROJECT_REF = "tbmjbxxseonkciqovnpl";

/** A Supabase client signed in as the E2E user, and that user's id. */
export interface E2ESession {
  client: SupabaseClient<Database>;
  userId: string;
}

export function assertNotProduction(supabaseUrl: string): void {
  if (supabaseUrl.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error(
      `E2E cleanup refuses to run against the production Supabase project (${PRODUCTION_PROJECT_REF}). ` +
        "Point NEXT_PUBLIC_SUPABASE_URL at the dev project.",
    );
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set to clean up E2E data`);
  return value;
}

/**
 * Signs in with E2E_TEST_EMAIL / E2E_TEST_PASSWORD and the anon key. RLS limits the
 * client to the E2E user's own rows, so cleanup needs no service-role key (CI withholds
 * it on pull-request runs).
 */
export async function signInAsE2EUser(): Promise<E2ESession> {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  assertNotProduction(url);

  const client = createClient<Database>(url, requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-drafto-client": "web-e2e-cleanup" } },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: requireEnv("E2E_TEST_EMAIL"),
    password: requireEnv("E2E_TEST_PASSWORD"),
  });
  if (error || !data.user) {
    throw new Error(`E2E cleanup could not sign in: ${error?.message ?? "no user returned"}`);
  }
  return { client, userId: data.user.id };
}

/**
 * Ends this client's own session. Local scope only: the default (`global`) revokes every
 * session of the E2E user, including the one in `e2e/.auth/user.json` that the specs share.
 */
export async function signOutE2EUser(session: E2ESession): Promise<void> {
  await session.client.auth.signOut({ scope: "local" });
}

/** After a failed sign-in, how long `lazyE2ESession` waits before it tries again. */
export const SIGN_IN_RETRY_MS = 30_000;

export interface LazyE2ESession {
  /** The session, signing in on first use. */
  get(): Promise<E2ESession>;
  /** Signs out if a sign-in succeeded. Never throws. */
  release(): Promise<void>;
}

/**
 * Signs in on first use and then reuses the session. A failed sign-in isn't kept for good:
 * calls within `retryAfterMs` of it get the same error, and the first call after that
 * tries again. One blip doesn't switch cleanup off for the rest of a worker, and a
 * struggling auth server sees at most one attempt per interval.
 */
export function lazyE2ESession(
  signIn: () => Promise<E2ESession> = signInAsE2EUser,
  retryAfterMs: number = SIGN_IN_RETRY_MS,
  now: () => number = Date.now,
): LazyE2ESession {
  let session: Promise<E2ESession> | undefined;
  let lastFailure: { at: number; error: unknown } | undefined;

  return {
    get() {
      if (session) return session;
      if (lastFailure && now() - lastFailure.at < retryAfterMs) {
        return Promise.reject(lastFailure.error);
      }
      const attempt = signIn();
      session = attempt;
      attempt.catch((error: unknown) => {
        if (session === attempt) session = undefined;
        lastFailure = { at: now(), error };
      });
      return attempt;
    },
    async release() {
      await session?.then(signOutE2EUser).catch(() => {});
    },
  };
}
