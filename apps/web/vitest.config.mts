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

// `@sentry/nextjs`'s Node entry re-exports the build-time `withSentryConfig`
// webpack plugin. Since 10.72 that plugin lives in `@sentry/server-utils`,
// whose vendored CJS shim picks its `import.meta.url` polyfill by branching on
// `typeof document`. These tests run in jsdom, where `document` exists, so the
// shim feeds `fileURLToPath()` an http: URL derived from `document.baseURI`
// and throws "The URL must be of scheme file" at import time — breaking every
// test file that transitively imports Sentry.
//
// jsdom is a browser-like environment, so resolve the build Sentry publishes
// for its `browser` export condition instead: it exposes the same capture APIs
// (re-exported from `@sentry/react`) and never loads the build-time plugin.
// We take the `require` (CJS) variant because the ESM one imports `next/constants`
// extensionless, which Vite's stricter ESM resolver rejects. The path is read
// from Sentry's own exports map so an upstream restructure fails loudly here
// rather than silently regressing.
const sentryPkgPath = require_.resolve("@sentry/nextjs/package.json");
const sentryBrowserEntry = path.resolve(
  path.dirname(sentryPkgPath),
  require_(sentryPkgPath).exports["."].browser.require,
);

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      react: reactPath,
      "react-dom": reactDomPath,
      "@sentry/nextjs": sentryBrowserEntry,
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
