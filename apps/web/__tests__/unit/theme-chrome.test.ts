import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildThemeBootstrapScript,
  syncThemeColorMeta,
  THEME_COLOR,
  THEME_STORAGE_KEY,
} from "@/lib/theme/theme-chrome";

/** The browser chrome follows the in-app theme, not the OS (#865). */

// jsdom here has no usable localStorage; the other theme tests stub it the same way.
const store = new Map<string, string>();
const localStorageStub = {
  getItem: vi.fn((key: string) => store.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => void store.set(key, value)),
  clear: () => store.clear(),
};
Object.defineProperty(window, "localStorage", { value: localStorageStub, writable: true });

const GLOBALS_CSS = readFileSync(path.resolve(__dirname, "../../src/app/globals.css"), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = GLOBALS_CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`no ${selector} rule in globals.css`);
  return match[1];
}

function declaration(body: string, property: string): string | undefined {
  return body.match(new RegExp(`(?:^|[\\s;])${property}:\\s*([^;]+);`))?.[1].trim();
}

function addThemeColorMeta(): HTMLMetaElement {
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = THEME_COLOR.light;
  document.head.appendChild(meta);
  return meta;
}

function mockSystemDark(dark: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(prefers-color-scheme:dark)" ? dark : false,
      media: query,
    })),
  });
}

function runBootstrap(): void {
  // The same text the root layout puts in its nonce'd `<script>`.
  new Function(buildThemeBootstrapScript())();
}

afterEach(() => {
  document.head.innerHTML = "";
  document.documentElement.classList.remove("dark");
  localStorage.clear();
});

describe("globals.css", () => {
  it("sets color-scheme from the .dark class", () => {
    expect(declaration(ruleBody(":root"), "color-scheme")).toBe("light");
    expect(declaration(ruleBody(".dark"), "color-scheme")).toBe("dark");
  });

  it("has the --bg values THEME_COLOR uses", () => {
    expect(declaration(ruleBody(":root"), "--bg")).toBe(THEME_COLOR.light);
    expect(declaration(ruleBody(".dark"), "--bg")).toBe(THEME_COLOR.dark);
  });
});

describe("syncThemeColorMeta", () => {
  it("sets the meta to the resolved theme's background", () => {
    const meta = addThemeColorMeta();

    syncThemeColorMeta("dark");
    expect(meta.content).toBe(THEME_COLOR.dark);

    syncThemeColorMeta("light");
    expect(meta.content).toBe(THEME_COLOR.light);
  });

  it("adds the meta when the page has none", () => {
    syncThemeColorMeta("dark");

    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    expect(metas).toHaveLength(1);
    expect(metas[0].content).toBe(THEME_COLOR.dark);
  });
});

describe("buildThemeBootstrapScript", () => {
  beforeEach(() => {
    mockSystemDark(false);
  });

  it.each([
    { stored: "dark", systemDark: false, dark: true },
    { stored: "light", systemDark: true, dark: false },
    { stored: "system", systemDark: true, dark: true },
    { stored: "system", systemDark: false, dark: false },
    { stored: null, systemDark: true, dark: true },
  ])(
    "stored $stored with the OS dark=$systemDark sets dark=$dark",
    ({ stored, systemDark, dark }) => {
      if (stored !== null) localStorage.setItem(THEME_STORAGE_KEY, stored);
      mockSystemDark(systemDark);
      const meta = addThemeColorMeta();

      runBootstrap();

      expect(document.documentElement.classList.contains("dark")).toBe(dark);
      expect(meta.content).toBe(dark ? THEME_COLOR.dark : THEME_COLOR.light);
    },
  );

  it("adds the meta when the page has none, and only one", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");

    runBootstrap();
    runBootstrap();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    expect(metas).toHaveLength(1);
    expect(metas[0].content).toBe(THEME_COLOR.dark);
  });

  it("treats a missing matchMedia as light, and still adds the meta", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: undefined,
    });
    localStorage.setItem(THEME_STORAGE_KEY, "system");

    expect(runBootstrap).not.toThrow();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe(
      THEME_COLOR.light,
    );
  });

  it("falls back to the OS theme when storage throws", () => {
    mockSystemDark(true);
    localStorageStub.getItem.mockImplementationOnce(() => {
      throw new Error("blocked");
    });
    const meta = addThemeColorMeta();

    expect(runBootstrap).not.toThrow();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(meta.content).toBe(THEME_COLOR.dark);
  });
});
