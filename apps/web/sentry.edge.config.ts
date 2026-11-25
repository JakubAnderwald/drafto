import * as Sentry from "@sentry/nextjs";
import { scrubSearchQuery } from "@/lib/sentry/scrub-search-query";
import { sentryEnabled, sentryEnvironment } from "@/lib/sentry-environment";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: sentryEnabled,
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "dev",
  environment: sentryEnvironment,
  tracesSampleRate: 1,
  debug: false,
  // The middleware also runs for /api/notes/search: a report from it would carry the search text
  // in its request URL (ADR-0099).
  beforeSend: (event) => scrubSearchQuery(event),
});
