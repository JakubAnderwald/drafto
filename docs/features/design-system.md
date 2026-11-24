# Design System

**Status:** shipped **Updated:** 2026-11-24

## What it is

Drafto's shared visual language — a token layer (colors, shadows, radii, transitions), a set of UI primitives, and a dark-mode story. It ensures that web, mobile, and desktop render the same "Digital Atelier" aesthetic from a single set of design decisions.

## Current state

- **Platform coverage:** one token source in `@drafto/shared` (`packages/shared/src/design-tokens.ts`); web mirrors it as CSS variables, mobile and desktop import it directly.
- **Token layer:** semantic surface tokens (`--bg`, `--fg`, `--border`, etc.), scale tokens for five palettes (primary indigo, secondary amber, tertiary teal, neutral warm stone, plus status colors), shadow/radius/transition scales, and surface-architecture tokens for layered surfaces and glass effects.
- **Primitives:** twelve components under `apps/web/src/components/ui/` — badge, button, card, confirm-dialog, dropdown-menu, icon-button, input, label, password-input, progress-bar, skeleton, theme-toggle.
- **Dark mode:** `.dark` class on `<html>` overrides every semantic token. Preference cycles light → dark → system via `ThemeToggle`, persisted in `localStorage` under `"theme"`, with a pre-hydration inline script in `app/layout.tsx` to prevent a flash of wrong theme. The browser chrome follows the in-app theme, not the OS ([#865](https://github.com/JakubAnderwald/drafto/issues/865)): `color-scheme` is set on `:root` and `.dark` in `globals.css`, and `<meta name="theme-color">` (the `--bg` value) is created by that script and kept in step by `use-theme.ts`, both through `src/lib/theme/theme-chrome.ts`. The layout doesn't render that meta: React 19 hoists `<meta>` and, once the script had changed it, would add a second one at hydration. Tailwind's `dark:` variant follows the same `.dark` class, not the OS ([#901](https://github.com/JakubAnderwald/drafto/issues/901)): `globals.css` declares it with `@custom-variant dark (&:where(.dark, .dark *))`. So `dark:` is safe to use, and it never adds specificity. Reach for it only for what a semantic token doesn't switch on its own: a scale colour like `text-primary-600`, or artwork with a light and a dark variant (`.theme-light-only` / `.theme-dark-only`).
- **Showcase:** a `/design-system` route renders every token and primitive variant for visual QA.

## Code paths

| Concern                          | Path                                                    |
| -------------------------------- | ------------------------------------------------------- |
| Web token mirror (CSS variables) | `apps/web/src/app/globals.css`                          |
| Web UI primitives                | `apps/web/src/components/ui/`                           |
| Showcase page                    | `apps/web/src/app/design-system/page.tsx`               |
| Showcase layout                  | `apps/web/src/app/design-system/layout.tsx`             |
| Theme hook (web)                 | `apps/web/src/hooks/use-theme.ts`                       |
| Theme toggle component           | `apps/web/src/components/ui/theme-toggle.tsx`           |
| Pre-hydration theme script       | `apps/web/src/app/layout.tsx`                           |
| Shared token source (TS)         | `packages/shared/src/design-tokens.ts`                  |
| Token drift test (TS vs CSS)     | `packages/shared/__tests__/design-tokens-drift.test.ts` |
| Mobile token re-export           | `apps/mobile/src/theme/tokens.ts`                       |
| Desktop token re-export          | `apps/desktop/src/theme/tokens.ts`                      |
| Mobile UI primitives             | `apps/mobile/src/components/ui/`                        |

## Related ADRs

- [0004 — Design System with CSS Custom Properties](../adr/0004-design-system-css-variables.md) (superseded by 0014)
- [0005 — Dark Mode Implementation](../adr/0005-dark-mode-implementation.md)
- [0014 — Digital Atelier Design System](../adr/0014-digital-atelier-design-system.md) (current)

## Cross-platform notes

The token values live once, in `packages/shared/src/design-tokens.ts` (`colors`, `semanticLight`, `semanticDark` and the `SemanticColors` type). React Native has no CSS custom properties, so mobile and desktop import that module through `@drafto/shared`; `apps/{mobile,desktop}/src/theme/tokens.ts` only re-export it, so existing `@/theme/tokens` imports keep working. Web mirrors the same values as CSS variables in `globals.css`. `packages/shared/__tests__/design-tokens-drift.test.ts` compares the two from a hand-kept list of `[css variable, TS value]` pairs for `:root` and `.dark`, so a new semantic token needs a row in both lists, or the test won't check it.

Mobile has its own small primitive set in `apps/mobile/src/components/ui/` (badge, button, card, empty-state, fab, input, skeleton). The `Fab` (floating "+" button) lifts itself above the bottom system inset on screens with no bottom tab bar, such as the notebook screen: the app is edge-to-edge, so otherwise the Android navigation bar or iOS home indicator covers the button (PrimeTestLab report 10668, M-01). It tells the two cases apart by `BottomTabBarHeightContext` from `@react-navigation/bottom-tabs`, which only the tab navigator provides; on a tab screen the tab bar already takes that inset. Pad a list under a FAB with `useFabLayout(fabVisible).listPaddingBottom`, from the same hook the `Fab` uses, so its last row scrolls clear of the button; pass `false` while the screen hides the FAB (e.g. with its create bar open) to drop back to the resting padding.

Semantic surface tokens (`--bg`, `--fg`, …) react to the `.dark` class on web; on mobile and desktop the theme provider hands components `semantic` (`semanticLight` or `semanticDark`). Shadow/radius/transition tokens are web-only — mobile and desktop use platform-idiomatic values.

**Subtle accent.** `--accent-subtle-bg` / `--accent-subtle-text` (Tailwind `bg-accent-subtle-bg text-accent-subtle-text`; React Native `semantic.accentSubtleBg` / `semantic.accentSubtleText`) colour a tinted secondary action, such as the note editor's "Image" / "File" attachment buttons on mobile and desktop. Light mode is the lavender `primary-50` fill with `primary-600` text. Dark mode is the deep purple and lavender text of the sidebar selection. A scale colour like `colors.primary[50]` doesn't switch with the theme, so on mobile and desktop it stays a light pill in dark mode. Use these tokens for that kind of fill instead.

## Modifying safely

- **Use semantic tokens for surfaces.** Prefer `bg-bg`, `text-fg-muted`, `border-border` over raw Tailwind colors like `bg-gray-100`. See CLAUDE.md → "Design System (Enforced)" for the full rule set.
- **Use scale tokens for palette colors.** Prefer `bg-primary-500`, `text-accent-400`, `text-neutral-600` over arbitrary values like `bg-[#4f46e5]`.
- **Use system shadows, radii, and transitions** (`shadow-sm`, `rounded-lg`, `transition-fast`) — never hardcoded box-shadows or pixel radii.
- **Check `apps/web/src/components/ui/` before building** a new button, input, card, badge, dialog, dropdown, or skeleton — a primitive likely already exists.
- **Showcase-page rule:** when you add a new token to `globals.css` or a new primitive to `components/ui/`, you must add a corresponding example (all variants) to `apps/web/src/app/design-system/page.tsx`. This keeps the live reference in sync with the codebase.
- **Cross-platform rule:** change a palette value or add a semantic token in `packages/shared/src/design-tokens.ts` (`semanticLight`, `semanticDark` and the `SemanticColors` type), mirror it in `globals.css` (light block, `.dark` block and the `@theme` mapping), and add it to both lists in `packages/shared/__tests__/design-tokens-drift.test.ts`, all in the same PR. Mobile and desktop pick it up through `@drafto/shared`; their `theme/tokens.ts` files are re-exports and need no edit.

## Long-form documents

Text-heavy pages written as plain HTML (`/privacy`, `/support`, `/account/delete`) use the `.doc-prose` class from `globals.css` rather than Tailwind's `prose`. The typography plugin is not installed, so `prose` does nothing, and preflight leaves such a page as one unbroken block of text. `.doc-prose` styles headings (`h2`–`h4`), paragraphs, lists, links, `strong` and tables with semantic tokens, so it follows the light and dark themes.

- **Sections:** every `<section>` inside it except the first gets a ruled divider above it.
- **Tables:** below the `sm` breakpoint, table rows stack into cards, and each cell is labelled from its `data-label` attribute. `display: block` can strip table semantics in WebKit, so a table that stacks also carries explicit ARIA roles (`role="table"`, `"rowgroup"`, `"row"`, `"columnheader"`, `"cell"`).
- **Callouts and boxes:** use the `Card` primitive, not a hand-rolled `bg-bg-subtle` box.
- **Links outside `.doc-prose`:** give them the same look with `.doc-link`. It sets lighter `dark:` colours, because `text-primary-600` is unreadable on the dark surfaces.
- **Links that set their own underline:** use `.ui-link` (the auth and admin pages: `ui-link hover:underline`). It sets only the colour, the same pair as `.doc-link` (`primary-600`, `primary-700` on hover; `primary-300`, `primary-200` on hover in dark mode), so the call site keeps its own underline, size and transition utilities. Don't add a colour utility next to it: utilities override the `components` layer.

Utility classes on an element override these styles, because `.doc-prose` sits in the `components` cascade layer.

`apps/web/src/components/legal/` holds the building blocks for a numbered, policy-style page: `NumberedSection` and `TableOfContents`. Both read the same outline array through `outlineEntry()`, so the headings and the contents list cannot drift apart. The showcase page's "Document Prose" section renders all of these.

## Lint guardrails (automated)

The rules above are enforced by ESLint. Violations surface as `no-restricted-syntax` errors during `pnpm lint` and block PRs in CI.

### Web (`apps/web/eslint.config.mjs`)

Within `className` string and template literals, the web rule blocks:

- **Raw Tailwind greys** — `bg-gray-*`, `text-slate-*`, `bg-stone-*`, `bg-zinc-*`, `bg-neutral-*` and their `border-/from-/to-/ring-/divide-/placeholder-/…` cousins. Use semantic tokens (`bg-bg`, `text-fg-muted`, `border-border`) or a palette scale class (`bg-primary-500`) that is defined in `globals.css`.
- **Arbitrary color values** — `bg-[#...]`, `text-[#...]`, `border-[#...]`, `from-[#...]`, `to-[#...]`, `shadow-[rgb(...)]`, etc. Use a scale token. Arbitrary values that reference a CSS variable (`bg-[var(--surface-glass)]`) are still allowed.
- **Arbitrary shadow/radius values** — `shadow-[0_0_10px_red]`, `rounded-[17px]`. Use the system shadows (`shadow-sm`, `shadow-md`) and radii (`rounded-md`, `rounded-lg`). CSS-variable-driven values (`shadow-[var(--shadow-glow)]`) remain allowed.
- **A bare `text-primary-600`** — one with no `dark:text-*` colour in the same string, because the scale colours don't follow the theme and it stays deep indigo on the dark surfaces. Use `.ui-link` (or `.doc-link`) for a link, or add a `dark:text-*` partner. Only a colour counts as a partner: `dark:text-sm`, `dark:text-center`, an arbitrary size like `dark:text-[14px]` and the other `text-*` utilities that aren't colours don't, and neither does a `dark:text-${…}` whose value comes from an expression. The partner must also apply at rest, so a longer variant chain such as `hover:dark:text-primary-300` or `md:dark:text-primary-300` doesn't count. The rule reads one string, or one template literal as a whole, at a time, so a `dark:` partner in a different `cn()` argument needs a suppression comment. Every variant-prefixed use is skipped, not only state ones: `hover:text-primary-600`, but also `md:text-primary-600` and `[&_a]:text-primary-600`. Give those a `dark:` partner by hand.

### Mobile + desktop (`apps/mobile/eslint.config.mjs`, `apps/desktop/eslint.config.mjs`)

Within `src/`, `app/`, and `components/` trees, the native rules block:

- **Hardcoded `fontSize` numbers** — `fontSize: 14`, `fontSize: 20`. Use `fontSizes.sm` / `fontSizes.md` / … from `@/theme/tokens`.
- **Hex color string literals assigned to color-bearing props** — `color: "#111"`, `backgroundColor: "#3525CD"`, `borderColor: "#fff"`, plus the `borderTopColor`/`borderBottomColor`/`borderLeftColor`/`borderRightColor`/`tintColor` variants. Use `semantic.fg` / `colors.primary[500]` / … from `@/theme/tokens`.
- **Note:** `shadowColor` is intentionally **not** flagged. React Native's native shadow API expects a bare color (typically `"#000"`) and controls intensity via `shadowOpacity` + `shadowRadius`, so there is no semantic swap.

Tests, jest setup, and build configs are deliberately out of scope — the rule only applies to UI source trees.

### Suppressing for legitimate exceptions

If you genuinely need a raw value (the canonical example is an emoji glyph sized as a visual, not typography), suppress with an explanatory comment:

```tsx
icon: {
  // eslint-disable-next-line no-restricted-syntax -- emoji hero glyph, not typography
  fontSize: 48,
  marginBottom: spacing.lg,
},
```

Always include a `-- <reason>` so reviewers can tell whether the exception still makes sense.

## Verify

- Visit `/design-system` in the running web app and confirm every token swatch and primitive variant renders in both light and dark.
- Toggle theme via the header `ThemeToggle`; cycle light → dark → system and confirm persistence across reload.
- Grep for raw Tailwind color utilities (`bg-gray-`, `text-slate-`, `bg-[#`) in `apps/web/src/` — any hit is a violation.
- Confirm `apps/mobile/src/theme/tokens.ts` and `apps/desktop/src/theme/tokens.ts` are byte-identical: `diff apps/mobile/src/theme/tokens.ts apps/desktop/src/theme/tokens.ts` should print nothing.
- Run `cd apps/web && pnpm test` and `pnpm typecheck` to catch token or primitive regressions.
