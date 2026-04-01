import { renderHook, act } from "@testing-library/react-native";

jest.mock("@drafto/shared", () => ({
  DEBOUNCE_MS: 500,
}));

import { useAutoSave } from "@/hooks/use-auto-save";

describe("useAutoSave", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("starts with idle status", () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave({ onSave }));

    expect(result.current.status).toBe("idle");
  });

  it("calls onSave after debounce delay", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave({ onSave, delayMs: 300 }));

    act(() => {
      result.current.trigger("hello");
    });

    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    expect(onSave).toHaveBeenCalledWith("hello");
  });

  it("debounces multiple triggers", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave({ onSave, delayMs: 300 }));

    act(() => {
      result.current.trigger("a");
    });
    act(() => {
      result.current.trigger("ab");
    });
    act(() => {
      result.current.trigger("abc");
    });

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("abc");
  });

  it("sets status to saving then saved on success", async () => {
    let resolvePromise: () => void;
    const savePromise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    const onSave = jest.fn().mockReturnValue(savePromise);

    const { result } = renderHook(() => useAutoSave({ onSave, delayMs: 100 }));

    act(() => {
      result.current.trigger("data");
    });

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    expect(result.current.status).toBe("saving");

    await act(async () => {
      resolvePromise!();
    });

    expect(result.current.status).toBe("saved");
  });

  it("sets status to error on save failure", async () => {
    const onSave = jest.fn().mockRejectedValue(new Error("Save failed"));
    const { result } = renderHook(() => useAutoSave({ onSave, delayMs: 100 }));

    act(() => {
      result.current.trigger("data");
    });

    await act(async () => {
      jest.advanceTimersByTime(100);
    });

    expect(result.current.status).toBe("error");
  });

  it("flush triggers immediate save", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave({ onSave, delayMs: 5000 }));

    act(() => {
      result.current.trigger("urgent");
    });

    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      result.current.flush();
    });

    expect(onSave).toHaveBeenCalledWith("urgent");
  });

  it("cancel prevents pending save", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave({ onSave, delayMs: 300 }));

    act(() => {
      result.current.trigger("data");
    });

    act(() => {
      result.current.cancel();
    });

    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    expect(onSave).not.toHaveBeenCalled();
  });

  it("flush does nothing when no pending save", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useAutoSave({ onSave }));

    await act(async () => {
      result.current.flush();
    });

    expect(onSave).not.toHaveBeenCalled();
  });
});
