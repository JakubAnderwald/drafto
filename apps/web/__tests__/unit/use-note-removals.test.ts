import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useNoteRemovals } from "@/hooks/use-note-removals";

function setup() {
  const onRemoved = vi.fn();
  const onRefresh = vi.fn();
  const { result } = renderHook(() => useNoteRemovals({ onRemoved, onRefresh }));
  return { onRemoved, onRefresh, removals: result.current };
}

describe("useNoteRemovals", () => {
  it("selects the first remaining note and refreshes once a lone removal lands", () => {
    const { onRemoved, onRefresh, removals } = setup();

    removals.beginRemoval("a");
    expect(onRemoved).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();

    removals.settleRemoval("a", ["b", "c"], "removed");

    expect(onRemoved).toHaveBeenCalledOnce();
    expect(onRemoved).toHaveBeenCalledWith("a", "b");
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("passes null when no note is left", () => {
    const { onRemoved, removals } = setup();

    removals.beginRemoval("a");
    removals.settleRemoval("a", [], "removed");

    expect(onRemoved).toHaveBeenCalledWith("a", null);
  });

  it("skips a note whose own removal is still in flight", () => {
    const { onRemoved, onRefresh, removals } = setup();

    removals.beginRemoval("a");
    removals.beginRemoval("b");
    removals.settleRemoval("a", ["b", "c"], "removed");

    expect(onRemoved).toHaveBeenCalledWith("a", "c");
    // "b" is still in flight: a refetch now could return it.
    expect(onRefresh).not.toHaveBeenCalled();

    removals.settleRemoval("b", ["c"], "removed");

    expect(onRemoved).toHaveBeenLastCalledWith("b", "c");
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("skips a note whose removal landed first, while another is still in flight", () => {
    const { onRemoved, onRefresh, removals } = setup();

    removals.beginRemoval("a");
    removals.beginRemoval("b");
    removals.settleRemoval("b", ["c"], "removed");
    expect(onRefresh).not.toHaveBeenCalled();

    // "a" was removed when "b" was still listed after it.
    removals.settleRemoval("a", ["b", "c"], "removed");

    expect(onRemoved).toHaveBeenLastCalledWith("a", "c");
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("only refreshes when a removal fails, and the failed note can be selected again", () => {
    const { onRemoved, onRefresh, removals } = setup();

    removals.beginRemoval("a");
    removals.beginRemoval("b");
    removals.settleRemoval("a", ["b", "c"], "failed");

    expect(onRemoved).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();

    // The list showed "a" again before "b" was removed.
    removals.settleRemoval("b", ["a", "c"], "removed");

    expect(onRemoved).toHaveBeenCalledWith("b", "a");
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("does nothing when the session expired", () => {
    const { onRemoved, onRefresh, removals } = setup();

    removals.beginRemoval("a");
    removals.settleRemoval("a", ["b"], "signed-out");

    expect(onRemoved).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("still refreshes for earlier removals when the last one finds the session expired", () => {
    const { onRefresh, removals } = setup();

    removals.beginRemoval("a");
    removals.beginRemoval("b");
    removals.settleRemoval("a", ["b"], "removed");
    removals.settleRemoval("b", [], "signed-out");

    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("forgets removed notes once nothing is in flight", () => {
    const { onRemoved, onRefresh, removals } = setup();

    removals.beginRemoval("b");
    removals.settleRemoval("b", ["c"], "removed");

    // "b" was restored from the trash later and is listed again.
    removals.beginRemoval("a");
    removals.settleRemoval("a", ["b", "c"], "removed");

    expect(onRemoved).toHaveBeenLastCalledWith("a", "b");
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("returns the same functions across renders", () => {
    const onRemoved = vi.fn();
    const onRefresh = vi.fn();
    const { result, rerender } = renderHook(() => useNoteRemovals({ onRemoved, onRefresh }));
    const first = result.current;

    rerender();

    expect(result.current.beginRemoval).toBe(first.beginRemoval);
    expect(result.current.settleRemoval).toBe(first.settleRemoval);
  });
});
