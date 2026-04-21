# 0020 — Shared Design Tokens in `@drafto/shared`

- **Status**: Accepted
- **Date**: 2026-04-21
- **Authors**: Jakub Anderwald

## Context

Drafto ships on four platforms (web, iOS, Android, macOS) that must present a visually consistent UI. Prior to this ADR, the design tokens (palette scales, semantic light/dark tokens, spacing, radii, font sizes) were duplicated across three source files:

1. `apps/web/src/app/globals.css` — CSS custom properties consumed by Tailwind's `@theme inline` directive.
2. `apps/mobile/src/theme/tokens.ts` — plain TypeScript constants, explicitly documented as "Mirrors apps/web/src/app/globals.css".
3. `apps/desktop/src/theme/tokens.ts` — byte-identical copy of the mobile file.

The mirror relationship was maintained manually. A Wave 1 audit of the design system found silent drift: the dark-mode `--ring` variable in `globals.css` was left at the old pre-migration palette value (`#a5b4fc`) when the Digital Atelier palette was introduced in ADR 0014, while the TS tokens correctly pointed at `colors.primary[300]` (`#9478FF`). Nothing in the build or test pipeline detected the mismatch.

With primitives (Waves 2+) about to consume spacing, font sizes, and semantic colors from TS on mobile/desktop, any future divergence would compound into user-visible rendering differences between platforms.

## Decision

`packages/shared/src/design-tokens.ts` becomes the single source of truth for design tokens. Mobile and desktop import tokens from `@drafto/shared`. Web continues to declare CSS custom properties in `apps/web/src/app/globals.css` because Tailwind CSS v4 needs them at the stylesheet level — but a drift test in `packages/shared/__tests__/design-tokens-drift.test.ts` parses `globals.css` and asserts every palette and semantic token matches the TypeScript value byte-for-byte (modulo hex case and whitespace).

Concretely:

- Mobile and desktop `src/theme/tokens.ts` files are now pure re-export shims for `colors`, `semanticLight`, `semanticDark`, `getSemanticColors`, `SemanticColors`, `spacing`, `radii`, and `fontSizes`. The `@/theme/tokens` import surface is preserved so no screen or component had to change.
- The drift test runs as part of `pnpm test` in `packages/shared` and is therefore part of Turborepo's standard CI pipeline.

The dark-mode `--ring` drift discovered during this refactor was reconciled by updating `globals.css` to match the TS value (the TS side was authoritative because it correctly used the new palette).

## Consequences

- **Positive**:
  - One edit changes all platforms: update `packages/shared/src/design-tokens.ts` and the mobile/desktop apps pick it up automatically via the `@drafto/shared` workspace dependency.
  - The drift test fails CI if anyone changes `globals.css` or `design-tokens.ts` without the other, making silent drift impossible.
  - Wave 2+ primitives (shared buttons, inputs, etc. on mobile/desktop) can import `spacing`, `radii`, and `fontSizes` directly from `@drafto/shared` with zero duplication risk.
- **Negative**:
  - Adding a new token now requires two edits (TS + CSS) in the same PR instead of one, because the drift test runs against both.
  - The drift test uses a hand-rolled regex parser rather than a real CSS AST, so very exotic CSS structures could confuse it. Current usage is simple enough that this is acceptable.
- **Neutral**:
  - Mobile and desktop `theme/tokens.ts` files are now 20-line re-export shims; the files still exist to preserve the `@/theme/tokens` import convention in each app.

## Alternatives Considered

1. **Generate `globals.css` from the TS tokens at build time** (e.g. a Tailwind plugin or a prebuild script that writes the `@theme inline` block from `@drafto/shared`). This was rejected for now because it adds build-time moving parts and couples the web app's Tailwind pipeline to the shared package. The drift test achieves the same correctness guarantee with far less complexity. This can be revisited if maintenance of the two-sided edits becomes painful.
2. **Keep the manual mirror**. This is the status quo and was rejected because the audit already found drift; without automated enforcement, the next drift was inevitable.
3. **Put tokens directly in `apps/mobile/src/theme/tokens.ts` and have desktop re-export from mobile**. Rejected because `apps/mobile` is an Expo app with React Native and Expo dependencies, and importing from an app package into another app package violates the workspace convention that apps depend on packages (not on other apps).
