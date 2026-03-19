# 0014 — Digital Atelier Design System

- **Status:** Accepted
- **Date:** 2026-03-19

## Context

Drafto's initial design system (ADR 0004) used Tailwind's default Stone/Indigo palette with sharp borders and traditional shadows. While functional, the visual identity lacked warmth, depth, and the premium feel expected of a modern note-taking app.

The "Digital Atelier" design direction introduces a warm, artisanal aesthetic — cream canvases, ghost borders, glass effects, and tonal surface architecture — while preserving the token-based, dark-mode-ready infrastructure from ADR 0004.

Key motivations:

- **Brand differentiation**: Move away from generic Tailwind defaults toward a distinctive, warm visual identity
- **No-line philosophy**: Replace visible borders with tonal surface separation, reducing visual noise
- **Glass effects**: Introduce frosted glass panels for overlays and dialogs, adding depth without heaviness
- **Consistency across platforms**: Mirror all token changes between web (CSS custom properties) and mobile (TypeScript tokens)

## Decision

Migrate all design tokens to the Digital Atelier palette:

1. **Color scales**: Shift Primary (Indigo) center to `#3525CD`, rename Accent to Secondary (Amber), add Tertiary (Teal), warm the Neutral (Stone) scale
2. **Semantic surfaces**: Warm cream canvas (`#FFF8F5`), warm dark mode (`#1F1B17`), ghost borders via `rgba()` with low opacity
3. **Surface architecture**: Add `surface-lowest`, `surface-high`, `surface-highest` tiers for tonal elevation
4. **Glass tokens**: `--glass-bg` and `--glass-blur` for frosted overlays
5. **Shadows**: Warm-tinted (`rgba(31,27,23,...)`) with large blur, zero spread
6. **Radii**: Increase all by one step (sm: 6px, md: 8px, lg: 12px, xl: 16px)
7. **Status colors**: Teal success (`#005338`), amber warning (`#855300`), material error (`#BA1A1A`)

Token infrastructure remains unchanged — CSS custom properties with `@theme inline` for Tailwind, mirrored in `apps/mobile/src/theme/tokens.ts`.

A separate UI rewrite plan (`docs/digital-atelier-ui-rewrite.md`) documents the phased component migration to fully adopt these tokens.

## Consequences

**Positive:**

- Distinctive, warm visual identity that differentiates Drafto
- Ghost borders and tonal surfaces reduce visual clutter
- Glass effects add premium depth to overlays
- Warm dark mode feels more comfortable for extended writing
- Tertiary scale enables better status/accent differentiation

**Negative:**

- All existing UI components need updating to use new tokens (tracked in UI rewrite plan)
- `accent-*` Tailwind classes renamed to `secondary-*` — all usages must be updated
- Ghost borders (`rgba()` values) may render differently on low-contrast displays
- Warm-tinted shadows are subtle — may need adjustment based on user feedback

**Neutral:**

- Token infrastructure (CSS vars + TypeScript mirror) is unchanged
- Design system showcase page updated to reflect all new tokens
- No changes to component API signatures — only visual output changes

## Alternatives Considered

1. **Keep existing palette, just add glass effects**: Rejected because the cool-gray Stone palette conflicts with the warm glass aesthetic. A cohesive warm palette was needed.

2. **Use Material Design 3 dynamic color**: Rejected as overly complex for a note-taking app. Static tokens with carefully chosen warm values give more control over the brand identity.

3. **Incremental token changes without rename**: Rejected because the Accent → Secondary rename and Tertiary addition represent a meaningful structural change that should be explicit rather than gradual.
