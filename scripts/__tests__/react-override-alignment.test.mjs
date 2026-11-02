import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// React is installed at the version the root package.json's pnpm.overrides pins,
// whatever a workspace declares (ADR-0027). A declaration that differs is inert
// and misleading: #635 left three apps declaring 19.3.0 while 19.2.8 was
// installed. Keep every declaration equal to the override, so React only moves
// by editing the override and the declarations together.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

const REACT_FAMILY = ["react", "react-dom", "react-test-renderer"];
const WORKSPACES = [
  "apps/web/package.json",
  "apps/mobile/package.json",
  "apps/desktop/package.json",
  "packages/shared/package.json",
];

const overrides = readJson("package.json").pnpm?.overrides ?? {};

describe("React declarations match the root pnpm.overrides pin", () => {
  it("pins every React package in pnpm.overrides", () => {
    for (const name of REACT_FAMILY) {
      assert.match(
        overrides[name] ?? "",
        /^\d+\.\d+\.\d+$/,
        `pnpm.overrides.${name} should be an exact version`,
      );
    }
  });

  for (const workspace of WORKSPACES) {
    it(`${workspace} declares the overridden versions`, () => {
      const pkg = readJson(workspace);
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
        for (const name of REACT_FAMILY) {
          const declared = pkg[field]?.[name];
          if (declared === undefined) continue;
          assert.equal(
            declared,
            overrides[name],
            `${workspace} ${field}.${name} is ${declared}, but pnpm.overrides installs ${overrides[name]}`,
          );
        }
      }
    });
  }
});
