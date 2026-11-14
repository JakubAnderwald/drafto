// Reads the result tables the factory's locked-down runners print: the browser
// runner's `| # | Step | Result | Evidence |` table (ADR-0051), the shell
// lane's checks table (ADR-0053) and the macOS harness's `report.md`
// (ADR-0043).
//
// Why this is its own module: verify-report.mjs imports browser-report.mjs for
// the secret scan, and browser-report.mjs (through evidence-embed.mjs) needs
// this parser to put each screenshot under the step that took it (ADR-0072).
// Kept here, with no imports, it can be used by both without an import cycle.
// verify-report.mjs re-exports both functions for its existing callers.

// The cells of one Markdown table row, trimmed. A `\|` inside a cell is an
// escaped pipe, not a separator.
export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

const RESULT_WORD = /\b(PASS(?:ED)?|FAIL(?:ED|URE)?|WARN(?:ING)?|SKIP(?:PED)?)\b/i;

// Rows of every Markdown table in <markdown> that has a Result column:
// [{ num, step, result, evidence }], result one of PASS|FAIL|WARN|SKIP or null.
export function parseResultTable(markdown) {
  const rows = [];
  let header = null;
  for (const raw of String(markdown ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      header = null;
      continue;
    }
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (!header) {
      const names = cells.map((c) => c.replace(/[*_`]/g, "").trim().toLowerCase());
      header = {
        result: names.indexOf("result"),
        step: names.indexOf("step"),
        num: names.indexOf("#"),
        evidence: names.indexOf("evidence"),
      };
      continue;
    }
    if (header.result === -1) continue;
    const m = RESULT_WORD.exec(cells[header.result] ?? "");
    const stepIdx =
      header.step !== -1
        ? header.step
        : cells.findIndex((_, i) => i !== header.result && i !== header.num);
    rows.push({
      num: header.num !== -1 ? (cells[header.num] ?? "") : "",
      step: cells[stepIdx] ?? "",
      result: m ? m[1].slice(0, 4).toUpperCase() : null,
      evidence: header.evidence !== -1 ? (cells[header.evidence] ?? "") : "",
    });
  }
  return rows;
}
