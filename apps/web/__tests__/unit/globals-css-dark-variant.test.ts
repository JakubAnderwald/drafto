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

  it("has no hand-written .dark workarounds for the doc-link, brand and theme-only rules", () => {
    expect(GLOBALS_CSS).not.toMatch(
      /\.dark\s+\.(doc-prose|doc-link|ui-link|brand-backdrop|brand-wordmark|theme-light-only|theme-dark-only)/,
    );
  });

  it("gives .ui-link primary-600/700 in light mode and primary-300/200 under .dark (#910)", async () => {
    const css = await compile(GLOBALS_CSS);
    const shade = (n: number) => {
      const value = GLOBALS_CSS.match(new RegExp(`--color-primary-${n}:\\s*([^;]+);`))?.[1];
      if (!value) throw new Error(`--color-primary-${n} is not declared`);
      return value.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    };

    // Tailwind emits the rule nested: `.ui-link { color; &:hover { @media (hover: hover) {…} } … }`.
    const start = css.indexOf(".ui-link {");
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = css.indexOf("{", start);
    do {
      if (css[end] === "{") depth++;
      if (css[end] === "}") depth--;
      end++;
    } while (depth > 0 && end < css.length);
    const block = css.slice(start, end);

    const hover = (color: string) =>
      `&:hover\\s*\\{\\s*@media \\(hover: hover\\)\\s*\\{\\s*color: ${color};`;
    const dark = "&:where\\(\\.dark, \\.dark \\*\\)\\s*\\{\\s*";
    expect(block).toMatch(new RegExp(`^\\.ui-link \\{\\s*color: ${shade(600)};`));
    expect(block).toMatch(new RegExp(`^\\.ui-link \\{\\s*color: [^;]+;\\s*${hover(shade(700))}`));
    expect(block).toMatch(new RegExp(`${dark}color: ${shade(300)};`));
    expect(block).toMatch(new RegExp(`${dark}${hover(shade(200))}`));
    // Dark hover comes after light hover, so it wins at equal specificity.
    expect(block.search(new RegExp(hover(shade(200))))).toBeGreaterThan(
      block.search(new RegExp(hover(shade(700)))),
    );
    expect(css).not.toMatch(/prefers-color-scheme[^{]*\{\s*\.ui-link\b/);
  }, 30_000);

  it("compiles dark: to the .dark class, never to prefers-color-scheme", async () => {
    const css = await compile(`${GLOBALS_CSS}\n.dark-probe { @apply dark:text-primary-300; }\n`);

    // On Tailwind's default (media) strategy the probe compiles inside a prefers-color-scheme query.
    expect(css).not.toMatch(/prefers-color-scheme[^{]*\{\s*\.dark-probe\b/);
    expect(css).toMatch(/\.dark-probe:where\(\.dark, \.dark \*\)\s*\{\s*color:/);
  }, 30_000);
});
