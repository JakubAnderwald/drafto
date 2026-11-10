import { test, expect } from "@playwright/test";
import { APPLE_RELAY_CSP } from "../src/lib/apple/revocation-relay";

/**
 * The Sign in with Apple revocation relay (`/auth/apple/revocation`). Apple POSTs its answer
 * here cross-site, with no session, and the route hands it to the Android or macOS app.
 */

// Apple's form post carries no Drafto cookie, so neither do these requests.
test.use({ storageState: { cookies: [], origins: [] } });

const NONCE = "e2e-relay-nonce_0123456789";
const CODE = "c0e2e.0.relay.code-abc_DEF";

test.describe("Apple revocation relay", () => {
  test("redirects Android's answer to the app's deep link", async ({ request }) => {
    const response = await request.post("/auth/apple/revocation", {
      form: { state: `android.${NONCE}`, code: CODE },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(303);
    const location = response.headers()["location"] ?? "";
    expect(location.startsWith("drafto://auth/apple-revocation")).toBe(true);
    expect(location).toContain(`state=android.${NONCE}`);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  });

  test("serves macOS a page that opens the app", async ({ request }) => {
    const response = await request.post("/auth/apple/revocation", {
      form: { state: `macos.${NONCE}`, error: "user_cancelled_authorize" },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/html");
    // Exactly the relay's own hash-based policy: the middleware adds no nonce policy here, which
    // would replace this one and block the page's script (ADR-0069). Playwright joins a header
    // sent twice with a newline, so equality also proves there is one.
    expect(response.headers()["content-security-policy"]).toBe(APPLE_RELAY_CSP);
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
    expect(response.headers()["x-robots-tag"]).toBe("noindex");
    const html = await response.text();
    expect(html).toContain("Return to Drafto");
    expect(html).toContain('href="eu.drafto.desktop://auth/apple-revocation?error=');
  });

  test("refuses an answer it cannot read", async ({ request }) => {
    const response = await request.post("/auth/apple/revocation", {
      form: { state: "ios.not-a-platform", code: "<script>alert(1)</script>" },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(400);
    expect(await response.text()).not.toContain("<script>");
  });
});
