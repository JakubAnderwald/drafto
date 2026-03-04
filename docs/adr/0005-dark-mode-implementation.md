# 0005 — Dark Mode Implementation

- **Status**: Accepted
- **Date**: 2026-03-04
- **Authors**: Claude (AI assistant), Jakub Anderwald

## Context

With the design system foundation in place (ADR-0004), Drafto needed dark mode support. Users expect dark mode in modern apps, especially note-taking tools used for extended periods. The implementation had to:

- Toggle between light, dark, and system-preference modes
- Persist the user's choice across sessions
- Prevent a flash of unstyled/wrong-theme content on page load
- Work with the existing CSS custom property design system
- Integrate with BlockNote's built-in theme prop

## Decision

We implement dark mode using a **class-based strategy** (`.dark` on `<html>`) with three components:

### 1. CSS token overrides (`globals.css`)

All semantic surface tokens (`--color-bg`, `--color-fg`, `--color-sidebar-bg`, etc.) are overridden under a `.dark` selector in `globals.css`. This keeps dark mode changes in one place — no component-level conditional styling is needed.

### 2. `useTheme` hook + `ThemeToggle` component

- **`src/hooks/use-theme.ts`** — A `useSyncExternalStore`-based hook that manages theme state outside React's tree. It reads/writes `localStorage("theme")`, listens to `prefers-color-scheme` media query changes, and toggles the `.dark` class on `document.documentElement`. Supports three modes: `light`, `dark`, and `system`.
- **`src/components/ui/theme-toggle.tsx`** — An `IconButton` that cycles through light → dark → system. Displays a sun or moon icon based on the resolved theme.

### 3. Flash prevention script (`layout.tsx`)

An inline `<script>` in `<head>` runs before first paint. It reads `localStorage("theme")` and applies the `.dark` class synchronously, preventing a visible flash of the wrong theme. The `<html>` element uses `suppressHydrationWarning` since the server-rendered class may differ from the client-applied class.

### 4. BlockNote integration (`note-editor.tsx`)

The `NoteEditor` component reads `resolvedTheme` from `useTheme` and passes it as the `theme` prop to `BlockNoteView`, keeping the editor's built-in theme in sync with the app.

### Integration points

- **App shell sidebar** — `ThemeToggle` in the sidebar footer
- **Auth layout** — `ThemeToggle` in the top-right corner

## Consequences

- **Positive**: Single mechanism for all dark mode styling — override CSS variables under `.dark`, no per-component changes.
- **Positive**: No flash of wrong theme on page load thanks to the synchronous inline script.
- **Positive**: System preference is respected by default and updates in real time via `matchMedia` listener.
- **Positive**: Zero new dependencies — uses native browser APIs (`localStorage`, `matchMedia`, `classList`).
- **Positive**: BlockNote editor theme stays in sync automatically via the `theme` prop.
- **Negative**: The inline `<script>` in `layout.tsx` uses `dangerouslySetInnerHTML`, which requires care during maintenance. However, the script is minimal and stable.
- **Negative**: `suppressHydrationWarning` on `<html>` suppresses all hydration warnings on that element, not just theme-related ones. This is an accepted trade-off given Next.js's recommendation for this pattern.
- **Neutral**: The three-state cycle (light → dark → system) is slightly less discoverable than a simple toggle, but provides more user control.

## Alternatives Considered

1. **`next-themes` library** — Popular Next.js theming library with built-in flash prevention and SSR support. Rejected because the implementation is simple enough (~100 lines) that a dependency isn't warranted. `next-themes` also adds React context overhead and doesn't integrate with `useSyncExternalStore`.
2. **Media-query-only dark mode** (`@media (prefers-color-scheme: dark)`) — No user override, purely system-driven. Rejected because users expect manual control over theme preference.
3. **CSS `color-scheme` property only** — Native browser dark mode. Rejected because it doesn't provide fine-grained control over custom design tokens and colors.
4. **Server-side theme via cookie** — Store theme preference in a cookie, read it server-side to render the correct theme without flash. Rejected as over-engineered for this use case — the inline script approach is simpler and avoids adding theme logic to the server/middleware.
