import expoFlat from "eslint-config-expo/flat.js";
import prettier from "eslint-config-prettier";

/** @type {import("eslint").Linter.Config[]} */
const eslintConfig = [
  ...expoFlat,
  prettier,
  {
    ignores: [".expo/**", "dist/**", "node_modules/**"],
  },
];

export default eslintConfig;
