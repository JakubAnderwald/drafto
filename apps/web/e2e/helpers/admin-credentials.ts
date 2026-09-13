export const ADMIN_E2E_SKIP_REASON =
  "E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD and SUPABASE_SERVICE_ROLE_KEY are not all set";

export interface AdminCredentials {
  email: string;
  password: string;
}

/**
 * Credentials for the optional admin E2E specs, or null when they can't run.
 *
 * Needs a separate approved admin account (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD)
 * and the dev project's SUPABASE_SERVICE_ROLE_KEY for the web server: /admin
 * builds a service-role client on every render and errors without it.
 */
export function getAdminCredentials(): AdminCredentials | null {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;

  if (!email || !password || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { email, password };
}
