/**
 * Drift test: ensures the canonical TS design tokens in
 * `packages/shared/src/design-tokens.ts` stay in sync with the CSS
 * custom properties in `apps/web/src/app/globals.css`.
 *
 * If this test fails, either the TS tokens or the CSS file has been
 * updated without the other. Update both to match.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { colors, semanticLight, semanticDark } from "../src/design-tokens";

const GLOBALS_CSS_PATH = resolve(__dirname, "../../../apps/web/src/app/globals.css");

/**
 * Extracts the value of a CSS custom property from a CSS source string,
 * limited to a specific selector block.
 */
function extractCssVar(css: string, selector: string, propertyName: string): string | null {
  // Match the whole block for the selector (e.g. ":root { ... }", ".dark { ... }",
  // "@theme inline { ... }"). We use a non-greedy match to the first closing brace.
  const selectorPattern = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\n\\}`,
  );
  const blockMatch = selectorPattern.exec(css);
  if (!blockMatch) return null;
  const block = blockMatch[1];

  const propPattern = new RegExp(
    `${propertyName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*:\\s*([^;]+);`,
  );
  const propMatch = propPattern.exec(block);
  if (!propMatch) return null;
  return propMatch[1].trim();
}

/** Normalise hex + rgba color strings so comparisons are case/whitespace insensitive. */
function normalizeColor(value: string): string {
  const trimmed = value.trim().toLowerCase();
  // Collapse `rgba( 1, 2, 3, 0.30 )` -> `rgba(1,2,3,0.3)`
  if (trimmed.startsWith("rgba") || trimmed.startsWith("rgb")) {
    return trimmed
      .replace(/\s+/g, "")
      .replace(/(0?\.\d+?)0+\)/, "$1)") // trim trailing zeros in alpha
      .replace(/\.0+\)/, ")");
  }
  return trimmed;
}

describe("design tokens drift — globals.css vs @drafto/shared", () => {
  let css: string;

  beforeAll(() => {
    css = readFileSync(GLOBALS_CSS_PATH, "utf8");
  });

  describe("palette tokens (declared under @theme inline)", () => {
    const paletteCases: Array<[string, string, string]> = [
      // [cssVar, paletteGroup, shade]
      ...Object.entries(colors.primary).map(
        ([shade, value]) => [`--color-primary-${shade}`, value, value] as [string, string, string],
      ),
      ...Object.entries(colors.secondary).map(
        ([shade, value]) =>
          [`--color-secondary-${shade}`, value, value] as [string, string, string],
      ),
      ...Object.entries(colors.tertiary).map(
        ([shade, value]) => [`--color-tertiary-${shade}`, value, value] as [string, string, string],
      ),
      ...Object.entries(colors.neutral).map(
        ([shade, value]) => [`--color-neutral-${shade}`, value, value] as [string, string, string],
      ),
    ];

    for (const [cssVar, tsValue] of paletteCases) {
      it(`${cssVar} matches TS colors value`, () => {
        const cssValue = extractCssVar(css, "@theme inline", cssVar);
        expect(cssValue, `CSS variable ${cssVar} not found in @theme inline block`).not.toBeNull();
        expect(normalizeColor(cssValue!)).toBe(normalizeColor(tsValue));
      });
    }

    it("status colors match", () => {
      expect(normalizeColor(extractCssVar(css, "@theme inline", "--color-success")!)).toBe(
        normalizeColor(colors.success),
      );
      expect(normalizeColor(extractCssVar(css, "@theme inline", "--color-warning")!)).toBe(
        normalizeColor(colors.warning),
      );
      expect(normalizeColor(extractCssVar(css, "@theme inline", "--color-error")!)).toBe(
        normalizeColor(colors.error),
      );
      expect(normalizeColor(extractCssVar(css, "@theme inline", "--color-info")!)).toBe(
        normalizeColor(colors.info),
      );
    });
  });

  describe("semantic tokens — light mode (:root)", () => {
    const lightCases: Array<[string, string]> = [
      ["--bg", semanticLight.bg],
      ["--bg-subtle", semanticLight.bgSubtle],
      ["--bg-muted", semanticLight.bgMuted],
      ["--bg-muted-hover", semanticLight.bgMutedHover],
      ["--fg", semanticLight.fg],
      ["--fg-muted", semanticLight.fgMuted],
      ["--fg-subtle", semanticLight.fgSubtle],
      ["--border", semanticLight.border],
      ["--border-strong", semanticLight.borderStrong],
      ["--ring", semanticLight.ring],
      ["--surface-lowest", semanticLight.surfaceLowest],
      ["--surface-high", semanticLight.surfaceHigh],
      ["--surface-highest", semanticLight.surfaceHighest],
      ["--outline-variant", semanticLight.outlineVariant],
      ["--error-bg", semanticLight.errorBg],
      ["--error-text", semanticLight.errorText],
      ["--success-bg", semanticLight.successBg],
      ["--success-text", semanticLight.successText],
      ["--warning-bg", semanticLight.warningBg],
      ["--warning-text", semanticLight.warningText],
      ["--fg-on-primary", semanticLight.onPrimary],
    ];

    for (const [cssVar, tsValue] of lightCases) {
      it(`${cssVar} matches semanticLight value`, () => {
        const cssValue = extractCssVar(css, ":root", cssVar);
        expect(cssValue, `CSS variable ${cssVar} not found in :root block`).not.toBeNull();
        expect(normalizeColor(cssValue!)).toBe(normalizeColor(tsValue));
      });
    }
  });

  describe("semantic tokens — dark mode (.dark)", () => {
    const darkCases: Array<[string, string]> = [
      ["--bg", semanticDark.bg],
      ["--bg-subtle", semanticDark.bgSubtle],
      ["--bg-muted", semanticDark.bgMuted],
      ["--bg-muted-hover", semanticDark.bgMutedHover],
      ["--fg", semanticDark.fg],
      ["--fg-muted", semanticDark.fgMuted],
      ["--fg-subtle", semanticDark.fgSubtle],
      ["--border", semanticDark.border],
      ["--border-strong", semanticDark.borderStrong],
      ["--ring", semanticDark.ring],
      ["--surface-lowest", semanticDark.surfaceLowest],
      ["--surface-high", semanticDark.surfaceHigh],
      ["--surface-highest", semanticDark.surfaceHighest],
      ["--outline-variant", semanticDark.outlineVariant],
      ["--error-bg", semanticDark.errorBg],
      ["--error-text", semanticDark.errorText],
      ["--success-bg", semanticDark.successBg],
      ["--success-text", semanticDark.successText],
      ["--warning-bg", semanticDark.warningBg],
      ["--warning-text", semanticDark.warningText],
      ["--fg-on-primary", semanticDark.onPrimary],
    ];

    for (const [cssVar, tsValue] of darkCases) {
      it(`${cssVar} matches semanticDark value`, () => {
        const cssValue = extractCssVar(css, ".dark", cssVar);
        expect(cssValue, `CSS variable ${cssVar} not found in .dark block`).not.toBeNull();
        expect(normalizeColor(cssValue!)).toBe(normalizeColor(tsValue));
      });
    }
  });
});
