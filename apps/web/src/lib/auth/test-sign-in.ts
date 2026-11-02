// Gate for `/auth/test-sign-in`, the one-time-link sign-in the factory browser runner uses on a
// PR's Vercel preview (ADR-0051). Claude in Chrome won't type a password on a non-local host, so
// the runner opens a link minted with the dev service-role key instead.

// The dev Supabase project (`drafto-dev`), which serves local dev, Vercel previews, CI and E2E.
// Production is a different project. See docs/architecture/environments.md.
export const DEV_SUPABASE_REF = "huhzactreblzcogqkbsd";

const DEV_SUPABASE_HOST = `${DEV_SUPABASE_REF}.supabase.co`;

export interface TestSignInEnvironment {
  vercelEnv: string | undefined;
  supabaseUrl: string;
}

// Both checks must pass, and each one alone keeps the route off in production: a production
// deployment has VERCEL_ENV=production, and it talks to the prod Supabase project. A local dev
// server (no VERCEL_ENV), an unknown VERCEL_ENV, a malformed URL, or a preview pointed at any
// other Supabase project all get `false`.
export function isTestSignInEnabled({ vercelEnv, supabaseUrl }: TestSignInEnvironment): boolean {
  if (vercelEnv !== "preview") return false;
  try {
    return new URL(supabaseUrl).host === DEV_SUPABASE_HOST;
  } catch {
    return false;
  }
}
