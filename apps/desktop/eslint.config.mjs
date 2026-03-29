import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/** @type {import("eslint").Linter.Config[]} */
const eslintConfig = [
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: ["node_modules/**", "macos/**"],
  },
];

export default eslintConfig;
