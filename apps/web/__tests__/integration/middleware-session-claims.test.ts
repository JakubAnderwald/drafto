// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";

// The real @supabase/ssr + auth-js run here; only the env and the network are stubbed. Node's
// environment, not jsdom, so WebCrypto and auth-js share one realm's `Uint8Array`.
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://testref.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  },
}));

const PROJECT_ORIGIN = "https://testref.supabase.co";
// supabase-js derives the storage key from the URL's first hostname label.
const SESSION_COOKIE_NAME = "sb-testref-auth-token";
const USER_ID = "8d0f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const USER_EMAIL = "reader@example.com";

type UpdateSession = typeof import("@/lib/supabase/middleware").updateSession;

type StoredSession = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  token_type: "bearer";
  user: Record<string, unknown>;
};

type RecordedRequest = { method: string; url: URL };

function base64url(value: string | ArrayBuffer): string {
  return (typeof value === "string" ? Buffer.from(value) : Buffer.from(value)).toString(
    "base64url",
  );
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const USER = {
  id: USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: USER_EMAIL,
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
};

let keyPair: CryptoKeyPair;
let kid: string;
let publicJwk: JsonWebKey & { kid: string; alg: string; use: string };
let requests: RecordedRequest[];
let refreshResponse: () => Response;
let updateSession: UpdateSession;

async function signJwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "ES256", typ: "JWT", kid },
): Promise<string> {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  // WebCrypto's ECDSA signature is already the raw r||s that JWS ES256 wants.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(signature)}`;
}

function claims(exp: number): Record<string, unknown> {
  return {
    sub: USER_ID,
    email: USER_EMAIL,
    exp,
    iat: exp - 3600,
    role: "authenticated",
    aud: "authenticated",
    session_id: "5e551011-0000-4000-8000-000000000001",
  };
}

function session(accessToken: string, expiresAt: number, refreshToken: string): StoredSession {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    expires_in: expiresAt - nowSeconds(),
    token_type: "bearer",
    user: USER,
  };
}

// @supabase/ssr's cookie format: `base64-` + base64url(JSON), one cookie while it fits a chunk.
function sessionCookie(stored: StoredSession): string {
  const value = `base64-${base64url(JSON.stringify(stored))}`;
  expect(value.length).toBeLessThan(3180);
  return `${SESSION_COOKIE_NAME}=${value}`;
}

function createRequest(path: string, cookie: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), { headers: { cookie } });
}

function json(body: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });
}

function requestsTo(pathname: string): RecordedRequest[] {
  return requests.filter(({ url }) => url.pathname === pathname);
}

async function fetchStub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  requests.push({ method, url });

  if (url.origin !== PROJECT_ORIGIN) {
    return json({ error: `unexpected origin ${url.origin}` }, 500);
  }
  if (method === "GET" && url.pathname === "/auth/v1/.well-known/jwks.json") {
    return json({ keys: [publicJwk] });
  }
  if (method === "GET" && url.pathname === "/rest/v1/profiles") {
    return json({ is_approved: true }, 200, "application/vnd.pgrst.object+json; charset=utf-8");
  }
  if (
    method === "POST" &&
    url.pathname === "/auth/v1/token" &&
    url.searchParams.get("grant_type") === "refresh_token"
  ) {
    return refreshResponse();
  }
  // `/auth/v1/user` included: afterEach fails the test if it was ever requested.
  return json({ error: `unexpected ${method} ${url.pathname}` }, 500);
}

// The session cookie the response sets, joined from its chunks if @supabase/ssr split it.
function responseSession(response: NextResponse): StoredSession | null {
  const cookies = response.cookies.getAll();
  const whole = cookies.find(({ name }) => name === SESSION_COOKIE_NAME);
  const chunks = cookies
    .filter(({ name }) => name.startsWith(`${SESSION_COOKIE_NAME}.`))
    .sort((a, b) => Number(a.name.split(".").pop()) - Number(b.name.split(".").pop()));
  const value = whole?.value || chunks.map((chunk) => chunk.value).join("");
  if (!value.startsWith("base64-")) {
    return null;
  }
  return JSON.parse(Buffer.from(value.slice("base64-".length), "base64url").toString("utf8"));
}

function expectPassThroughFor(response: NextResponse) {
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("x-middleware-request-x-verified-user-id")).toBe(USER_ID);
  expect(response.headers.get("x-middleware-request-x-verified-user-email")).toBe(USER_EMAIL);
}

function expectLoginRedirect(response: NextResponse) {
  expect(response.status).toBe(307);
  expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/login");
  expect(response.headers.get("x-middleware-request-x-verified-user-id")).toBeNull();
}

describe("middleware session verification with the real @supabase/ssr + auth-js", () => {
  beforeEach(async () => {
    requests = [];
    refreshResponse = () => json({ error: "no refresh expected" }, 500);

    // auth-js caches the JWKS module-globally per storage key. vi.resetModules() may not clear it
    // (auth-js is an externalized CJS dependency), so each test also signs with a fresh key and
    // `kid`: a `kid` the cache doesn't hold makes the first verification fetch the JWKS.
    keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    kid = crypto.randomUUID();
    const exported = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    publicJwk = { ...exported, kid, alg: "ES256", use: "sig", key_ops: ["verify"] };

    vi.stubGlobal("fetch", vi.fn(fetchStub));
    vi.resetModules();
    ({ updateSession } = await import("@/lib/supabase/middleware"));
  });

  afterEach(() => {
    // The point of getClaims(): verification never asks Supabase Auth for the user.
    expect(requestsTo("/auth/v1/user")).toEqual([]);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("passes a validly signed session through with the verified user headers", async () => {
    const exp = nowSeconds() + 3600;
    const cookie = sessionCookie(session(await signJwt(claims(exp)), exp, "refresh-1"));

    const response = await updateSession(createRequest("/settings", cookie));

    expectPassThroughFor(response);
    expect(requestsTo("/auth/v1/.well-known/jwks.json")).toHaveLength(1);
    expect(requestsTo("/auth/v1/token")).toEqual([]);
    expect(requestsTo("/rest/v1/profiles")).toHaveLength(1);
    // No refresh, so no session cookie is rewritten.
    expect(responseSession(response)).toBeNull();
  });

  it("passes an API fetch through with the verified user headers", async () => {
    const exp = nowSeconds() + 3600;
    const cookie = sessionCookie(session(await signJwt(claims(exp)), exp, "refresh-1"));

    const response = await updateSession(createRequest("/api/notes", cookie));

    expectPassThroughFor(response);
  });

  it("fetches the JWKS once for two requests in the same instance", async () => {
    const exp = nowSeconds() + 3600;
    const cookie = sessionCookie(session(await signJwt(claims(exp)), exp, "refresh-1"));

    expectPassThroughFor(await updateSession(createRequest("/settings", cookie)));
    expectPassThroughFor(await updateSession(createRequest("/api/notes", cookie)));

    expect(requestsTo("/auth/v1/.well-known/jwks.json")).toHaveLength(1);
    expect(requestsTo("/rest/v1/profiles")).toHaveLength(2);
  });

  describe("a tampered signature", () => {
    async function tamperedCookie(): Promise<string> {
      const exp = nowSeconds() + 3600;
      const [header, payload, signature] = (await signJwt(claims(exp))).split(".");
      const bytes = Buffer.from(signature, "base64url");
      bytes[0] ^= 0xff;
      bytes[bytes.length - 1] ^= 0xff;
      const token = `${header}.${payload}.${bytes.toString("base64url")}`;
      return sessionCookie(session(token, exp, "refresh-1"));
    }

    it("sends a page to /login", async () => {
      const response = await updateSession(createRequest("/settings", await tamperedCookie()));

      expectLoginRedirect(response);
      expect(requestsTo("/auth/v1/.well-known/jwks.json")).toHaveLength(1);
      expect(requestsTo("/rest/v1/profiles")).toEqual([]);
    });

    it("answers an API fetch with 401", async () => {
      const response = await updateSession(createRequest("/api/notes", await tamperedCookie()));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
      expect(requestsTo("/rest/v1/profiles")).toEqual([]);
    });
  });

  it.each(["ES999", "none"])(
    "treats a token whose header claims alg %s with the real kid as signed out",
    async (alg) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const exp = nowSeconds() + 3600;
      const token = await signJwt(claims(exp), { alg, typ: "JWT", kid });
      const cookie = sessionCookie(session(token, exp, "refresh-1"));

      const response = await updateSession(createRequest("/settings", cookie));

      expectLoginRedirect(response);
      // auth-js fetched the key for the real kid, then getAlgorithm() threw a plain Error, which
      // getClaims() re-throws and the helper's catch turns into signed out.
      expect(requestsTo("/auth/v1/.well-known/jwks.json")).toHaveLength(1);
      expect(consoleError).toHaveBeenCalledWith(
        "[middleware] Session verification failed:",
        expect.objectContaining({ message: "Invalid alg claim" }),
      );
    },
  );

  it("refreshes an expired session, sets the new cookies and passes the request through", async () => {
    const past = nowSeconds() - 60;
    const cookie = sessionCookie(session(await signJwt(claims(past)), past, "refresh-old"));
    const freshExp = nowSeconds() + 3600;
    const freshToken = await signJwt(claims(freshExp));
    refreshResponse = () =>
      json({
        access_token: freshToken,
        refresh_token: "refresh-new",
        expires_in: 3600,
        expires_at: freshExp,
        token_type: "bearer",
        user: USER,
      });

    const response = await updateSession(createRequest("/settings", cookie));

    expectPassThroughFor(response);
    expect(requestsTo("/auth/v1/token")).toHaveLength(1);
    const refreshed = responseSession(response);
    expect(refreshed?.access_token).toBe(freshToken);
    expect(refreshed?.refresh_token).toBe("refresh-new");
  });

  it("signs out an expired session whose refresh token is rejected", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const past = nowSeconds() - 60;
    const cookie = sessionCookie(session(await signJwt(claims(past)), past, "refresh-revoked"));
    refreshResponse = () =>
      json(
        {
          code: 400,
          error_code: "refresh_token_not_found",
          msg: "Invalid Refresh Token: Refresh Token Not Found",
          error: "invalid_grant",
          error_description: "Invalid Refresh Token: Refresh Token Not Found",
        },
        400,
      );

    const response = await updateSession(createRequest("/settings", cookie));

    expectLoginRedirect(response);
    expect(requestsTo("/auth/v1/token")).toHaveLength(1);
    // The expired token was never verified: getSession() failed before getClaims() decoded it.
    expect(requestsTo("/auth/v1/.well-known/jwks.json")).toEqual([]);
    expect(requestsTo("/rest/v1/profiles")).toEqual([]);
  });
});
