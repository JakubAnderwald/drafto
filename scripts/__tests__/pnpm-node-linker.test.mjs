import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The monorepo installs a hoisted (flat) node_modules. The iOS and macOS builds
// need it: CocoaPods header resolution breaks under pnpm's default symlinked
// layout (#196), and the Podfiles build React Native from the hoisted copy.
//
// The setting lives in pnpm-workspace.yaml as `nodeLinker: hoisted`. It used to
// be `node-linker=hoisted` in the root .npmrc, but npm reads that file too and
// warns on every run that the pnpm-only key will stop working (#328).
//
// pnpm ignores a key it doesn't recognise, so a typo, a nested key or the
// kebab-case spelling would not fail anything. The next clean install (a new
// worktree, CI, the factory's offline install) would quietly fall back to the
// symlinked `isolated` layout and break the native builds. These tests pin it.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKSPACE = resolve(root, "pnpm-workspace.yaml");
const NPMRC = resolve(root, ".npmrc");
const MODULES_YAML = resolve(root, "node_modules", ".modules.yaml");

// A top-level (unindented) `nodeLinker:` mapping key, with the rest of its line.
const NODE_LINKER_KEY = /^nodeLinker:(.*)$/gm;
// The .npmrc spelling: `node-linker=…`, optionally indented or spaced.
const NPMRC_NODE_LINKER = /^[ \t]*node-linker[ \t]*=/m;

// The scalar after the key. YAML starts a comment only at a `#` that follows
// whitespace, so `hoisted#x` is the whole (wrong) value, not `hoisted`.
const scalarValue = (rest) =>
  rest
    .replace(/(?:^|[ \t])#.*$/, "")
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");

describe("pnpm node linker", () => {
  const workspace = readFileSync(WORKSPACE, "utf8");

  it("sets a single top-level nodeLinker: hoisted in pnpm-workspace.yaml", () => {
    const values = [...workspace.matchAll(NODE_LINKER_KEY)].map((match) => scalarValue(match[1]));
    assert.deepEqual(values, ["hoisted"]);
  });

  it("does not spell the key the .npmrc way in pnpm-workspace.yaml", () => {
    assert.doesNotMatch(workspace, /^\s*node-linker\s*:/m);
  });

  it("keeps node-linker out of a root .npmrc, if one is ever added", () => {
    // A root .npmrc may come back for something npm also understands (a
    // registry, an auth token). It must not carry the pnpm-only key again.
    if (!existsSync(NPMRC)) return;
    assert.doesNotMatch(readFileSync(NPMRC, "utf8"), NPMRC_NODE_LINKER);
  });

  it(
    "installed node_modules with the hoisted linker",
    { skip: !existsSync(MODULES_YAML) && "node_modules is not installed" },
    () => {
      // pnpm records the linker it actually used. This catches a pnpm that
      // doesn't read the setting from pnpm-workspace.yaml at all.
      const modules = JSON.parse(readFileSync(MODULES_YAML, "utf8"));
      assert.equal(modules.nodeLinker, "hoisted");
    },
  );
});
