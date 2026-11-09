import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The middleware entrypoint (`src/middleware.ts`) run through the real `updateSession`, with only
// Supabase mocked: the policy and nonce must survive every branch `updateSession` can take.
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  },
}));

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

const { middleware } = await import("@/middleware");

const SESSION_COOKIE = "sb-test-auth-token=session";
const NONCE_SOURCE = /'nonce-([A-Za-z0-9+/_-]+={0,2})'/;

function request(
  path: string,
  { session = false, headers = {} as Record<string, string>, method = "GET" } = {},
): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method,
    headers: session ? { ...headers, cookie: SESSION_COOKIE } : headers,
  });
}

function signIn(isApproved: boolean): void {
  mockGetUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "test@test.com" } },
    error: null,
  });
  mockFrom.mockReturnValue({
    select: () => ({
      eq: () => ({
        single: () => Promise.resolve({ data: { is_approved: isApproved }, error: null }),
      }),
    }),
  });
}

function signOut(): void {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
}

/** The nonce in a policy's `script-src`. */
function nonceIn(policy: string | null): string | undefined {
  const scriptSrc = policy
    ?.split(";")
    .find((directive) => directive.trim().startsWith("script-src"));
  return scriptSrc?.match(NONCE_SOURCE)?.[1];
}

describe("middleware CSP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // [label, request, set-up, expected status]
  const BRANCHES: Array<[string, () => NextRequest, () => void, number]> = [
    ["a public route", () => request("/login"), signOut, 200],
    ["a direct visit to /welcome (308 to /)", () => request("/welcome"), signOut, 308],
    ["signed-out / (rewrite to the landing page)", () => request("/"), signOut, 200],
    ["a signed-out page (307 to /login)", () => request("/settings"), signOut, 307],
    ["a signed-out API fetch (401 JSON)", () => request("/api/notes"), signOut, 401],
    [
      "an unapproved user on the waiting page",
      () => request("/waiting-for-approval", { session: true }),
      () => signIn(false),
      200,
    ],
    [
      "an unapproved user elsewhere (307 to the waiting page)",
      () => request("/settings", { session: true }),
      () => signIn(false),
      307,
    ],
    ["an approved user", () => request("/", { session: true }), () => signIn(true), 200],
  ];

  it.each(BRANCHES)(
    "puts the policy on the response for %s",
    async (_label, make, setUp, status) => {
      setUp();

      const response = await middleware(make());

      expect(response.status).toBe(status);
      const policy = response.headers.get("content-security-policy");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(nonceIn(policy)).toBeDefined();
    },
  );

  // The responses that render a page: each must forward the nonce and the policy to it.
  const RENDERING: Array<[string, () => NextRequest, () => void]> = [
    ["a public route", () => request("/login"), signOut],
    ["signed-out / (the landing page rewrite)", () => request("/"), signOut],
    [
      "an unapproved user on the waiting page",
      () => request("/waiting-for-approval", { session: true }),
      () => signIn(false),
    ],
    ["an approved user", () => request("/", { session: true }), () => signIn(true)],
  ];

  it.each(RENDERING)(
    "forwards the nonce and the response's own policy to the page for %s",
    async (_label, make, setUp) => {
      setUp();

      const response = await middleware(make());

      const policy = response.headers.get("content-security-policy");
      const forwardedPolicy = response.headers.get("x-middleware-request-content-security-policy");
      expect(forwardedPolicy).toBe(policy);
      expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonceIn(policy));
    },
  );

  it("still forwards the verified user to an approved user's page", async () => {
    signIn(true);

    const response = await middleware(request("/settings", { session: true }));

    expect(response.headers.get("x-middleware-request-x-verified-user-id")).toBe("user-1");
    expect(response.headers.get("x-middleware-request-x-nonce")).not.toBeNull();
  });

  it("uses a fresh nonce for every request", async () => {
    signOut();

    const first = await middleware(request("/login"));
    const second = await middleware(request("/login"));

    expect(nonceIn(first.headers.get("content-security-policy"))).not.toBe(
      nonceIn(second.headers.get("content-security-policy")),
    );
  });

  it("overwrites a nonce and policy the client sent", async () => {
    signOut();

    const response = await middleware(
      request("/login", {
        headers: {
          "x-nonce": "client-chosen",
          "content-security-policy": "script-src 'nonce-client-chosen'",
          "content-security-policy-report-only": "script-src 'nonce-client-chosen'",
        },
      }),
    );

    const nonce = response.headers.get("x-middleware-request-x-nonce");
    expect(nonce).not.toBe("client-chosen");
    expect(nonce).toBe(nonceIn(response.headers.get("content-security-policy")));
    expect(response.headers.get("x-middleware-request-content-security-policy")).not.toContain(
      "client-chosen",
    );
    expect(
      response.headers.get("x-middleware-request-content-security-policy-report-only"),
    ).toBeNull();
  });

  it.each(["GET", "POST"])(
    "leaves the Apple revocation relay's own CSP alone on a %s",
    async (method) => {
      const response = await middleware(
        request("/auth/apple/revocation", {
          method,
          headers: { "x-nonce": "client-chosen" },
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBeNull();
      expect(response.headers.get("x-middleware-request-content-security-policy")).toBeNull();
      expect(response.headers.get("x-middleware-request-x-nonce")).toBeNull();
      expect(mockGetUser).not.toHaveBeenCalled();
    },
  );
});
