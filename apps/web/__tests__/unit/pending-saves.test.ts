import { describe, expect, it, vi, afterEach } from "vitest";
import { flushPendingSaves, registerPendingSaveFlusher } from "@/lib/pending-saves";

describe("pending-saves registry", () => {
  const unregisters: Array<() => void> = [];

  function register(flusher: () => Promise<void> | void) {
    const unregister = registerPendingSaveFlusher(flusher);
    unregisters.push(unregister);
    return unregister;
  }

  afterEach(() => {
    unregisters.splice(0).forEach((unregister) => unregister());
    vi.useRealTimers();
  });

  it("resolves at once when nothing is registered", async () => {
    await expect(flushPendingSaves()).resolves.toBeUndefined();
  });

  it("runs every registered flusher and waits for them", async () => {
    const order: string[] = [];
    register(async () => {
      await Promise.resolve();
      order.push("a");
    });
    register(() => {
      order.push("b");
    });

    await flushPendingSaves();

    expect(order.sort()).toEqual(["a", "b"]);
  });

  it("no longer runs a flusher once it is unregistered", async () => {
    const flusher = vi.fn();
    const unregister = register(flusher);
    unregister();

    await flushPendingSaves();

    expect(flusher).not.toHaveBeenCalled();
  });

  it("stops waiting at the timeout", async () => {
    vi.useFakeTimers();
    register(() => new Promise<void>(() => {}));

    let done = false;
    const flushed = flushPendingSaves({ timeoutMs: 100 }).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await flushed;
    expect(done).toBe(true);
  });

  it("never throws, whether a flusher rejects or throws synchronously", async () => {
    const after = vi.fn();
    register(() => Promise.reject(new Error("offline")));
    register(() => {
      throw new Error("boom");
    });
    register(after);

    await expect(flushPendingSaves()).resolves.toBeUndefined();
    expect(after).toHaveBeenCalled();
  });
});
