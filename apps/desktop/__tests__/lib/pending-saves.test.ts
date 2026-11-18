import { renderHook, act } from "@testing-library/react-native";

import { useAutoSave } from "@/hooks/use-auto-save";
import {
  countSavesWritten,
  flushPendingSaves,
  forgetFailedSaves,
  registerPendingSave,
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
});
