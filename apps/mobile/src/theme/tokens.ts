/**
 * Design system tokens mapped from the web app's CSS custom properties.
 * Mirrors apps/web/src/app/globals.css to maintain visual consistency
 * between web and mobile platforms.
 */

export const colors = {
  // Primary (Indigo)
  primary: {
    50: "#eef2ff",
    100: "#e0e7ff",
    200: "#c7d2fe",
    300: "#a5b4fc",
    400: "#818cf8",
    500: "#6366f1",
    600: "#4f46e5",
    700: "#4338ca",
    800: "#3730a3",
    900: "#312e81",
  },

  // Accent (Amber)
  accent: {
    50: "#fffbeb",
    100: "#fef3c7",
    200: "#fde68a",
    300: "#fcd34d",
    400: "#fbbf24",
    500: "#f59e0b",
    600: "#d97706",
  },

  // Neutral (Stone)
  neutral: {
    50: "#fafaf9",
    100: "#f5f5f4",
    200: "#e7e5e4",
    300: "#d6d3d1",
    400: "#a8a29e",
    500: "#78716c",
    600: "#57534e",
    700: "#44403c",
    800: "#292524",
    900: "#1c1917",
  },

  // Semantic status
  success: "#22c55e",
  warning: "#f59e0b",
  error: "#ef4444",
  info: "#3b82f6",

  // Fixed colors
  white: "#ffffff",
  black: "#000000",
} as const;

export const semantic = {
  // Surface tokens (light mode)
  bg: colors.white,
  bgSubtle: colors.neutral[50],
  bgMuted: colors.neutral[100],
  fg: colors.neutral[900],
  fgMuted: colors.neutral[600],
  fgSubtle: colors.neutral[400],
  border: colors.neutral[200],
  borderStrong: colors.neutral[300],
  ring: colors.primary[500],

  // Error surfaces
  errorBg: "#fef2f2",
  errorText: "#dc2626",
  errorBorder: "#fecaca",

  // Success surfaces
  successText: "#16a34a",

  // On-primary (text on primary-colored backgrounds)
  onPrimary: colors.white,
} as const;

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
  sm: 4,
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
