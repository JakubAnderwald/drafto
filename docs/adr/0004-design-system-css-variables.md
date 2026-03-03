# 0004 — Design System with CSS Custom Properties

- **Status**: Accepted
- **Date**: 2026-03-03
- **Authors**: Claude (AI assistant), Jakub Anderwald

## Context

Drafto's UI used plain Tailwind CSS defaults (gray/blue) with no design system, making visual consistency difficult and dark mode infeasible. The app needs a unified color palette, spacing/shadow/radius tokens, and a foundation that supports future dark mode toggling.

Key requirements:

- Consistent color palette across all surfaces (primary, accent, neutral, semantic)
- Dark mode support without changing component code
- Integration with Tailwind CSS v4's native `@theme` system
- No additional runtime dependencies

## Decision

We define the design system as CSS custom properties in `src/app/globals.css`, organized in two layers:

1. **Raw `:root` variables** — semantic surface tokens (`--bg`, `--fg`, `--border`, `--sidebar-*`) that will be overridden by a `.dark` class in Phase 7.
2. **`@theme inline` block** — exposes color scales (Primary/Indigo, Accent/Amber, Neutral/Stone), semantic status colors, shadows, border radii, and transition durations directly to Tailwind's utility class system.

**Color palette:**

- **Primary (Indigo 50–900)** — professional yet distinctive; differentiates from generic blue apps
- **Accent (Amber 50–600)** — warmth for interactive highlights and call-to-action elements
- **Neutral (Stone 50–900)** — warmer than pure gray, more inviting for a note-taking app
- **Semantic** — green (success), amber (warning), red (error), blue (info)

**Non-color tokens:**

- Shadows: `xs`, `sm`, `md`, `lg`
- Border radius: `sm`, `md`, `lg`, `xl`, `full`
- Transitions: `fast` (150ms), `normal` (200ms), `slow` (300ms)

Tailwind v4 consumes these via `@theme inline`, making them available as utility classes (e.g., `bg-primary-500`, `text-fg-muted`, `shadow-md`, `rounded-lg`).

## Consequences

- **Positive**: Single source of truth for all visual properties. Changing a token updates every surface.
- **Positive**: Dark mode becomes a matter of overriding `:root` variables under `.dark` — no component-level changes needed.
- **Positive**: Zero new dependencies. CSS custom properties are native browser technology.
- **Positive**: Tailwind v4's `@theme inline` gives full utility class access without a separate config file.
- **Negative**: Developers must use token-based classes (`bg-bg`, `text-fg-muted`) instead of raw Tailwind colors (`bg-gray-100`). Requires discipline during code review.
- **Neutral**: The token set is intentionally small (~50 variables). Expansion is easy but should be deliberate to avoid bloat.

## Alternatives Considered

1. **shadcn/ui + Radix primitives** — Full component library with built-in theming. Rejected because Drafto has only ~6 main components and 5 auth pages — too small for a full library. Would also add Radix dependencies alongside the existing Mantine dependency (required by BlockNote).
2. **Tailwind config file tokens** — Define colors in `tailwind.config.ts`. Rejected because Tailwind v4 favors CSS-native `@theme` over config files, and CSS variables enable runtime dark mode switching without rebuild.
3. **CSS-in-JS (styled-components, Emotion)** — Runtime theming with JS. Rejected due to bundle size overhead and conflict with Next.js Server Components.
