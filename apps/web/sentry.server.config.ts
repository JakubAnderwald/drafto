import * as Sentry from "@sentry/nextjs";
import { scrubAppleGrantRequest } from "@/lib/sentry/scrub-apple-grant";
import { sentryEnabled, sentryEnvironment } from "@/lib/sentry-environment";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: sentryEnabled,
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "dev",
  environment: sentryEnvironment,
  tracesSampleRate: 1,
  debug: false,
  // Sign in with Apple codes travel in /api/account's body and the relay's form post.
  beforeSend: (event) => scrubAppleGrantRequest(event),
  beforeSendTransaction: (event) => scrubAppleGrantRequest(event),
});
