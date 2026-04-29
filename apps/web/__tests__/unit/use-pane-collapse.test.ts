import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const localStorageStore: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => localStorageStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    localStorageStore[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete localStorageStore[key];
  }),
};
Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });

let usePaneCollapse: typeof import("@/hooks/use-pane-collapse").usePaneCollapse;

describe("usePaneCollapse", () => {
  beforeEach(async () => {
    vi.resetModules();

    // Clear store
    for (const key of Object.keys(localStorageStore)) delete localStorageStore[key];
    localStorageMock.getItem.mockClear();
    localStorageMock.setItem.mockClear();

    const mod = await import("@/hooks/use-pane-collapse");
    usePaneCollapse = mod.usePaneCollapse;
  });

  it("defaults to both panes expanded", () => {
    const { result } = renderHook(() => usePaneCollapse());
    expect(result.current.notebooksCollapsed).toBe(false);
    expect(result.current.notesCollapsed).toBe(false);
  });

  it("reads stored collapse state from localStorage", async () => {
    localStorageStore["pane-collapse"] = JSON.stringify({ notebooks: true, notes: false });
    vi.resetModules();
    const mod = await import("@/hooks/use-pane-collapse");
    const { result } = renderHook(() => mod.usePaneCollapse());
    expect(result.current.notebooksCollapsed).toBe(true);
    expect(result.current.notesCollapsed).toBe(false);
  });

  it("togglePane flips notebooks state and persists", () => {
    const { result } = renderHook(() => usePaneCollapse());

    act(() => {
      result.current.togglePane("notebooks");
    });

    expect(result.current.notebooksCollapsed).toBe(true);
    expect(JSON.parse(localStorage.getItem("pane-collapse") as string)).toEqual({
      notebooks: true,
      notes: false,
    });
  });

  it("togglePane flips notes state and persists", () => {
    const { result } = renderHook(() => usePaneCollapse());

    act(() => {
      result.current.togglePane("notes");
    });

    expect(result.current.notesCollapsed).toBe(true);
    expect(JSON.parse(localStorage.getItem("pane-collapse") as string)).toEqual({
      notebooks: false,
      notes: true,
    });
  });

  it("setPaneCollapsed sets explicit value and persists", () => {
    const { result } = renderHook(() => usePaneCollapse());

    act(() => {
      result.current.setPaneCollapsed("notebooks", true);
    });

    expect(result.current.notebooksCollapsed).toBe(true);

    act(() => {
      result.current.setPaneCollapsed("notebooks", false);
    });

    expect(result.current.notebooksCollapsed).toBe(false);
    expect(JSON.parse(localStorage.getItem("pane-collapse") as string)).toEqual({
      notebooks: false,
      notes: false,
    });
  });

  it("each pane is independently togglable", () => {
    const { result } = renderHook(() => usePaneCollapse());

    act(() => {
      result.current.togglePane("notebooks");
    });
    expect(result.current.notebooksCollapsed).toBe(true);
    expect(result.current.notesCollapsed).toBe(false);

    act(() => {
      result.current.togglePane("notes");
    });
    expect(result.current.notebooksCollapsed).toBe(true);
    expect(result.current.notesCollapsed).toBe(true);

    act(() => {
      result.current.togglePane("notebooks");
    });
    expect(result.current.notebooksCollapsed).toBe(false);
    expect(result.current.notesCollapsed).toBe(true);
  });

  it("ignores invalid JSON in localStorage", async () => {
    localStorageStore["pane-collapse"] = "not-json";
    vi.resetModules();
    const mod = await import("@/hooks/use-pane-collapse");
    const { result } = renderHook(() => mod.usePaneCollapse());
    expect(result.current.notebooksCollapsed).toBe(false);
    expect(result.current.notesCollapsed).toBe(false);
  });

  it("ignores stored shape with wrong types", async () => {
    localStorageStore["pane-collapse"] = JSON.stringify({ notebooks: "yes", notes: 1 });
    vi.resetModules();
    const mod = await import("@/hooks/use-pane-collapse");
    const { result } = renderHook(() => mod.usePaneCollapse());
    expect(result.current.notebooksCollapsed).toBe(false);
    expect(result.current.notesCollapsed).toBe(false);
  });

  it("multiple subscribers see updated state after toggle", () => {
    const { result: a } = renderHook(() => usePaneCollapse());
    const { result: b } = renderHook(() => usePaneCollapse());

    act(() => {
      a.current.togglePane("notebooks");
    });

    expect(a.current.notebooksCollapsed).toBe(true);
    expect(b.current.notebooksCollapsed).toBe(true);
  });
});
