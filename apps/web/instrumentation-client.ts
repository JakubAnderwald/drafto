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
  // captureConsoleIntegration is a backstop (ADR-0099): a console.error that no reportError call
  // replaced still reaches Sentry. reportError never logs in the browser while Sentry is on, so a
  // reported error isn't captured twice.
  integrations: [
    Sentry.replayIntegration(),
    Sentry.captureConsoleIntegration({ levels: ["error"] }),
  ],
  debug: false,
  // Expected user-input validation, not bugs — keep these out of Sentry.
  ignoreErrors: [FILE_TOO_LARGE_MESSAGE, FILE_EMPTY_MESSAGE],
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
