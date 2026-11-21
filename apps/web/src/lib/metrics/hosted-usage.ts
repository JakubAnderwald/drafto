import type { HostedUsageLink } from "@/lib/metrics/types";

/**
 * Links to the providers' usage pages. Neither provider has an API for these figures on
 * the plans in use (docs/features/product-metrics.md → "Hosting usage"), so the Mac mini
 * reads the pages once a week (ADR 0093) and `metrics_hosted_usage()` serves the readings.
 * The links stay on the page as their source and as the fallback when a reading is stale.
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
