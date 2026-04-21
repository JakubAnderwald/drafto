/**
 * Design system tokens — the single source of truth for all platforms.
 *
 * Web consumes these values via the CSS custom properties in
 * `apps/web/src/app/globals.css`. Mobile and desktop import this module
 * directly through `@drafto/shared`. A drift test in
 * `packages/shared/__tests__/design-tokens-drift.test.ts` enforces that
 * the TS values and the CSS custom properties stay in sync.
 */

export const colors = {
  // Primary (Indigo)
  primary: {
    50: "#EDE8FF",
    100: "#DBD1FF",
    200: "#B8A4FF",
    300: "#9478FF",
    400: "#6B4CFF",
    500: "#4A35E0",
    600: "#3525CD",
    700: "#2819A8",
    800: "#1E1283",
    900: "#150D5E",
  },

  // Secondary (Amber)
  secondary: {
    50: "#FFF4E0",
    100: "#FFE4B3",
    200: "#FFD180",
    300: "#FFBE4D",
    400: "#FFAB1A",
    500: "#CC8400",
    600: "#855300",
  },

  // Tertiary (Teal)
  tertiary: {
    50: "#E0F5EE",
    100: "#B3E8D6",
    200: "#80DBBD",
    300: "#4DCEA5",
    400: "#1EA866",
    500: "#007A4D",
    600: "#005338",
  },

  // Neutral (Stone — warm)
  neutral: {
    50: "#FFF8F5",
    100: "#FCF2EB",
    200: "#F4E9E0",
    300: "#EAE1DA",
    400: "#9C9590",
    500: "#6B6360",
    600: "#4E4940",
    700: "#382F28",
    800: "#251F1B",
    900: "#1F1B17",
  },

  // Semantic status
  success: "#1EA866",
  warning: "#CC8400",
  error: "#BA1A1A",
  info: "#3B82F6",

  // Fixed colors
  white: "#ffffff",
  black: "#000000",
} as const;

export const semanticLight = {
  // Surface tokens
  bg: colors.neutral[50],
  bgSubtle: colors.neutral[100],
  bgMuted: colors.neutral[200],
  bgMutedHover: colors.neutral[300],
  fg: colors.neutral[900],
  fgMuted: colors.neutral[600],
  fgSubtle: colors.neutral[400],
  border: "rgba(199, 196, 216, 0.15)",
  borderStrong: "rgba(199, 196, 216, 0.30)",
  ring: colors.primary[600],

  // Surface architecture
  surfaceLowest: colors.white,
  surfaceHigh: colors.neutral[200],
  surfaceHighest: colors.neutral[300],
  outlineVariant: "rgba(199, 196, 216, 0.20)",

  // Error surfaces
  errorBg: "#FCEEEE",
  errorText: "#BA1A1A",
  errorBorder: "#E8C4C4",
  errorHover: "#D32F2F",

  // Success surfaces
  successBg: "#E8F5EE",
  successText: "#005338",

  // Warning surfaces
  warningBg: "#FFF4E0",
  warningText: "#855300",

  // On-primary (text on primary-colored backgrounds)
  onPrimary: colors.white,
} as const;

export const semanticDark = {
  // Surface tokens (matches web app dark mode from globals.css)
  bg: "#1F1B17",
  bgSubtle: "#251F1B",
  bgMuted: "#2E2822",
  bgMutedHover: "#382F28",
  fg: "#EDE0D4",
  fgMuted: "#A89F97",
  fgSubtle: "#6B6360",
  border: "rgba(199, 196, 216, 0.10)",
  borderStrong: "rgba(199, 196, 216, 0.20)",
  ring: colors.primary[300],

  // Surface architecture
  surfaceLowest: "#171310",
  surfaceHigh: "#2E2822",
  surfaceHighest: "#382F28",
  outlineVariant: "rgba(199, 196, 216, 0.12)",

  // Error surfaces (dark variants)
  errorBg: "#2D1414",
  errorText: "#FFB4AB",
  errorBorder: "#7F1D1D",
  errorHover: "#D32F2F",

  // Success surfaces
  successBg: "#142D1E",
  successText: "#4ADE80",

  // Warning surfaces
  warningBg: "#2D2414",
  warningText: "#FFCC66",

  // On-primary (text on primary-colored backgrounds)
  onPrimary: colors.white,
} as const;

export type SemanticColors = {
  readonly bg: string;
  readonly bgSubtle: string;
  readonly bgMuted: string;
  readonly bgMutedHover: string;
  readonly fg: string;
  readonly fgMuted: string;
  readonly fgSubtle: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly ring: string;
  readonly surfaceLowest: string;
  readonly surfaceHigh: string;
  readonly surfaceHighest: string;
  readonly outlineVariant: string;
  readonly errorBg: string;
  readonly errorText: string;
  readonly errorBorder: string;
  readonly errorHover: string;
  readonly successBg: string;
  readonly successText: string;
  readonly warningBg: string;
  readonly warningText: string;
  readonly onPrimary: string;
};

export function getSemanticColors(isDark: boolean): SemanticColors {
  return isDark ? semanticDark : semanticLight;
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  "2xl": 24,
  "3xl": 32,
} as const;

export const radii = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;

export const fontSizes = {
  xs: 10,
  sm: 12,
  md: 13,
  base: 14,
  lg: 15,
  xl: 16,
  "2xl": 18,
  "3xl": 22,
  "4xl": 28,
} as const;
