import { renderHook, act } from "@testing-library/react-native";

import { useAutoSave } from "@/hooks/use-auto-save";
import { flushPendingSaves, registerPendingSave } from "@/lib/pending-saves";

describe("pending saves", () => {
  beforeEach(() => {
    jest.useFakeTimers();
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

    await expect(flushPendingSaves()).resolves.toBeUndefined();
    unregister();
  });
});
