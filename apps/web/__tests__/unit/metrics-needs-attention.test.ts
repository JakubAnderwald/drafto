import { describe, expect, it } from "vitest";
import { deriveNeedsAttention } from "@/lib/metrics/needs-attention";
import type { HostedUsageRow, PlatformLimitRow } from "@/lib/metrics/rpc-schemas";
import type { ProductMetrics } from "@/lib/metrics/types";

const limit = (
  resource: string,
  pct: number,
  level: PlatformLimitRow["level"],
): PlatformLimitRow => ({
  resource,
  used_bytes: pct,
  limit_bytes: 100,
  pct,
  level,
});

const note = {
  note_id: "11111111-1111-4111-8111-111111111111",
  user_id: "22222222-2222-4222-8222-222222222222",
  emptied_at: "2026-11-18T10:00:00+00:00",
  client: "web",
  chars_before: 300,
};

describe("deriveNeedsAttention", () => {
  it("is clear when every check ran and found nothing", () => {
    const result = deriveNeedsAttention({
      emptiedNotes: { status: "ok", data: [] },
      platformLimits: { status: "ok", data: [limit("database", 20, "ok")] },
      hostedReadings: { status: "ok", data: [] },
    });
    expect(result).toEqual({
      emptiedNotes: [],
      limits: [],
      hostedLimits: [],
      readoutStaleSince: null,
      unchecked: [],
      isClear: true,
    });
  });

  it("lists emptied notes and limits at warn or critical, worst first", () => {
    const result = deriveNeedsAttention({
      emptiedNotes: { status: "ok", data: [note] },
      platformLimits: {
        status: "ok",
        data: [
          limit("database", 72, "warn"),
          limit("storage", 90, "critical"),
          limit("x", 75, "warn"),
          limit("y", 10, "ok"),
        ],
      },
      hostedReadings: { status: "ok", data: [] },
    });
    expect(result.emptiedNotes).toEqual([note]);
    expect(result.limits.map((l) => l.resource)).toEqual(["storage", "x", "database"]);
    expect(result.isClear).toBe(false);
  });

  it("never claims clear when a check couldn't run", () => {
    const result = deriveNeedsAttention({
      emptiedNotes: { status: "error", message: "boom" },
      platformLimits: { status: "unavailable" },
      hostedReadings: { status: "unavailable" },
    });
    expect(result.unchecked).toEqual([
      { check: "Emptied notes", reason: "boom" },
      { check: "Platform limits", reason: "the function isn't on this database" },
    ]);
    expect(result.isClear).toBe(false);
  });

  describe("hosting usage (ADR 0093)", () => {
    const reading = (
      resource: string,
      pct: number,
      level: HostedUsageRow["level"],
      stale = false,
    ): HostedUsageRow => ({
      provider: "vercel",
      resource,
      unit: "hours",
      used: (4 * pct) / 100,
      limit_value: 4,
      pct,
      level,
      period_from: null,
      period_to: null,
      captured_at: "2026-11-15T19:00:00+00:00",
      stale,
    });
    const base: Pick<ProductMetrics, "emptiedNotes" | "platformLimits"> = {
      emptiedNotes: { status: "ok", data: [] },
      platformLimits: { status: "ok", data: [] },
    };

    it("flags readings at warn or critical, worst first", () => {
      const result = deriveNeedsAttention({
        ...base,
        hostedReadings: {
          status: "ok",
          data: [reading("a", 72, "warn"), reading("b", 90, "critical"), reading("c", 10, "ok")],
        },
      });
      expect(result.hostedLimits.map((r) => r.resource)).toEqual(["b", "a"]);
      expect(result.readoutStaleSince).toBeNull();
      expect(result.isClear).toBe(false);
    });

    it("flags a readout that hasn't run, not one resource that dropped out", () => {
      const dropped = deriveNeedsAttention({
        ...base,
        hostedReadings: {
          status: "ok",
          data: [reading("a", 10, "ok"), reading("c", 10, "ok", true)],
        },
      });
      expect(dropped.readoutStaleSince).toBeNull();
      expect(dropped.isClear).toBe(true);

      const older = { ...reading("a", 10, "ok", true), captured_at: "2026-11-01T19:00:00+00:00" };
      const allStale = deriveNeedsAttention({
        ...base,
        hostedReadings: { status: "ok", data: [older, reading("c", 10, "ok", true)] },
      });
      expect(allStale.readoutStaleSince).toBe("2026-11-15T19:00:00+00:00");
      expect(allStale.isClear).toBe(false);
    });

    it("is clear with fresh readings below 70%, and with no readout set up", () => {
      expect(
        deriveNeedsAttention({
          ...base,
          hostedReadings: { status: "ok", data: [reading("a", 50, "ok")] },
        }).isClear,
      ).toBe(true);
      expect(
        deriveNeedsAttention({ ...base, hostedReadings: { status: "unavailable" } }).isClear,
      ).toBe(true);
    });

    it("lists a failing readout as unchecked", () => {
      const result = deriveNeedsAttention({
        ...base,
        hostedReadings: { status: "error", message: "metrics_hosted_usage failed: timeout" },
      });
      expect(result.unchecked).toEqual([
        { check: "Hosting usage", reason: "metrics_hosted_usage failed: timeout" },
      ]);
      expect(result.isClear).toBe(false);
    });
  });
});
