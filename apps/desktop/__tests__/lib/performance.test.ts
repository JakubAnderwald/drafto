// @ts-expect-error — __DEV__ is a React Native global, define for tests
globalThis.__DEV__ = true;

import {
  mark,
  measure,
  measureAsync,
  markStartupBegin,
  markStartupEnd,
  getMarks,
  getMeasurements,
  getStartupDuration,
  clearPerformanceData,
} from "@/lib/performance";

describe("performance utilities", () => {
  beforeEach(() => {
    clearPerformanceData();
  });

  describe("mark / measure", () => {
    it("records marks and measures duration between them", () => {
      const now = 1000000;
      const spy = jest.spyOn(Date, "now").mockReturnValue(now);

      mark("start");

      spy.mockReturnValue(now + 100);
      mark("end");

      const duration = measure("test-op", "start", "end");

      expect(duration).toBe(100);
      expect(getMarks()).toHaveLength(2);
      expect(getMeasurements()).toHaveLength(1);
      expect(getMeasurements()[0]).toEqual({ label: "test-op", durationMs: 100 });

      spy.mockRestore();
    });

    it("returns null when marks are missing", () => {
      mark("only-one");
      const duration = measure("test", "only-one", "missing");
      expect(duration).toBeNull();
    });
  });

  describe("measureAsync", () => {
    it("measures async function duration", async () => {
      const result = await measureAsync("async-op", async () => {
        return 42;
      });

      expect(result).toBe(42);
      expect(getMeasurements().find((m) => m.label === "async-op")).toBeDefined();
    });

    it("records measurement even when function throws", async () => {
      await expect(
        measureAsync("fail-op", async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow("fail");

      expect(getMeasurements().find((m) => m.label === "fail-op")).toBeDefined();
    });
  });

  describe("startup tracking", () => {
    it("measures startup duration", () => {
      const now = 1000000;
      const spy = jest.spyOn(Date, "now").mockReturnValue(now);

      markStartupBegin();

      spy.mockReturnValue(now + 500);
      markStartupEnd();

      expect(getStartupDuration()).toBe(500);

      spy.mockRestore();
    });

    it("returns null when startup not tracked", () => {
      expect(getStartupDuration()).toBeNull();
    });
  });

  describe("clearPerformanceData", () => {
    it("clears all marks and measurements", () => {
      mark("test");
      markStartupBegin();

      clearPerformanceData();

      expect(getMarks()).toHaveLength(0);
      expect(getMeasurements()).toHaveLength(0);
      expect(getStartupDuration()).toBeNull();
    });
  });
});
