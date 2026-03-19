# Digital Atelier UI Rewrite Plan

This document outlines the phased plan to rewrite all UI components across web and mobile to fully adopt the Digital Atelier design system tokens introduced in [ADR 0014](./adr/0014-digital-atelier-design-system.md).

## Design Principles

1. **No-line philosophy**: Separate regions with tonal surfaces, not visible borders. Use `bg-subtle`, `bg-muted`, `surface-high`, `surface-highest` to create hierarchy.
2. **Glass effects**: Overlays, command palettes, and floating panels use `--glass-bg` + `backdrop-filter: blur(var(--glass-blur))` for frosted depth.
3. **Warm shadows**: Use the warm-tinted shadow scale (`shadow-xs` through `shadow-lg`) sparingly — tonal separation is the primary elevation mechanism.
4. **Soft radii**: All interactive elements use the larger radius scale (sm: 6px, md: 8px, lg: 12px, xl: 16px).
5. **Tight tracking for headings**: Apply `tracking-tight` (-0.02em) to h1–h3 for a refined typographic feel.
6. **Relaxed line height for body**: Apply `leading-relaxed` (1.6) to long-form content in the editor.

---

## Phase 1: UI Primitives

Update all base components in `apps/web/src/components/ui/` to use new tokens.

### Card

- Remove `border` class; rely on tonal `bg-bg-subtle` against `bg-bg` canvas
- Keep shadow variants but use new warm shadows
- Increase border-radius to `rounded-lg` (0.75rem)

### Input

- Replace solid border with `border-outline-variant` (ghost border)
- Focus ring: `ring-ring` (now `#3525CD` light / `#A5B4FC` dark)
- Error state: `border-error` + `bg-error-bg`
- Radius: `rounded-md` (0.5rem)

### DropdownMenu

- Background: `bg-glass-bg` + `backdrop-blur-[16px]`
- Remove visible borders, use `shadow-md` for floating effect
- Items: hover → `bg-bg-muted`, radius `rounded-md`

### Badge

- Tonal backgrounds: default `bg-bg-muted`, success `bg-success-bg`, warning `bg-warning-bg`, error `bg-error-bg`
- No border; radius `rounded-md`

### ConfirmDialog

- Glass background for the overlay backdrop
- Card-style dialog body with `bg-bg` and `shadow-lg`
- No visible border

### Button

- Primary: `bg-primary-600` → `hover:bg-primary-700`, text `fg-on-primary`
- Secondary: `bg-bg-muted` → `hover:bg-bg-muted-hover`, text `fg`
- Ghost: transparent → `hover:bg-bg-muted`
- All variants: `rounded-md` (0.5rem)

---

## Phase 2: Layout & Navigation

### AppShell / Sidebar

- Sidebar: `bg-sidebar-bg` (warm cream/dark), no right border
- Separate from content via tonal contrast alone
- Active item: `bg-sidebar-active` with `text-sidebar-active-text`
- Hover: `bg-sidebar-hover`

### Top Bar / Header

- `bg-glass-bg` + `backdrop-blur` for floating header effect
- No bottom border; subtle `shadow-xs` optional

### Panel Dividers

- Replace `border-r` / `border-b` with tonal surface changes
- e.g., sidebar `bg-bg-subtle` against main `bg-bg`

---

## Phase 3: Auth Pages

### Login / Signup / Reset Password

- Background gradient: `from-primary-50 to-secondary-50`
- Card: `bg-bg` with `shadow-lg`, no border, `rounded-xl`
- Inputs: ghost borders, warm focus ring
- Button: full-width primary

---

## Phase 4: Core App Views

### Note Editor

- Editor canvas: `bg-surface-lowest` (pure white in light mode)
- Toolbar: `bg-bg-subtle`, no top/bottom borders
- BlockNote overrides already updated via `--bn-border-radius: 8px`
- Inline formatting toolbar: glass effect

### Note List

- List items: no borders between items
- Hover: `bg-bg-muted`
- Active/selected: `bg-primary-50` with `text-primary-700`
- Group separators: tonal `bg-bg-subtle` bands

### Search Overlay

- Full-screen glass overlay: `bg-glass-bg` + `backdrop-blur`
- Search input: large, centered, ghost border
- Results: card-like items with `bg-bg-subtle`, `rounded-lg`

---

## Phase 5: Dialogs & Overlays

### Modal Dialogs

- Backdrop: `bg-black/40` + `backdrop-blur-sm`
- Dialog card: `bg-bg`, `shadow-lg`, `rounded-xl`, no border

### Toast / Notifications

- `bg-bg-subtle`, `shadow-md`, `rounded-lg`
- Status variants: left accent bar using `border-l-4` with status color
- No outer border

### Dropdown Menus (already in Phase 1)

- Ensure consistent glass treatment across all dropdown instances

---

## Phase 6: Admin & Static Pages

### Design System Showcase (`/design-system`)

- Already updated with new token values, surface architecture section, and glass demo
- Future: add live component variant explorer

### Settings / Profile Pages

- Section cards: `bg-bg-subtle`, no border, `rounded-lg`
- Form groups: subtle tonal separation

---

## Phase 7: Mobile Components

### React Native Token Mapping

All mobile components should use `getSemanticColors()` from `apps/mobile/src/theme/tokens.ts`.

### Screens to Update

- **Auth screens**: Warm gradient backgrounds, card-style forms
- **Note list**: Tonal row separation, no `borderBottomWidth`
- **Editor**: `surfaceLowest` background, tonal toolbar
- **Modals/Bottom sheets**: Use `surfaceHigh` background with native blur where available
- **Navigation**: Tonal tab bar / header, no border lines

### New Semantic Properties

Mobile tokens now include:

- `bgMutedHover` — pressed/hover state
- `surfaceLowest`, `surfaceHigh`, `surfaceHighest` — elevation tiers
- `outlineVariant` — ghost borders
- `warningBg`, `warningText` — warning status surfaces

---

## Phase 8: QA & Polish

### Visual Regression Testing

- Screenshot comparison for light and dark mode
- Test on low-contrast and high-contrast displays
- Verify ghost borders are visible enough in both modes

### Accessibility Audit

- Verify WCAG 2.1 AA contrast ratios for all text/background combinations
- Ghost borders: ensure interactive elements have sufficient contrast even without visible borders (rely on shape/shadow cues)
- Focus indicators: `ring-ring` must be clearly visible

### Cross-Platform Consistency

- Compare web and mobile side-by-side for each major view
- Verify mobile semantic tokens produce equivalent visual results
- Test dark mode transitions

---

## Migration Strategy

Each phase is a separate PR (or small group of PRs). Order is flexible, but Phase 1 (primitives) should land first since all other phases depend on updated base components.

**Estimated scope per phase:**

- Phase 1: ~6–8 component files
- Phase 2: ~3–4 layout files
- Phase 3: ~3 auth page files
- Phase 4: ~5–7 core view files
- Phase 5: ~3–4 overlay files
- Phase 6: ~2–3 admin files
- Phase 7: ~8–10 mobile files
- Phase 8: Testing & polish (no new code, just fixes)
