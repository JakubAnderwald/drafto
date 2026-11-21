import { describe, expect, it } from "vitest";
import {
  HOSTED_USAGE_RESOURCES,
  hostedResourceLabel,
  hostedUsageReadoutSchema,
  toSnapshotRows,
} from "@/lib/metrics/hosted-usage-readout";

describe("hosted usage readout", () => {
  it("knows the six resources the table allows, each with its dashboard unit", () => {
    expect(
      Object.entries(HOSTED_USAGE_RESOURCES).map(([resource, meta]) => [resource, meta.unit]),
    ).toEqual([
      ["vercel_fast_data_transfer", "GB"],
      ["vercel_cdn_requests", "count"],
      ["vercel_function_invocations", "count"],
      ["vercel_active_cpu", "hours"],
      ["supabase_egress", "GB"],
      ["supabase_cached_egress", "GB"],
    ]);
  });

  it("accepts a full readout at the plausibility limits", () => {
    const readings = [
      { resource: "vercel_fast_data_transfer", used: 100_000 },
      { resource: "vercel_cdn_requests", used: 1e10 },
      { resource: "vercel_active_cpu", used: 0 },
    ];
    expect(hostedUsageReadoutSchema.safeParse({ readings }).success).toBe(true);
    expect(
      hostedUsageReadoutSchema.safeParse({
        readings: [{ resource: "vercel_fast_data_transfer", used: 100_001 }],
      }).success,
    ).toBe(false);
  });

  it("maps readings to snapshot rows", () => {
    expect(
      toSnapshotRows({
        readings: [{ resource: "supabase_cached_egress", used: 1.5, periodFrom: "2026-11-01" }],
      }),
    ).toEqual([
      { resource: "supabase_cached_egress", used: 1.5, period_from: "2026-11-01", period_to: null },
    ]);
  });

  it("labels resources for the page", () => {
    expect(hostedResourceLabel("vercel_active_cpu")).toBe("Vercel — Active CPU");
    expect(hostedResourceLabel("supabase_egress")).toBe("Supabase — Egress");
    expect(hostedResourceLabel("something_new")).toBe("something_new");
  });
});
