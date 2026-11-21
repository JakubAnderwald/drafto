import { z } from "zod";

/**
 * The hosting-usage readout (ADR 0093): what the Mac mini's weekly read of the
 * Vercel and Supabase usage dashboards posts to `/api/cron/hosted-usage`.
 *
 * Each reading is in the unit its dashboard shows, the unit
 * `metrics_hosted_usage()` holds the limit in (20261121000002_hosted_usage_snapshots.sql).
 * The resource list matches the table's check constraint; change both together.
 */
export const HOSTED_USAGE_RESOURCES = {
  vercel_fast_data_transfer: { provider: "Vercel", label: "Fast data transfer", unit: "GB" },
  vercel_cdn_requests: { provider: "Vercel", label: "CDN requests", unit: "count" },
  vercel_function_invocations: { provider: "Vercel", label: "Function invocations", unit: "count" },
  vercel_active_cpu: { provider: "Vercel", label: "Active CPU", unit: "hours" },
  supabase_egress: { provider: "Supabase", label: "Egress", unit: "GB" },
  supabase_cached_egress: { provider: "Supabase", label: "Cached egress", unit: "GB" },
} as const;

export type HostedUsageResource = keyof typeof HOSTED_USAGE_RESOURCES;
export type HostedUsageUnit = (typeof HOSTED_USAGE_RESOURCES)[HostedUsageResource]["unit"];

const RESOURCE_NAMES = Object.keys(HOSTED_USAGE_RESOURCES) as [
  HostedUsageResource,
  ...HostedUsageResource[],
];

/** Far above any plan in use: a bigger figure is a misread, not usage. */
const MAX_USED: Record<HostedUsageUnit, number> = { GB: 100_000, count: 1e10, hours: 10_000 };

// A real calendar date (2026-02-30 fails here, not at the insert).
const isoDate = z.iso.date();

const readingSchema = z
  .object({
    resource: z.enum(RESOURCE_NAMES),
    used: z.number().finite().nonnegative(),
    periodFrom: isoDate.optional(),
    periodTo: isoDate.optional(),
  })
  .strict()
  .refine((r) => r.used <= MAX_USED[HOSTED_USAGE_RESOURCES[r.resource].unit], {
    message: "used is implausibly large for its unit",
    path: ["used"],
  })
  .refine((r) => !r.periodFrom || !r.periodTo || r.periodFrom <= r.periodTo, {
    message: "periodFrom is after periodTo",
    path: ["periodFrom"],
  });

/** One readout: up to one reading per resource. */
export const hostedUsageReadoutSchema = z
  .object({ readings: z.array(readingSchema).min(1).max(RESOURCE_NAMES.length) })
  .strict()
  .refine((b) => new Set(b.readings.map((r) => r.resource)).size === b.readings.length, {
    message: "each resource may appear once",
    path: ["readings"],
  });

export type HostedUsageReadout = z.infer<typeof hostedUsageReadoutSchema>;

/** "Vercel — Active CPU" for a known resource; the raw name otherwise. */
export function hostedResourceLabel(resource: string): string {
  const meta = (HOSTED_USAGE_RESOURCES as Record<string, { provider: string; label: string }>)[
    resource
  ];
  return meta ? `${meta.provider} — ${meta.label}` : resource;
}

/** The table rows a readout becomes (`captured_at` is the insert time). */
export function toSnapshotRows(readout: HostedUsageReadout) {
  return readout.readings.map((r) => ({
    resource: r.resource,
    used: r.used,
    period_from: r.periodFrom ?? null,
    period_to: r.periodTo ?? null,
  }));
}
