/**
 * Runs the app's deep-link handlers against a real supabase-js client and a
 * fake auth server that checks each code's S256 challenge, as Supabase does.
 * Proves the claim of ADR-0045's per-flow amendment: with
 * `experimental.appendPkceFlowIdToRedirects`, a pending reset or Apple sign-in
 * is exchanged with its own verifier after a newer PKCE flow has started on the
 * device, and a link without `sb_flow_id` still reads the newest verifier, as
 * before.
 */
import { createClient, type AuthChangeEvent, type SupabaseClient } from "@supabase/supabase-js";
import { PKCE_FLOW_ID_PARAM as AUTH_JS_FLOW_ID_PARAM } from "@supabase/auth-js/dist/main/lib/constants";

import { SIGNUP_EMAIL_REDIRECT_URL } from "@drafto/shared";

import { PKCE_FLOW_ID_PARAM } from "@/lib/app-deep-link";
import { AUTH_CALLBACK_URL, completeAuthCallback } from "@/lib/auth-callback";
import { RECOVERY_REDIRECT_URL, completeRecoveryFromUrl } from "@/lib/auth-recovery";

let mockClient: SupabaseClient | null = null;

jest.mock("@/lib/supabase", () => ({
  get supabase() {
    if (!mockClient) throw new Error("the test has not created a client yet");
    return mockClient;
  },
}));

const SUPABASE_URL = "https://example.supabase.co";
/** supabase-js derives the storage key from the project ref (the host's first label). */
const STORAGE_KEY = "sb-example-auth-token";
const LEGACY_VERIFIER_KEY = `${STORAGE_KEY}-code-verifier`;
const slotKey = (flowId: string) => `${STORAGE_KEY}-flow-${flowId}-code-verifier`;

/** auth-callback caches outcomes by code for the whole module, so codes never repeat. */
let codeCounter = 0;

type Storage = ReturnType<typeof memoryStorage>;

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: async (key: string) => items.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      items.set(key, value);
    },
    removeItem: async (key: string) => {
      items.delete(key);
    },
  };
}

/** A stored value as auth-js wrote it (JSON), or `null`. */
function stored(storage: Storage, key: string): string | null {
  const raw = storage.items.get(key);
  return raw === undefined ? null : (JSON.parse(raw) as string);
}

/** The bare verifier, without the `/recovery` marker auth-js appends for a reset. */
function verifierIn(storage: Storage, key: string): string {
  const value = stored(storage, key);
  if (!value) throw new Error(`no verifier stored under ${key}`);
  return value.replace(/\/recovery$/, "");
}

async function s256(verifier: string): Promise<string> {
  const hash = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...hash))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function json(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sessionFor(email: string) {
  return {
    access_token: `access-${email}`,
    refresh_token: `refresh-${email}`,
    token_type: "bearer",
    expires_in: 3600,
    user: { id: `user-${email}`, aud: "authenticated", email, app_metadata: {}, user_metadata: {} },
  };
}

type TokenRequest = { auth_code: string; code_verifier: string };

/**
 * The parts of Supabase Auth these flows touch. `/recover`, `/signup` and the
 * authorize URL register a flow's challenge. `redirectFor` then mints the code
 * Supabase would put on the redirect, and `/token?grant_type=pkce` accepts it
 * only with a verifier whose S256 matches that challenge.
 *
 * Supabase ties a reset email's code to the account's newest reset request, so
 * a second reset for the same address makes the first link fail on the server,
 * whatever the client does. The fake doesn't model that, so the cross-flow cases
 * below use another kind of flow or a reset for another account, never a second
 * reset for the same address.
 */
function fakeAuthServer() {
  const challengeByCode = new Map<string, string>();
  const tokenRequests: TokenRequest[] = [];
  const pendingResets = new Map<string, { redirectTo: string; challenge: string }>();
  const signUpRedirects: string[] = [];

  const fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
    const redirectTo = url.searchParams.get("redirect_to") ?? "";

    if (url.pathname === "/auth/v1/recover") {
      pendingResets.set(body.email, { redirectTo, challenge: body.code_challenge });
      return json(200, {});
    }

    if (url.pathname === "/auth/v1/signup") {
      // Email confirmation is on, so sign-up returns a user and no session.
      signUpRedirects.push(redirectTo);
      return json(200, { id: `user-${body.email}`, aud: "authenticated", email: body.email });
    }

    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      const request = body as unknown as TokenRequest;
      tokenRequests.push(request);
      const challenge = challengeByCode.get(request.auth_code);
      if (!challenge) {
        return json(404, { error_code: "flow_state_not_found", msg: "invalid flow state" });
      }
      if ((await s256(request.code_verifier)) !== challenge) {
        return json(400, {
          error_code: "bad_code_verifier",
          msg: "code challenge does not match previously saved code verifier",
        });
      }
      challengeByCode.delete(request.auth_code);
      return json(200, sessionFor("reset@example.com"));
    }

    return json(404, { msg: `unexpected request to ${url.pathname}` });
  });

  /**
   * The link Supabase redirects to once the flow's step in the browser is done:
   * the `redirect_to` the client sent, plus a `code` tied to `challenge`. Like
   * Supabase, it keeps the redirect's own query params.
   */
  function redirectFor(redirectTo: string, challenge: string): string {
    const code = `code-${++codeCounter}`;
    challengeByCode.set(code, challenge);
    const [base, query = ""] = redirectTo.split("?");
    const params = new URLSearchParams(query);
    params.set("code", code);
    params.sort();
    return `${base}?${params.toString()}`;
  }

  return {
    fetch,
    tokenRequests,
    redirectFor,
    /** The link in the reset email `email` was last sent. */
    resetLink(email: string): string {
      const reset = pendingResets.get(email);
      if (!reset) throw new Error(`no reset was requested for ${email}`);
      return redirectFor(reset.redirectTo, reset.challenge);
    },
    /** The `redirect_to` of the most recent sign-up. */
    lastSignUpRedirect(): string {
      const redirectTo = signUpRedirects.at(-1);
      if (redirectTo === undefined) throw new Error("no sign-up was sent");
      return redirectTo;
    },
  };
}

type FakeAuthServer = ReturnType<typeof fakeAuthServer>;

/** The mobile client's auth options (`src/lib/supabase.ts`), on in-memory storage. */
function mobileClient(server: FakeAuthServer, storage: Storage, { flowIds = true } = {}) {
  return createClient(SUPABASE_URL, "anon-key", {
    auth: {
      storage,
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: "pkce",
      experimental: { appendPkceFlowIdToRedirects: flowIds },
    },
    global: { fetch: server.fetch },
  });
}

/** The `sb_flow_id` a redirect URL carries. */
function flowIdOf(redirectTo: string): string {
  const flowId = new URLSearchParams(redirectTo.split("?")[1] ?? "").get(PKCE_FLOW_ID_PARAM);
  if (!flowId) throw new Error(`no ${PKCE_FLOW_ID_PARAM} on ${redirectTo}`);
  return flowId;
}

const RESET_EMAIL = "reset@example.com";

async function requestReset(client: SupabaseClient, server: FakeAuthServer, email = RESET_EMAIL) {
  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: RECOVERY_REDIRECT_URL,
  });
  expect(error).toBeNull();
  return server.resetLink(email);
}

/** Starts Apple sign-in the way `signInWithAppleBrowser` does, and returns its redirect. */
async function startAppleSignIn(client: SupabaseClient, server: FakeAuthServer) {
  const { data, error } = await client.auth.signInWithOAuth({
    provider: "apple",
    options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true },
  });
  expect(error).toBeNull();
  const authorize = new URL(data.url as string);
  const redirectTo = authorize.searchParams.get("redirect_to") as string;
  const challenge = authorize.searchParams.get("code_challenge") as string;
  return { flowId: data.flowId, redirect: server.redirectFor(redirectTo, challenge) };
}

/** Signs up the way `app/(auth)/signup.tsx` does, and returns the flow id on its redirect. */
async function signUp(client: SupabaseClient, server: FakeAuthServer) {
  const { data, error } = await client.auth.signUp({
    email: "new@example.com",
    password: "a-long-password",
    options: { emailRedirectTo: SIGNUP_EMAIL_REDIRECT_URL },
  });
  expect(error).toBeNull();
  expect(data.session).toBeNull();
  return flowIdOf(server.lastSignUpRedirect());
}

type SecondFlow = "another-account-reset" | "apple" | "sign-up";

async function startSecondFlow(client: SupabaseClient, server: FakeAuthServer, kind: SecondFlow) {
  switch (kind) {
    case "apple":
      return (await startAppleSignIn(client, server)).flowId;
    case "sign-up":
      return signUp(client, server);
    case "another-account-reset":
      return flowIdOf(await requestReset(client, server, "other@example.com"));
  }
}

/** Requests a reset, then starts a second flow, as in the issue's scenario. */
async function resetThenSecondFlow(
  client: SupabaseClient,
  server: FakeAuthServer,
  storage: Storage,
  second: SecondFlow,
) {
  const resetLink = await requestReset(client, server);
  const resetFlowId = flowIdOf(resetLink);
  const resetVerifier = verifierIn(storage, slotKey(resetFlowId));

  const secondFlowId = await startSecondFlow(client, server, second);
  if (!secondFlowId) throw new Error("the second flow returned no flow id");
  const secondVerifier = verifierIn(storage, slotKey(secondFlowId));

  return { resetLink, resetFlowId, resetVerifier, secondFlowId, secondVerifier };
}

describe("per-flow PKCE verifiers on mobile (ADR-0045)", () => {
  let storage: Storage;
  let server: FakeAuthServer;

  beforeEach(() => {
    storage = memoryStorage();
    server = fakeAuthServer();
    mockClient = mobileClient(server, storage);
  });

  afterEach(() => {
    mockClient = null;
  });

  it("uses auth-js's own name for the flow id param", () => {
    expect(PKCE_FLOW_ID_PARAM).toBe(AUTH_JS_FLOW_ID_PARAM);
  });

  it("appends the flow id to the reset, Apple and sign-up redirects, keeping their paths", async () => {
    const client = mockClient as SupabaseClient;

    const resetLink = await requestReset(client, server);
    const apple = await startAppleSignIn(client, server);
    const signUpFlowId = await signUp(client, server);

    expect(resetLink).toMatch(/^drafto:\/\/reset-password\?code=code-\d+&sb_flow_id=[0-9a-f]{32}$/);
    expect(apple.redirect).toBe(
      `${AUTH_CALLBACK_URL}?code=code-${codeCounter}&sb_flow_id=${apple.flowId}`,
    );
    // Confirmed in a browser, so never exchanged here. Only a wildcard allowlist entry matches it.
    expect(server.lastSignUpRedirect()).toBe(
      `${SIGNUP_EMAIL_REDIRECT_URL}&sb_flow_id=${signUpFlowId}`,
    );
  });

  it.each([
    ["an Apple sign-in", "apple"],
    ["a sign-up", "sign-up"],
    ["a reset for another account", "another-account-reset"],
  ] as const)(
    "opens reset A with A's own verifier after %s has started",
    async (_label, second) => {
      const flows = await resetThenSecondFlow(
        mockClient as SupabaseClient,
        server,
        storage,
        second,
      );
      // The state that used to break the link: the fixed key now holds the newer flow's verifier.
      expect(verifierIn(storage, LEGACY_VERIFIER_KEY)).toBe(flows.secondVerifier);
      const events: AuthChangeEvent[] = [];
      mockClient?.auth.onAuthStateChange((event) => {
        events.push(event);
      });
      const onRecoveryError = jest.fn();

      await completeRecoveryFromUrl(flows.resetLink, { onRecoveryError });

      expect(server.tokenRequests).toHaveLength(1);
      expect(server.tokenRequests[0].code_verifier).toBe(flows.resetVerifier);
      expect(server.tokenRequests[0].code_verifier).not.toBe(flows.secondVerifier);
      expect(onRecoveryError).not.toHaveBeenCalled();
      expect(events).toContain("PASSWORD_RECOVERY");
      // A's slot is spent; the newer flow's slot and the fixed key are untouched.
      expect(stored(storage, slotKey(flows.resetFlowId))).toBeNull();
      expect(verifierIn(storage, slotKey(flows.secondFlowId))).toBe(flows.secondVerifier);
      expect(verifierIn(storage, LEGACY_VERIFIER_KEY)).toBe(flows.secondVerifier);
    },
  );

  it("completes a pending Apple sign-in after a reset was requested", async () => {
    const client = mockClient as SupabaseClient;
    const apple = await startAppleSignIn(client, server);
    const appleVerifier = verifierIn(storage, slotKey(apple.flowId as string));
    await requestReset(client, server);

    expect(await completeAuthCallback(apple.redirect)).toEqual({ error: null });

    expect(server.tokenRequests).toHaveLength(1);
    expect(server.tokenRequests[0].code_verifier).toBe(appleVerifier);
  });

  it("falls back to the newest verifier for a link without sb_flow_id", async () => {
    const flows = await resetThenSecondFlow(mockClient as SupabaseClient, server, storage, "apple");
    const linkWithoutFlowId = flows.resetLink.replace(/&sb_flow_id=[^&]+/, "");
    const onRecoveryError = jest.fn();

    await completeRecoveryFromUrl(linkWithoutFlowId, { onRecoveryError });

    // The behaviour before this change: the fixed key, which the Apple flow overwrote.
    expect(server.tokenRequests).toHaveLength(1);
    expect(server.tokenRequests[0].code_verifier).toBe(flows.secondVerifier);
    expect(onRecoveryError).toHaveBeenCalledWith(
      "code challenge does not match previously saved code verifier",
    );
  });

  it("still completes a reset requested before the update, whose link has no flow id", async () => {
    // The previous build wrote the verifier; SecureStore keeps it across the update.
    const resetLink = await requestReset(mobileClient(server, storage, { flowIds: false }), server);
    expect(resetLink).not.toContain(PKCE_FLOW_ID_PARAM);
    const verifier = verifierIn(storage, LEGACY_VERIFIER_KEY);
    const onRecoveryError = jest.fn();

    await completeRecoveryFromUrl(resetLink, { onRecoveryError });

    expect(server.tokenRequests[0].code_verifier).toBe(verifier);
    expect(onRecoveryError).not.toHaveBeenCalled();
  });

  it("no longer lets a forged link without a flow id spoil a pending reset", async () => {
    const resetLink = await requestReset(mockClient as SupabaseClient, server);
    const onRecoveryError = jest.fn();

    // Any website can open this. auth-js deletes the verifier it read on a failed exchange.
    await completeRecoveryFromUrl(`${RECOVERY_REDIRECT_URL}?code=forged`, { onRecoveryError });

    expect(onRecoveryError).toHaveBeenCalledTimes(1);
    expect(stored(storage, LEGACY_VERIFIER_KEY)).toBeNull();
    onRecoveryError.mockClear();

    // The genuine link reads its own slot, which the forged exchange left alone.
    await completeRecoveryFromUrl(resetLink, { onRecoveryError });

    expect(server.tokenRequests).toHaveLength(2);
    expect(onRecoveryError).not.toHaveBeenCalled();
  });

  it("fails a flow id whose verifier is gone without trying another flow's", async () => {
    const flows = await resetThenSecondFlow(mockClient as SupabaseClient, server, storage, "apple");
    storage.items.delete(slotKey(flows.resetFlowId));
    const onRecoveryError = jest.fn();

    await completeRecoveryFromUrl(flows.resetLink, { onRecoveryError });

    // A mismatched verifier would burn the single-use code, so nothing is sent.
    expect(server.tokenRequests).toHaveLength(0);
    expect(onRecoveryError).toHaveBeenCalledWith(
      "Open this link on the device where you asked for the reset, or request a new one.",
    );
    expect(verifierIn(storage, slotKey(flows.secondFlowId))).toBe(flows.secondVerifier);
  });
});
