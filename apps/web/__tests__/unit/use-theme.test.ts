import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock localStorage for jsdom
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

// Reset module state between tests
let useTheme: typeof import("@/hooks/use-theme").useTheme;

describe("useTheme", () => {
  let matchMediaListeners: Array<(e: { matches: boolean }) => void>;
  let darkMatches: boolean;

  beforeEach(async () => {
    vi.resetModules();

    matchMediaListeners = [];
    darkMatches = false;

    // Clear theme from localStorage
    delete localStorageStore["theme"];
    localStorageMock.getItem.mockClear();
    localStorageMock.setItem.mockClear();

    // Mock matchMedia
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(prefers-color-scheme: dark)" ? darkMatches : false,
        media: query,
        addEventListener: vi.fn((_event: string, handler: (e: { matches: boolean }) => void) => {
          matchMediaListeners.push(handler);
        }),
        removeEventListener: vi.fn((_event: string, handler: (e: { matches: boolean }) => void) => {
          matchMediaListeners = matchMediaListeners.filter((l) => l !== handler);
        }),
      })),
    });

    // Remove dark class
    document.documentElement.classList.remove("dark");

    const mod = await import("@/hooks/use-theme");
    useTheme = mod.useTheme;
  });

  afterEach(() => {
    document.documentElement.classList.remove("dark");
  });

  it("defaults to system theme when no localStorage value", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("system");
  });

  it("resolves system theme to light when prefers-color-scheme is light", () => {
    darkMatches = false;
    const { result } = renderHook(() => useTheme());
    expect(result.current.resolvedTheme).toBe("light");
  });

  it("reads stored theme from localStorage", async () => {
    localStorage.setItem("theme", "dark");
    vi.resetModules();
    const mod = await import("@/hooks/use-theme");
    const { result } = renderHook(() => mod.useTheme());
    expect(result.current.theme).toBe("dark");
    expect(result.current.resolvedTheme).toBe("dark");
  });

  it("applies dark class to html element when theme is dark", async () => {
    localStorage.setItem("theme", "dark");
    vi.resetModules();
    const mod = await import("@/hooks/use-theme");
    renderHook(() => mod.useTheme());
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("does not apply dark class when theme is light", () => {
    renderHook(() => useTheme());
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("setTheme updates the theme and persists to localStorage", () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setTheme("dark");
    });

    expect(result.current.theme).toBe("dark");
    expect(result.current.resolvedTheme).toBe("dark");
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("setTheme to light removes dark class", () => {
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setTheme("dark");
    });
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    act(() => {
      result.current.setTheme("light");
    });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(result.current.theme).toBe("light");
  });

  it("setTheme to system resolves based on media query", async () => {
    darkMatches = true;
    vi.resetModules();
    const mod = await import("@/hooks/use-theme");

    const { result } = renderHook(() => mod.useTheme());

    act(() => {
      result.current.setTheme("system");
    });

    expect(result.current.theme).toBe("system");
    expect(result.current.resolvedTheme).toBe("dark");
  });

  it("cycles through themes correctly", () => {
    const { result } = renderHook(() => useTheme());

    // default is system
    expect(result.current.theme).toBe("system");

    act(() => {
      result.current.setTheme("light");
    });
    expect(result.current.theme).toBe("light");

    act(() => {
      result.current.setTheme("dark");
    });
    expect(result.current.theme).toBe("dark");

    act(() => {
      result.current.setTheme("system");
    });
    expect(result.current.theme).toBe("system");
  });

  it("ignores invalid localStorage values", async () => {
    localStorage.setItem("theme", "invalid");
    vi.resetModules();
    const mod = await import("@/hooks/use-theme");
    const { result } = renderHook(() => mod.useTheme());
    expect(result.current.theme).toBe("system");
  });
});
