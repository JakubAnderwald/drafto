import * as Sentry from "@sentry/nextjs";
import { FILE_TOO_LARGE_MESSAGE, FILE_EMPTY_MESSAGE } from "@drafto/shared";
import { sentryEnabled, sentryEnvironment } from "@/lib/sentry-environment";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: sentryEnabled,
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? "dev",
  environment: sentryEnvironment,
  tracesSampleRate: 1,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  integrations: [Sentry.replayIntegration()],
  debug: false,
  // Expected user-input validation, not bugs — keep these out of Sentry.
  ignoreErrors: [FILE_TOO_LARGE_MESSAGE, FILE_EMPTY_MESSAGE],
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
