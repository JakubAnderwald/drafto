import type { HostedUsageLink } from "@/lib/metrics/types";

/**
 * Hosting usage the database can't measure. Checked Nov 21, 2026
 * (docs/features/product-metrics.md → "Hosting usage"):
 * - Supabase's Management API has read-only scoped tokens, but returns request
 *   counts only: no egress (database, storage or cached).
 * - Vercel's `GET /v1/billing/charges` returns per-service usage, but every Vercel
 *   access token can write within its scope; none is read-only.
 * Neither has both the data and a read-only credential, so these rows link to the
 * providers' usage pages instead of fetching.
 */
export const SUPABASE_USAGE_URL = "https://supabase.com/dashboard/org/_/usage";
export const VERCEL_USAGE_URL = "https://vercel.com/jakubanderwalds-projects/~/usage";

export function hostedUsageLinks(): HostedUsageLink[] {
  return [
    {
      provider: "Supabase",
      resources: "Egress (database, storage, cached)",
      href: SUPABASE_USAGE_URL,
    },
    {
      provider: "Vercel",
      resources: "Fast data transfer, function invocations, active CPU, edge requests",
      href: VERCEL_USAGE_URL,
    },
  ];
}
