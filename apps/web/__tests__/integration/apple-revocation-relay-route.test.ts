/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const captureExceptionMock = vi.fn();
const captureMessageMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
}));

const { GET, POST } = await import("@/app/auth/apple/revocation/route");
const { APPLE_RELAY_CSP } = await import("@/lib/apple/revocation-relay");

const URL_BASE = "https://drafto.eu/auth/apple/revocation";
const NONCE = "relay-nonce_0123456789";
const CODE = "c9f.0.relay.SECRET-code_1";

function post(body: string, contentType = "application/x-www-form-urlencoded"): Promise<Response> {
  return POST(
    new NextRequest(URL_BASE, { method: "POST", headers: { "Content-Type": contentType }, body }),
  );
}

describe("POST /auth/apple/revocation", () => {
  const logSpies: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    logSpies.splice(0);
    for (const method of ["log", "info", "warn", "error"] as const) {
      logSpies.push(vi.spyOn(console, method).mockImplementation(() => {}));
    }
  });

  function expectNothingReported(): void {
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalled();
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  }

  it("303s Android to its deep link, uncached and without a referrer", async () => {
    const response = await post(
      new URLSearchParams({
        state: `android.${NONCE}`,
        code: CODE,
        id_token: "a.b.c",
        user: "{}",
      }).toString(),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `drafto://auth/apple-revocation?code=${CODE}&state=android.${NONCE}`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toBe("");
    expectNothingReported();
  });

  it("serves macOS the relay page that opens its deep link", async () => {
    const fd = new FormData();
    fd.set("state", `macos.${NONCE}`);
    fd.set("error", "user_cancelled_authorize");
    const response = await POST(new NextRequest(URL_BASE, { method: "POST", body: fd }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("content-security-policy")).toBe(APPLE_RELAY_CSP);
    const html = await response.text();
    expect(html).toContain(
      `href="eu.drafto.desktop://auth/apple-revocation?error=user_cancelled_authorize&amp;state=macos.${NONCE}"`,
    );
    expectNothingReported();
  });

  it.each([
    ["a hostile code", `state=android.${NONCE}&code=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E`],
    ["an unknown platform", `state=ios.${NONCE}&code=${CODE}`],
    ["no state", `code=${CODE}`],
    ["neither code nor error", `state=macos.${NONCE}`],
  ])("answers a fixed 400 for %s, never echoing it", async (_label, body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBeNull();
    const text = await response.text();
    expect(text).not.toContain("script");
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(NONCE);
    expectNothingReported();
  });

  it("answers the same 400 when the body is not a form", async () => {
    const response = await post(`{"code":"${CODE}"}`, "application/json");

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(CODE);
    expectNothingReported();
  });
});

describe("GET /auth/apple/revocation", () => {
  it("sends a visitor to the account-deletion explainer", () => {
    const response = GET(new NextRequest(`${URL_BASE}?code=${CODE}`));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://drafto.eu/account/delete");
  });
});
