import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseResultTable, splitRow } from "../lib/result-table.mjs";
import * as verifyReport from "../lib/verify-report.mjs";

// The result-table parser moved out of verify-report.mjs so evidence-embed.mjs
// (imported by browser-report.mjs) can put each screenshot under the step that
// took it without an import cycle (ADR-0072). These tests lock in what it
// reads from the runners' tables, and that verify-report.mjs's existing
// callers still get the very same functions through its re-export.

describe("splitRow", () => {
  it("returns the trimmed cells, with or without the outer pipes", () => {
    assert.deepEqual(splitRow("| a | b |"), ["a", "b"]);
    assert.deepEqual(splitRow("a | b"), ["a", "b"]);
    assert.deepEqual(splitRow("   |  a  |   "), ["a"]);
    assert.deepEqual(splitRow("| a || b |"), ["a", "", "b"]);
  });

  it("keeps an escaped pipe inside its cell", () => {
    assert.deepEqual(splitRow("| a \\| b | c |"), ["a \\| b", "c"]);
    assert.deepEqual(splitRow("| x \\|\\| y | z |"), ["x \\|\\| y", "z"]);
  });

  it("doesn't take an escaped pipe at the end of a row for the closing pipe", () => {
    assert.deepEqual(splitRow("| a | b \\|"), ["a", "b \\|"]);
  });
});

describe("parseResultTable", () => {
  const TABLE = [
    "| # | Step | Result | Evidence |",
    "|---|------|:------:|----------|",
    "| 1 | Sign in | PASS | screenshot 1 |",
    "| 2 | Open the note \\| check its title | **FAILED** | screenshots 2–3 |",
    "| 3 | Delete it | maybe | — |",
  ].join("\n");

  it("reads each row's number, step, result and evidence", () => {
    assert.deepEqual(parseResultTable(TABLE), [
      { num: "1", step: "Sign in", result: "PASS", evidence: "screenshot 1" },
      {
        num: "2",
        step: "Open the note \\| check its title",
        result: "FAIL",
        evidence: "screenshots 2–3",
      },
      { num: "3", step: "Delete it", result: null, evidence: "—" },
    ]);
  });

  it("normalises the result word to PASS, FAIL, WARN or SKIP", () => {
    const rows = parseResultTable(
      [
        "| # | Step | Result |",
        "|---|---|---|",
        "| 1 | a | passed |",
        "| 2 | b | ❌ FAILURE |",
        "| 3 | c | Warning |",
        "| 4 | d | skipped |",
        "| 5 | e | bypass |",
      ].join("\n"),
    );
    assert.deepEqual(
      rows.map((r) => r.result),
      ["PASS", "FAIL", "WARN", "SKIP", null],
    );
  });

  it("reads a header whose names are bold or code", () => {
    const rows = parseResultTable(
      ["| **#** | `Step` | __Result__ |", "| --- | --- | --- |", "| 7 | x | PASS |"].join("\n"),
    );
    assert.deepEqual(rows, [{ num: "7", step: "x", result: "PASS", evidence: "" }]);
  });

  it("takes the first other column as the step when there is no Step column", () => {
    const rows = parseResultTable(
      ["| # | Check | Result |", "|---|---|---|", "| 1 | lint | FAIL |"].join("\n"),
    );
    assert.deepEqual(rows, [{ num: "1", step: "lint", result: "FAIL", evidence: "" }]);
  });

  it("ignores a table that has no Result column", () => {
    const md = [
      "| Name | Value |",
      "|---|---|",
      "| a | PASS |",
      "",
      "| Check | Result |",
      "|---|---|",
      "| typecheck | WARN |",
    ].join("\n");
    assert.deepEqual(parseResultTable(md), [
      { num: "", step: "typecheck", result: "WARN", evidence: "" },
    ]);
    assert.deepEqual(parseResultTable("| Name | Value |\n|---|---|\n| a | PASS |"), []);
  });

  it("ends a table at the first line that isn't a table row", () => {
    const md = [
      "| # | Step | Result |",
      "| 1 | a | PASS |",
      "Some prose.",
      "| x | y |",
      "| 2 | FAIL |",
    ].join("\n");
    assert.deepEqual(parseResultTable(md), [{ num: "1", step: "a", result: "PASS", evidence: "" }]);
  });

  it("reads CRLF line endings, and nothing from empty input", () => {
    assert.deepEqual(
      parseResultTable("| # | Step | Result |\r\n|---|---|---|\r\n| 1 | a | SKIP |"),
      [{ num: "1", step: "a", result: "SKIP", evidence: "" }],
    );
    assert.deepEqual(parseResultTable(""), []);
    assert.deepEqual(parseResultTable(null), []);
    assert.deepEqual(parseResultTable(undefined), []);
  });
});

describe("verify-report.mjs re-export", () => {
  it("re-exports parseResultTable and splitRow as the same functions", () => {
    assert.equal(verifyReport.parseResultTable, parseResultTable);
    assert.equal(verifyReport.splitRow, splitRow);
  });
});
