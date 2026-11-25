import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  adrCollisions,
  adrIndexDuplicates,
  adrIndexNumbers,
  adrIndexSorted,
  allocateAdrNumber,
  conflictsOnlyOnIndexRows,
  newAdrCollisions,
  newAdrIndexDuplicates,
  newestAdrNumber,
  nextFreeAdrNumber,
  sortAdrIndex,
} from "../lib/adr-numbers.mjs";

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

  it("names the newest number in use, ignoring the template", () => {
    assert.equal(newestAdrNumber(merged), "0060");
    assert.equal(newestAdrNumber(["0000-adr-template.md", "README.md"]), null);
  });
});

// ADR-0103: the implement bundle's number, clear of main and every open PR.
describe("allocateAdrNumber", () => {
  const main = ["0000-adr-template.md", "0097-a.md", "0098-b.md", "README.md"];

  it("is one past main's newest with no open PR", () => {
    assert.equal(allocateAdrNumber({ mainNames: main }), "0099");
  });

  it("skips past every open PR's claim, and never fills a gap below one", () => {
    const claimed = [
      { pr: 901, file: "0099-x.md" },
      { pr: 902, file: "0101-y.md" },
    ];
    assert.equal(allocateAdrNumber({ mainNames: main, claimed }), "0102");
  });

  it("counts the card's own PR on a revision, and stale claims below main", () => {
    assert.equal(
      allocateAdrNumber({
        mainNames: main,
        ownNames: ["0100-mine.md"],
        claimed: [{ pr: 903, file: "0050-stale.md" }],
      }),
      "0101",
    );
  });
});

describe("the ADR index", () => {
  const head = "# ADRs\n\n| # | Title |\n| --- | --- |\n";
  const row = (n, t = `adr ${n}`) => `| [${n}](./${n}-x.md) | ${t} |\n`;

  it("reads each row's number in file order", () => {
    assert.deepEqual(adrIndexNumbers(head + row("0001") + row("0003") + row("0002")), [
      "0001",
      "0003",
      "0002",
    ]);
    assert.deepEqual(adrIndexNumbers("see [0001](./0001-x.md)\n| 0002 | bare |\n"), []);
  });

  it("finds an ADR listed on two rows, and leaves main's own duplicates out", () => {
    const text = head + row("0001") + row("0002", "old") + row("0002", "new") + row("0003");
    assert.deepEqual(adrIndexDuplicates(text), [{ number: "0002", rows: 2 }]);
    assert.deepEqual(adrIndexDuplicates(head + row("0001")), []);
    assert.deepEqual(newAdrIndexDuplicates(text, text), []);
    assert.deepEqual(newAdrIndexDuplicates(text, head + row("0001")), [
      { number: "0002", rows: 2 },
    ]);
    assert.deepEqual(newAdrIndexDuplicates(text, null), [{ number: "0002", rows: 2 }]);
  });

  it("sorts an out-of-order block of rows, keeping everything around it", () => {
    const text = head + row("0001") + row("0003") + row("0002") + "\nfooter\n";
    assert.equal(adrIndexSorted(text), false);
    const sorted = sortAdrIndex(text);
    assert.equal(sorted, head + row("0001") + row("0002") + row("0003") + "\nfooter\n");
    assert.equal(adrIndexSorted(sorted), true);
  });

  it("leaves an index alone when it is sorted, lists an ADR twice, or is split", () => {
    assert.equal(sortAdrIndex(head + row("0001") + row("0002")), null);
    assert.equal(sortAdrIndex(head + row("0002") + row("0001") + row("0002", "again")), null);
    assert.equal(sortAdrIndex(head + row("0002") + "\n" + row("0001")), null);
    assert.equal(sortAdrIndex(""), null);
  });

  // `git merge-file -p --diff3` output: union is safe only when every line of
  // every conflicting hunk, on all three sides, is an index row (ADR-0103).
  describe("conflictsOnlyOnIndexRows", () => {
    const hunk = (ours, base, theirs) =>
      `<<<<<<< ours\n${ours}||||||| base\n${base}=======\n${theirs}>>>>>>> theirs\n`;

    it("accepts rows both sides appended, or a row both sides edited", () => {
      assert.equal(conflictsOnlyOnIndexRows(head + row("0001"), 7), true);
      assert.equal(
        conflictsOnlyOnIndexRows(head + row("0001") + hunk(row("0003"), "", row("0002")), 7),
        true,
      );
      assert.equal(
        conflictsOnlyOnIndexRows(
          head + hunk(row("0001", "pr"), row("0001"), row("0001", "main")) + "\nfooter\n",
          7,
        ),
        true,
      );
    });

    it("refuses a hunk with any other line on any side", () => {
      const intro = (t) => `This directory holds the ${t}.\n`;
      // Both sides reworded the intro.
      assert.equal(
        conflictsOnlyOnIndexRows(hunk(intro("pr"), intro("base"), intro("main")) + head, 7),
        false,
      );
      // A re-padded table: the header and separator are in the hunk.
      assert.equal(
        conflictsOnlyOnIndexRows(
          hunk("| #  | Title |\n| -- | ----- |\n" + row("0002"), "", row("0003")),
          7,
        ),
        false,
      );
      // The note under the table, only on the base side.
      assert.equal(conflictsOnlyOnIndexRows(hunk(row("0002"), "note\n", "new note\n"), 7), false);
      // A blank line counts too.
      assert.equal(conflictsOnlyOnIndexRows(hunk(row("0002") + "\n", "", row("0003")), 7), false);
    });

    it("refuses an unterminated hunk, and reads markers of the size it is given", () => {
      assert.equal(conflictsOnlyOnIndexRows(`<<<<<<< ours\n${row("0002")}`, 7), false);
      const big = `${"<".repeat(9)} ours\n${row("0002")}${"=".repeat(9)}\nprose\n${">".repeat(9)} theirs\n`;
      assert.equal(conflictsOnlyOnIndexRows(big, 9), false);
      assert.equal(conflictsOnlyOnIndexRows(big.replace("prose", row("0003").trim()), 9), true);
    });
  });
});
