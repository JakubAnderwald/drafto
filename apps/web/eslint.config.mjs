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

// The dark-link guard below (#910). A bare `text-primary-600`: the lookbehind skips
// variant-prefixed uses (`hover:text-primary-600`), the lookahead other shades (`-6000`).
const BARE_PRIMARY_600 = "(?<![\\w:-])text-primary-600(?![\\w-])";
// A `dark:text-*` colour that applies at rest. The lookbehind wants the token to start there, so a
// longer variant chain (`hover:dark:text-*`, `md:dark:text-*`) doesn't count. The value must be
// written out: a template chunk that ends in `dark:text-` before a `${…}` doesn't count, since the
// expression may be a size (`dark:text-${on ? "sm" : "center"}`). The last lookahead leaves out the
// `text-*` utilities that aren't colours (size, alignment, wrapping, overflow, shadow), and an
// arbitrary value unless it reads as a colour, so `dark:text-sm` and `dark:text-[14px]` don't count
// as a partner either.
const DARK_TEXT_COLOUR =
  "(?<!\\S)dark:text-(?=[\\w[(])(?!(?:xs|sm|base|lg|[0-9]?xl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|shadow)\\b|\\[(?!color:|var\\(|#|rgb|hsl|oklch|oklab)|\\((?!color:|--))";
const DARK_LINK_MESSAGE =
  "text-primary-600 is unreadable on the dark surfaces. Use the `ui-link` class for a link (or `doc-link` for one that always underlines), or pair it with a dark:text-* colour. See docs/features/design-system.md.";

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
  {
    // A bare `text-primary-600` stays deep indigo in dark mode (the scale colours don't follow
    // the theme). Flag it unless the same string also sets a `dark:text-*` colour. The negative
    // lookahead is anchored at the start, so it checks the whole string.
    selector: `JSXAttribute[name.name='className'] Literal[value=/^(?![\\s\\S]*${DARK_TEXT_COLOUR})[\\s\\S]*${BARE_PRIMARY_600}/]`,
    message: DARK_LINK_MESSAGE,
  },
  {
    // Same rule for a template literal, read as a whole: the `dark:` partner may sit in another
    // static chunk of the same template (`text-primary-600 ${x} dark:text-primary-300`).
    selector: `JSXAttribute[name.name='className'] TemplateLiteral:has(> TemplateElement[value.raw=/${BARE_PRIMARY_600}/]):not(:has(> TemplateElement[value.raw=/${DARK_TEXT_COLOUR}/]))`,
    message: DARK_LINK_MESSAGE,
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
