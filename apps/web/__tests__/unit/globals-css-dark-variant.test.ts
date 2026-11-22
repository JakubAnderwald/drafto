/**
 * @vitest-environment node
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

/** Tailwind's `dark:` variant follows the in-app `.dark` class, not the OS (#901). */

const WEB_ROOT = path.resolve(__dirname, "../..");
const GLOBALS_PATH = path.join(WEB_ROOT, "src/app/globals.css");
const GLOBALS_CSS = readFileSync(GLOBALS_PATH, "utf8");

async function compile(css: string): Promise<string> {
  const result = await postcss([tailwindcss({ base: WEB_ROOT })]).process(css, {
    from: GLOBALS_PATH,
  });
  return result.css;
}

describe("globals.css dark variant", () => {
  it("declares the class-based dark variant", () => {
    expect(GLOBALS_CSS).toContain("@custom-variant dark (&:where(.dark, .dark *));");
  });

  it("has no hand-written .dark workarounds for the doc-link and brand rules", () => {
    expect(GLOBALS_CSS).not.toMatch(
      /\.dark\s+\.(doc-prose|doc-link|brand-backdrop|brand-wordmark)/,
    );
  });

  it("compiles dark: to the .dark class, never to prefers-color-scheme", async () => {
    const css = await compile(`${GLOBALS_CSS}\n.dark-probe { @apply dark:text-primary-300; }\n`);

    // On Tailwind's default (media) strategy the probe compiles inside a prefers-color-scheme query.
    expect(css).not.toMatch(/prefers-color-scheme[^{]*\{\s*\.dark-probe\b/);
    expect(css).toMatch(/\.dark-probe:where\(\.dark, \.dark \*\)\s*\{\s*color:/);
  }, 30_000);
});
