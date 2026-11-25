import * as Sentry from "@sentry/nextjs";
import { flushErrorsBeforeVercelFreezes } from "@/lib/sentry/flush-errors-on-vercel";
import { scrubAppleGrantRequest } from "@/lib/sentry/scrub-apple-grant";
import { scrubSearchQuery } from "@/lib/sentry/scrub-search-query";
import { sentryEnabled, sentryEnvironment } from "@/lib/sentry-environment";

const client = Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: sentryEnabled,
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "dev",
  environment: sentryEnvironment,
  tracesSampleRate: 1,
  debug: false,
  // Sign in with Apple codes travel in /api/account's body and the relay's form post. A failed
  // search's report would carry the search text in its request URL (ADR-0099).
  beforeSend: (event) => scrubSearchQuery(scrubAppleGrantRequest(event)),
  beforeSendTransaction: (event) => scrubAppleGrantRequest(event),
});

// Without this a Vercel function is frozen before a caught error's report is sent (ADR-0099).
flushErrorsBeforeVercelFreezes(client);
