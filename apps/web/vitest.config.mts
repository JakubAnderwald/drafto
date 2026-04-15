import { createRequire } from "node:module";
import path from "node:path";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Fix dual-copy React issue in pnpm monorepos.
// react-dom (symlinked to pnpm store) resolves `require('react')` to the
// pnpm store copy, but application code resolves to a separate copy in
// apps/web/node_modules/react.  We force everything to use the same copy
// by resolving react from react-dom's location, so both share one instance.
const require_ = createRequire(import.meta.url);
const reactDomPkg = require_.resolve("react-dom/package.json");
const reactDomPath = path.dirname(reactDomPkg);

// Resolve react from react-dom's directory so we get the exact same copy
// that react-dom will use internally via require('react').
const reactDomRequire = createRequire(reactDomPkg);
const reactPath = path.dirname(reactDomRequire.resolve("react/package.json"));

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      react: reactPath,
      "react-dom": reactDomPath,
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["__tests__/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
