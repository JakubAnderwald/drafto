import { describe, expect, it } from "vitest";
import { deriveNeedsAttention } from "@/lib/metrics/needs-attention";
import type { PlatformLimitRow } from "@/lib/metrics/rpc-schemas";

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
    });
    expect(result).toEqual({ emptiedNotes: [], limits: [], unchecked: [], isClear: true });
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
    });
    expect(result.emptiedNotes).toEqual([note]);
    expect(result.limits.map((l) => l.resource)).toEqual(["storage", "x", "database"]);
    expect(result.isClear).toBe(false);
  });

  it("never claims clear when a check couldn't run", () => {
    const result = deriveNeedsAttention({
      emptiedNotes: { status: "error", message: "boom" },
      platformLimits: { status: "unavailable" },
    });
    expect(result.unchecked).toEqual([
      { check: "Emptied notes", reason: "boom" },
      { check: "Platform limits", reason: "the function isn't on this database" },
    ]);
    expect(result.isClear).toBe(false);
  });
});
