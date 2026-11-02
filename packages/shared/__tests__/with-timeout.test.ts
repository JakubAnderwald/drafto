import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withTimeout } from "../src/async/with-timeout";

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the promise's value when it settles in time", async () => {
    await expect(withTimeout(Promise.resolve("value"), 1_000, "fallback")).resolves.toBe("value");
  });

  it("resolves with the fallback once the time runs out", async () => {
    const pending = withTimeout(new Promise<string>(() => {}), 1_000, "fallback");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe("fallback");
  });

  it("resolves with the fallback when the promise rejects", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1_000, "fallback")).resolves.toBe(
      "fallback",
    );
  });
});
