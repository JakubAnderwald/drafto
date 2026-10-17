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

export const sentryEnvironment = resolveSentryEnvironment(
  process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
  process.env.NODE_ENV,
);

// Local `next dev`, local `next start` and local Playwright runs all report as
// "development" (.env.local sets it). On the Free plan they used up the monthly
// replay quota, so the SDK stays off there and only Vercel deployments report.
export const sentryEnabled = sentryEnvironment !== "development";
