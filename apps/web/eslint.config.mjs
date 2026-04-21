import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";

// Design system guardrails — see docs/features/design-system.md and CLAUDE.md.
// These rules block regressions of raw Tailwind greys, arbitrary color/shadow
// values, and legacy palette utilities in JSX className strings. The intent is
// to force new UI code to use the semantic/scale tokens defined in
// apps/web/src/app/globals.css.
//
// To suppress for a legitimate exception (e.g. `bg-black/40` on a modal
// backdrop), add a `// eslint-disable-next-line no-restricted-syntax` comment
// on the line above with a short explanation.
const designSystemRestrictedSyntax = [
  {
    // Raw Tailwind grey scales must be replaced with semantic tokens.
    selector:
      "JSXAttribute[name.name='className'] Literal[value=/\\b(?:bg|text|border|from|to|ring|divide|placeholder|caret|accent|decoration|outline|shadow)-(?:gray|slate|stone|zinc|neutral)-\\d+\\b/]",
    message:
      "Use semantic tokens (bg-bg, text-fg, text-fg-muted, border-border) or palette scale tokens (bg-neutral-600 from our theme is fine if that class lives in globals.css) instead of raw Tailwind greys (bg-gray-*, text-slate-*, bg-stone-*, bg-zinc-*, bg-neutral-*). See docs/features/design-system.md.",
  },
  {
    // Same rule but for className expressions inside template literals / cn() calls.
    selector:
      "JSXAttribute[name.name='className'] TemplateElement[value.raw=/\\b(?:bg|text|border|from|to|ring|divide|placeholder|caret|accent|decoration|outline|shadow)-(?:gray|slate|stone|zinc|neutral)-\\d+\\b/]",
    message:
      "Use semantic tokens (bg-bg, text-fg, text-fg-muted, border-border) instead of raw Tailwind greys in className template literals. See docs/features/design-system.md.",
  },
  {
    // Arbitrary Tailwind color values — disallow hex/rgb literals.
    selector:
      "JSXAttribute[name.name='className'] Literal[value=/\\b(?:bg|text|border|from|to|via|ring|shadow|outline|decoration|divide|placeholder|caret|accent|fill|stroke)-\\[(?:#[0-9a-fA-F]{3,8}|rgb|hsl)/]",
    message:
      "Use design system scale tokens (bg-primary-500, text-accent-400) instead of arbitrary color values (bg-[#4f46e5]). See docs/features/design-system.md.",
  },
  {
    selector:
      "JSXAttribute[name.name='className'] TemplateElement[value.raw=/\\b(?:bg|text|border|from|to|via|ring|shadow|outline|decoration|divide|placeholder|caret|accent|fill|stroke)-\\[(?:#[0-9a-fA-F]{3,8}|rgb|hsl)/]",
    message:
      "Use design system scale tokens (bg-primary-500, text-accent-400) instead of arbitrary color values. See docs/features/design-system.md.",
  },
  {
    // Arbitrary shadow/rounded values — disallow pixel literals; allow CSS vars.
    selector:
      "JSXAttribute[name.name='className'] Literal[value=/\\b(?:shadow|rounded)-\\[(?!var\\()/]",
    message:
      "Use design system shadow/radius tokens (shadow-sm, shadow-md, rounded-md, rounded-lg) instead of arbitrary values. If you genuinely need a CSS-variable-driven value, use shadow-[var(--…)] or rounded-[var(--…)]. See docs/features/design-system.md.",
  },
  {
    selector:
      "JSXAttribute[name.name='className'] TemplateElement[value.raw=/\\b(?:shadow|rounded)-\\[(?!var\\()/]",
    message:
      "Use design system shadow/radius tokens (shadow-sm, shadow-md, rounded-md, rounded-lg) instead of arbitrary values. See docs/features/design-system.md.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated files:
    "playwright-report/**",
    "coverage/**",
    // Claude worktrees:
    ".claude/**",
  ]),
  {
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...designSystemRestrictedSyntax],
    },
  },
]);

export default eslintConfig;
