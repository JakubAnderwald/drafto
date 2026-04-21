# Design System

**Status:** shipped **Updated:** 2026-04-21

## What it is

Drafto's shared visual language — a token layer (colors, shadows, radii, transitions), a set of UI primitives, and a dark-mode story. It ensures that web, mobile, and desktop render the same "Digital Atelier" aesthetic from a single set of design decisions.

## Current state

- **Platform coverage:** web (authoritative token source), mobile (mirrored tokens), desktop (reuses mobile tokens verbatim).
- **Token layer:** semantic surface tokens (`--bg`, `--fg`, `--border`, etc.), scale tokens for five palettes (primary indigo, secondary amber, tertiary teal, neutral warm stone, plus status colors), shadow/radius/transition scales, and surface-architecture tokens for layered surfaces and glass effects.
- **Primitives:** ten components under `apps/web/src/components/ui/` — badge, button, card, confirm-dialog, dropdown-menu, icon-button, input, label, skeleton, theme-toggle.
- **Dark mode:** `.dark` class on `<html>` overrides every semantic token. Preference cycles light → dark → system via `ThemeToggle`, persisted in `localStorage` under `"theme"`, with a pre-hydration inline script in `app/layout.tsx` to prevent a flash of wrong theme.
- **Showcase:** a `/design-system` route renders every token and primitive variant for visual QA.

## Code paths

| Concern                          | Path                                          |
| -------------------------------- | --------------------------------------------- |
| Web token source (CSS variables) | `apps/web/src/app/globals.css`                |
| Web UI primitives                | `apps/web/src/components/ui/`                 |
| Showcase page                    | `apps/web/src/app/design-system/page.tsx`     |
| Showcase layout                  | `apps/web/src/app/design-system/layout.tsx`   |
| Theme hook (web)                 | `apps/web/src/hooks/use-theme.ts`             |
| Theme toggle component           | `apps/web/src/components/ui/theme-toggle.tsx` |
| Pre-hydration theme script       | `apps/web/src/app/layout.tsx`                 |
| Mobile token mirror              | `apps/mobile/src/theme/tokens.ts`             |
| Desktop token mirror (identical) | `apps/desktop/src/theme/tokens.ts`            |

## Related ADRs

- [0004 — Design System with CSS Custom Properties](../adr/0004-design-system-css-variables.md) (superseded by 0014)
- [0005 — Dark Mode Implementation](../adr/0005-dark-mode-implementation.md)
- [0014 — Digital Atelier Design System](../adr/0014-digital-atelier-design-system.md) (current)

## Cross-platform notes

The web CSS variables in `globals.css` are the source of truth. `apps/mobile/src/theme/tokens.ts` mirrors those values as a plain TypeScript object (React Native has no CSS custom properties, so the map is hand-maintained). `apps/desktop/src/theme/tokens.ts` is byte-for-byte identical to the mobile file — the desktop app imports the same shape and does not maintain its own tokens. When palette values change on web, the mobile and desktop files must be updated in the same PR.

Semantic surface tokens (`--bg`, `--fg`, …) react to the `.dark` class on web; on mobile and desktop the consuming theme provider picks the correct variant from the mirror. Shadow/radius/transition tokens are web-only — mobile and desktop use platform-idiomatic values.

## Modifying safely

- **Use semantic tokens for surfaces.** Prefer `bg-bg`, `text-fg-muted`, `border-border` over raw Tailwind colors like `bg-gray-100`. See CLAUDE.md → "Design System (Enforced)" for the full rule set.
- **Use scale tokens for palette colors.** Prefer `bg-primary-500`, `text-accent-400`, `text-neutral-600` over arbitrary values like `bg-[#4f46e5]`.
- **Use system shadows, radii, and transitions** (`shadow-sm`, `rounded-lg`, `transition-fast`) — never hardcoded box-shadows or pixel radii.
- **Check `apps/web/src/components/ui/` before building** a new button, input, card, badge, dialog, dropdown, or skeleton — a primitive likely already exists.
- **Showcase-page rule:** when you add a new token to `globals.css` or a new primitive to `components/ui/`, you must add a corresponding example (all variants) to `apps/web/src/app/design-system/page.tsx`. This keeps the live reference in sync with the codebase.
- **Cross-platform rule:** if you change a palette value or add a semantic token that mobile/desktop consume, update `apps/mobile/src/theme/tokens.ts` and `apps/desktop/src/theme/tokens.ts` in the same PR.

## Verify

- Visit `/design-system` in the running web app and confirm every token swatch and primitive variant renders in both light and dark.
- Toggle theme via the header `ThemeToggle`; cycle light → dark → system and confirm persistence across reload.
- Grep for raw Tailwind color utilities (`bg-gray-`, `text-slate-`, `bg-[#`) in `apps/web/src/` — any hit is a violation.
- Confirm `apps/mobile/src/theme/tokens.ts` and `apps/desktop/src/theme/tokens.ts` are byte-identical: `diff apps/mobile/src/theme/tokens.ts apps/desktop/src/theme/tokens.ts` should print nothing.
- Run `cd apps/web && pnpm test` and `pnpm typecheck` to catch token or primitive regressions.
