// Shared by the client, server and edge Sentry configs. These load before the
// app (and before `@/env` validation), so they read `process.env` directly — by
// literal name, so Next inlines the NEXT_PUBLIC_ value into the client bundle.

export function resolveSentryEnvironment(
  configured: string | undefined,
  nodeEnv: string | undefined,
): string {
  // Trimmed because a stray newline in the Vercel value ("production\n") splits
  // events into a second environment that `environment:production` never matches.
  return configured?.trim() || (nodeEnv === "production" ? "production" : "development");
}

// Local `next dev` and local Playwright runs (NODE_ENV=development), and local
// `next start` when .env.local sets the environment to "development". On the Free
// plan they used up the monthly replay quota, so the SDK stays off there and only
// Vercel deployments report. The NODE_ENV check keeps `next dev` off even if a
// non-development environment is configured locally.
export function isSentryEnabled(environment: string, nodeEnv: string | undefined): boolean {
  return nodeEnv !== "development" && environment !== "development";
}

export const sentryEnvironment = resolveSentryEnvironment(
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
  process.env.NODE_ENV,
);

export const sentryEnabled = isSentryEnabled(sentryEnvironment, process.env.NODE_ENV);
