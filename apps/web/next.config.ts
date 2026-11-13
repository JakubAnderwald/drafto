import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

// Static hardening headers for every response (ADR-0069). The per-request Content-Security-Policy
// is set in `src/middleware.ts`, because it carries a nonce. These are plain values: this file
// must not import `@/env`.
//
// `next start` and Vercel write these before a route handler runs and then skip any header the
// handler sets that is already there, so a route can't override them. Where an entry below sets
// the same header for a path, the later entry wins.
const SECURITY_HEADERS = [
  // Two years. No `preload`: that is a separate, slow-to-undo submission.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // For browsers without CSP `frame-ancestors`, which the middleware's policy also sets.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
      {
        source: "/.well-known/apple-app-site-association",
        headers: [{ key: "Content-Type", value: "application/json" }],
      },
      // The Sign in with Apple relay's answer carries a credential: it must not leak as a
      // referrer. Same value as `APPLE_RELAY_PRIVATE_HEADERS` in
      // `src/lib/apple/revocation-relay.ts`, which the route can't apply itself (see above).
      {
        source: "/auth/apple/revocation",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  org: "jakub-anderwald",
  project: "drafto",
  silent: !process.env.CI,
  widenClientFileUpload: true,
  release: {
    name: process.env.VERCEL_GIT_COMMIT_SHA,
  },
});
