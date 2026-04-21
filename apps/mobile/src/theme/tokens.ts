/**
 * Design system tokens for the mobile app.
 *
 * The canonical values live in `@drafto/shared` (`packages/shared/src/design-tokens.ts`).
 * This module re-exports them so existing `@/theme/tokens` imports continue to work.
 * The web app mirrors these values as CSS custom properties in
 * `apps/web/src/app/globals.css`; a drift test in `packages/shared/__tests__/`
 * enforces that the two stay in sync.
 */

export {
  colors,
  semanticLight,
  semanticDark,
  getSemanticColors,
  spacing,
  radii,
  fontSizes,
} from "@drafto/shared";
export type { SemanticColors } from "@drafto/shared";
