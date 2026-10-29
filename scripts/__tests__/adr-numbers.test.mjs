import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { adrCollisions, newAdrCollisions, nextFreeAdrNumber } from "../lib/adr-numbers.mjs";

describe("adr-numbers", () => {
  // #755 after main gained #757's and #762's ADRs.
  const merged = [
    "0000-adr-template.md",
    "0058-revision-blocks-return-to-test.md",
    "0059-desktop-pkce-native-csprng.md",
    "0059-keep-login-page-out-of-search-index.md",
    "0060-dedicated-factory-build-volume.md",
    "README.md",
  ];

  it("finds numbers shared by more than one ADR, ignoring the README and template", () => {
    assert.deepEqual(adrCollisions(merged), [
      {
        number: "0059",
        files: [
          "0059-desktop-pkce-native-csprng.md",
          "0059-keep-login-page-out-of-search-index.md",
        ],
      },
    ]);
    assert.deepEqual(adrCollisions(["0001-a.md", "0002-b.md", "README.md"]), []);
  });

  it("accepts paths as well as bare names", () => {
    assert.deepEqual(adrCollisions(["docs/adr/0003-a.md", "docs/adr/0003-b.md"]), [
      { number: "0003", files: ["0003-a.md", "0003-b.md"] },
    ]);
  });

  it("does not count a clash main already has as new", () => {
    const main = ["0010-x.md", "0010-y.md", "0011-z.md"];
    assert.deepEqual(newAdrCollisions([...main, "0012-pr.md"], main), []);
    assert.deepEqual(newAdrCollisions([...main, "0011-pr.md"], main), [
      { number: "0011", files: ["0011-pr.md", "0011-z.md"] },
    ]);
  });

  it("gives the number after the highest in use", () => {
    assert.equal(nextFreeAdrNumber(merged), "0061");
    assert.equal(nextFreeAdrNumber(["README.md"]), "0001");
    assert.equal(nextFreeAdrNumber(["0999-a.md"]), "1000");
  });
});
