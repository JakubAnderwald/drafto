import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_COLOR } from "@/lib/theme/theme-chrome";

/**
 * `ThemeSync` runs the theme on every page from the root layout, not only those with a theme
 * toggle (#865): it re-adds a dropped `theme-color` meta and follows the OS under "system".
 */

const store = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
  writable: true,
});

let systemDark: boolean;
let osListeners: Array<() => void>;
let ThemeSync: typeof import("@/components/layout/theme-sync").ThemeSync;

function themeColor(): string | undefined {
  return document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content;
}

async function mountWith(stored: string | null): Promise<void> {
  if (stored === null) store.delete("theme");
  else store.set("theme", stored);
  // The theme store reads localStorage once at import.
  vi.resetModules();
  ({ ThemeSync } = await import("@/components/layout/theme-sync"));
  render(<ThemeSync />);
}

describe("ThemeSync", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.documentElement.classList.remove("dark");
    systemDark = false;
    osListeners = [];
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === "(prefers-color-scheme: dark)" ? systemDark : false,
        media: query,
        addEventListener: (_event: string, listener: () => void) => osListeners.push(listener),
        removeEventListener: (_event: string, listener: () => void) => {
          osListeners = osListeners.filter((l) => l !== listener);
        },
      })),
    });
  });

  it("renders nothing", async () => {
    await mountWith(null);
    expect(document.body.querySelector("div")?.innerHTML).toBe("");
  });

  it("adds the theme-color meta when the page has none", async () => {
    await mountWith("dark");

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(themeColor()).toBe(THEME_COLOR.dark);
  });

  it("follows an OS change under system", async () => {
    await mountWith("system");
    expect(themeColor()).toBe(THEME_COLOR.light);

    systemDark = true;
    act(() => osListeners.forEach((listener) => listener()));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(themeColor()).toBe(THEME_COLOR.dark);
  });

  it("ignores an OS change under an explicit theme", async () => {
    await mountWith("light");

    systemDark = true;
    act(() => osListeners.forEach((listener) => listener()));

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(themeColor()).toBe(THEME_COLOR.light);
  });
});
