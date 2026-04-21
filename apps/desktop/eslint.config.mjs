import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Design system guardrails for React Native (desktop — macOS).
// Forbid hardcoded typography scale (fontSize: <number>) and hex color string
// literals assigned to color/backgroundColor/borderColor props — forces code
// through the shared tokens in apps/desktop/src/theme/tokens.ts.
// To suppress for a legitimate exception (e.g. an emoji glyph sized as a
// visual, not typography), add:
//   // eslint-disable-next-line no-restricted-syntax -- <reason>
// on the preceding line.
const designSystemRestrictedSyntax = [
  {
    // Matches numeric Literal nodes (value is a number) assigned to fontSize.
    // esquery treats Literal.value as its JS type, so we target the `raw`
    // string representation to catch integer and decimal literals.
    selector: "Property[key.name='fontSize'] > Literal[raw=/^[0-9]+(?:\\.[0-9]+)?$/]",
    message:
      "Use fontSizes tokens from @/theme/tokens (fontSizes.md, fontSizes.xl, ...) instead of raw numeric fontSize values. See docs/features/design-system.md.",
  },
  {
    // Note: `shadowColor` is intentionally excluded — React Native's native
    // shadow API takes a bare color (typically `"#000"`) and separates the
    // intensity via `shadowOpacity`/`shadowRadius`, so there is no semantic
    // shadow-color token to swap in.
    selector:
      "Property[key.name=/^(backgroundColor|color|borderColor|borderTopColor|borderBottomColor|borderLeftColor|borderRightColor|tintColor)$/] > Literal[value=/^#[0-9a-fA-F]{3,8}$/]",
    message:
      "Use semantic or palette tokens from @/theme/tokens (semantic.fg, colors.primary[500], ...) instead of raw hex color values. See docs/features/design-system.md.",
  },
];

/** @type {import("eslint").Linter.Config[]} */
const eslintConfig = [
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: ["node_modules/**", "macos/**"],
  },
  {
    // Scope guardrails to UI source trees; keep tests, configs, jest setup
    // out to avoid false positives on mock values.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...designSystemRestrictedSyntax],
    },
  },
];

export default eslintConfig;
