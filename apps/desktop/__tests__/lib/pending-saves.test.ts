import { renderHook, act } from "@testing-library/react-native";

import { useAutoSave } from "@/hooks/use-auto-save";
import {
  countSavesWritten,
  flushPendingSaves,
  forgetFailedSaves,
  registerPendingSave,
  trackSaveInFlight,
} from "@/lib/pending-saves";

describe("pending saves", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    forgetFailedSaves();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("writes a save still inside the debounce window", async () => {
    const onSave = jest.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useAutoSave<string>({ onSave }));

    act(() => {
      result.current.trigger("latest text");
    });
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      await flushPendingSaves();
    });

    expect(onSave).toHaveBeenCalledWith("latest text");
  });

  it("waits for a save that is already writing", async () => {
    let finishWrite: () => void = () => {};
    const onSave = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishWrite = () => resolve(true);
        }),
    );
    const { result } = renderHook(() => useAutoSave<string>({ onSave }));

    act(() => {
      result.current.trigger("text");
    });
    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    expect(onSave).toHaveBeenCalledTimes(1);

    let flushed = false;
    let flushing: Promise<void> = Promise.resolve();
    act(() => {
      flushing = flushPendingSaves().then(() => {
        flushed = true;
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(flushed).toBe(false);

    await act(async () => {
      finishWrite();
      await flushing;
    });
    expect(flushed).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("forgets an auto-save once it unmounts", async () => {
    const onSave = jest.fn().mockResolvedValue(true);
    const { unmount } = renderHook(() => useAutoSave<string>({ onSave }));
    unmount();
    onSave.mockClear();

    await flushPendingSaves();

    expect(onSave).not.toHaveBeenCalled();
  });

  it("settles even when a flush fails", async () => {
    const unregister = registerPendingSave(() => Promise.reject(new Error("disk full")));

    await expect(flushPendingSaves()).resolves.toBe(false);
    unregister();
  });

  it("reports a write that failed, even after the editor unmounts", async () => {
    const onSave = jest.fn().mockRejectedValue(new Error("disk full"));
    const { result, unmount } = renderHook(() => useAutoSave<string>({ onSave }));

    act(() => {
      result.current.trigger("lost text");
    });
    await act(async () => {
      await expect(flushPendingSaves()).resolves.toBe(false);
    });
    unmount();

    await expect(flushPendingSaves()).resolves.toBe(false);
    forgetFailedSaves();
    await expect(flushPendingSaves()).resolves.toBe(true);
  });

  it("clears a failed write once the same auto-save writes again", async () => {
    const onSave = jest.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(true);
    const { result } = renderHook(() => useAutoSave<string>({ onSave }));

    act(() => {
      result.current.trigger("first");
    });
    await act(async () => {
      await expect(flushPendingSaves()).resolves.toBe(false);
    });

    act(() => {
      result.current.trigger("second");
    });
    await act(async () => {
      await expect(flushPendingSaves()).resolves.toBe(true);
    });
  });

  it("counts writes, but not saves that wrote nothing", async () => {
    const onSave = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { result } = renderHook(() => useAutoSave<string>({ onSave }));
    const before = countSavesWritten();

    act(() => {
      result.current.trigger("edited");
    });
    await act(async () => {
      await flushPendingSaves();
    });
    expect(countSavesWritten()).toBe(before + 1);

    act(() => {
      result.current.trigger("unchanged");
    });
    await act(async () => {
      await flushPendingSaves();
    });
    expect(countSavesWritten()).toBe(before + 1);
  });
  // Two overlapping saves by one auto-save: each resolves or rejects when the test says so.
  function overlappingSaves() {
    const settle: { resolve: (written: boolean) => void; reject: (error: Error) => void }[] = [];
    const onSave = jest.fn(
      () =>
        new Promise<boolean>((resolve, reject) => {
          settle.push({ resolve, reject });
        }),
    );
    const { result } = renderHook(() => useAutoSave<string>({ onSave }));
    return { onSave, result, settle };
  }

  async function startSave(trigger: (value: string) => void, value: string) {
    act(() => {
      trigger(value);
    });
    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
  }

  it("keeps a newer write's failure when an older write finishes after it", async () => {
    const { onSave, result, settle } = overlappingSaves();
    await startSave(result.current.trigger, "older");
    await startSave(result.current.trigger, "newer");
    expect(onSave).toHaveBeenCalledTimes(2);
    const before = countSavesWritten();

    await act(async () => {
      settle[1].reject(new Error("disk full"));
      settle[0].resolve(true);
      await expect(flushPendingSaves()).resolves.toBe(false);
    });
    // The older write still landed, so sign-out still sees that a note changed.
    expect(countSavesWritten()).toBe(before + 1);
    expect(result.current.status).toBe("error");
  });

  it("ignores an older write's failure once a newer write stored the edit", async () => {
    const { result, settle } = overlappingSaves();
    await startSave(result.current.trigger, "older");
    await startSave(result.current.trigger, "newer");

    await act(async () => {
      settle[1].resolve(true);
      settle[0].reject(new Error("busy"));
      await expect(flushPendingSaves()).resolves.toBe(true);
    });
    expect(result.current.status).toBe("saved");
  });

  it("waits for every write still running, not just the latest", async () => {
    const { result, settle } = overlappingSaves();
    await startSave(result.current.trigger, "older");
    await startSave(result.current.trigger, "newer");
    const before = countSavesWritten();

    let flushed = false;
    let flushing: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
      settle[1].resolve(true);
      flushing = flushPendingSaves().finally(() => {
        flushed = true;
      });
      await Promise.resolve();
    });
    expect(flushed).toBe(false);

    await act(async () => {
      settle[0].resolve(true);
      await expect(flushing).resolves.toBe(true);
    });
    expect(countSavesWritten()).toBe(before + 2);
  });

  it("waits for a write an editor started as it unmounted, and reports its failure", async () => {
    let failWrite: () => void = () => {};
    const onSave = jest.fn(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          failWrite = () => reject(new Error("disk full"));
        }),
    );
    const { result, unmount } = renderHook(() => useAutoSave<string>({ onSave }));

    act(() => {
      result.current.trigger("last words");
    });
    // Unmounting flushes the debounced save and leaves the pending-saves registry.
    unmount();
    expect(onSave).toHaveBeenCalledWith("last words");

    let flushed = false;
    const flushing = flushPendingSaves().finally(() => {
      flushed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false);

    failWrite();
    await expect(flushing).resolves.toBe(false);
  });

  it("keeps waiting for a write that starts while it waits", async () => {
    let finishFirst: () => void = () => {};
    let finishSecond: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    trackSaveInFlight(first);

    let flushed = false;
    const flushing = flushPendingSaves().finally(() => {
      flushed = true;
    });
    await Promise.resolve();
    trackSaveInFlight(second);
    finishFirst();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(flushed).toBe(false);

    finishSecond();
    await expect(flushing).resolves.toBe(true);
  });
});
