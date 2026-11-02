import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    SENTRY_AUTH_TOKEN: z.string().optional(),
    CRON_SECRET: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
    RESEND_API_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.string().min(1).default("Drafto <hello@drafto.eu>"),
    EMAIL_ADMIN_FALLBACK: z.string().email().default("jakub@anderwald.info"),
    APPROVAL_LINK_SECRET: z.string().min(32).optional(),
    APP_URL: z.string().url(),
    WEBHOOK_SECRET: z.string().min(16).optional(),
    // Sign in with Apple key, used to revoke a user's Apple tokens when they delete their
    // account. Revocation runs only when all three are set. The private key is the `.p8` PEM;
    // literal "\n" escapes are accepted too (see src/lib/apple/config.ts).
    APPLE_TEAM_ID: z.string().min(1).optional(),
    APPLE_SIGN_IN_KEY_ID: z.string().min(1).optional(),
    APPLE_SIGN_IN_PRIVATE_KEY: z.string().min(1).optional(),
    // Vercel system variable naming the deployment's environment. Not set locally. Gates the
    // preview-only `/auth/test-sign-in` route (src/lib/auth/test-sign-in.ts).
    // Vercel system variable. Deliberately not an enum: an unexpected value must not fail env
    // validation for the whole app; only `isTestSignInEnabled` reads it, and it accepts
    // exactly "preview".
    VERCEL_ENV: z.string().optional(),
    // Vercel system variable: the commit SHA the deployment was built from. Not set locally.
    // Read through `getBuildCommit` (src/lib/build-info.ts) for `/api/health` and the Settings
    // build line. A plain optional string, so an odd value can't fail env validation for the app.
    VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  },
  client: {
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
    NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
    NEXT_PUBLIC_POSTHOG_HOST: z.string().optional(),
    NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: z.string().optional(),
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: z.string().optional(),
  },
  runtimeEnv: {
    CRON_SECRET: process.env.CRON_SECRET,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM: process.env.EMAIL_FROM,
    EMAIL_ADMIN_FALLBACK: process.env.EMAIL_ADMIN_FALLBACK,
    APPROVAL_LINK_SECRET: process.env.APPROVAL_LINK_SECRET,
    APP_URL: process.env.APP_URL,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    APPLE_TEAM_ID: process.env.APPLE_TEAM_ID,
    APPLE_SIGN_IN_KEY_ID: process.env.APPLE_SIGN_IN_KEY_ID,
    APPLE_SIGN_IN_PRIVATE_KEY: process.env.APPLE_SIGN_IN_PRIVATE_KEY,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
  },
  skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
});
