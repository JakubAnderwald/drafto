// ADR numbering checks for the factory's merge-conflict pass (ADR-0061), its
// union merge of the README index and the implement-time number (ADR-0105).
//
// Every PR that adds an ADR takes the next free number in docs/adr/, so two
// PRs developed in parallel claim the same one. When main lands first the
// other PR's README index row conflicts — and when the rows happen to merge
// cleanly, git reports nothing at all while docs/adr/ quietly ends up with two
// files sharing a number. The conflict pass checks for both, and hands the
// agent the next free number to renumber the PR's own ADR to.
//
// Pure functions over file names and the index text. Callers list the names
// from git (a commit's tree, or the index mid-merge) rather than the
// filesystem, so an untracked stray file never counts.

import path from "node:path";

// docs/adr/NNNN-short-title.md. The template (0000-adr-template.md) and the
// README never collide: the template is the only 0000 and the README has no
// number.
const ADR_FILE = /^(\d{4})-.+\.md$/;

// The ADR directory as git spells it (forward slashes on every platform).
export const ADR_DIR = "docs/adr";

// The index of every ADR: one table row per ADR, its first cell a link
// `[NNNN](./NNNN-short-title.md)`.
export const ADR_INDEX = `${ADR_DIR}/README.md`;

// Numbers carried by more than one ADR file, each with its files sorted, in
// number order: [{ number: "0059", files: ["0059-a.md", "0059-b.md"] }].
export function adrCollisions(fileNames) {
  const byNumber = new Map();
  for (const name of fileNames) {
    const m = ADR_FILE.exec(path.basename(name));
    if (!m) continue;
    const files = byNumber.get(m[1]) ?? [];
    files.push(path.basename(name));
    byNumber.set(m[1], files);
  }
  return [...byNumber.entries()]
    .filter(([, files]) => files.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([number, files]) => ({ number, files: files.sort() }));
}

// Collisions in <fileNames> that main does not already have. A duplicate that
// is on main itself is not this PR's to fix, and counting it would fail every
// conflict pass on the card until its retry budget ran out.
export function newAdrCollisions(fileNames, mainFileNames) {
  const onMain = new Set(adrCollisions(mainFileNames).map((c) => c.number));
  return adrCollisions(fileNames).filter((c) => !onMain.has(c.number));
}

// The number one past the highest in use, zero-padded: "0061" after 0060.
export function nextFreeAdrNumber(fileNames) {
  let highest = 0;
  for (const name of fileNames) {
    const m = ADR_FILE.exec(path.basename(name));
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  return String(highest + 1).padStart(4, "0");
}

// The highest number in use, zero-padded, or null when there is none. The
// template's 0000 counts as none.
export function newestAdrNumber(fileNames) {
  const next = Number(nextFreeAdrNumber(fileNames));
  return next > 1 ? String(next - 1).padStart(4, "0") : null;
}

// The number a card's new ADR takes at implement time (ADR-0105): one past the
// highest that main, another open PR (`claimed`, [{pr, file}]) or the card's
// own PR (`ownNames`, on a revision) uses. A gap below the highest is never
// reused: a stale PR may still hold it.
export function allocateAdrNumber({ mainNames = [], ownNames = [], claimed = [] } = {}) {
  const claimedNames = (claimed ?? []).map((c) => (typeof c === "string" ? c : (c?.file ?? "")));
  return nextFreeAdrNumber([...mainNames, ...ownNames, ...claimedNames]);
}

// ── The README index ────────────────────────────────────────────────────────

// An index row: a table row whose first cell links an ADR by number.
const INDEX_ROW = /^\|\s*\[(\d{4})\]\(/;

// The number of each index row, in file order.
export function adrIndexNumbers(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => INDEX_ROW.exec(line)?.[1])
    .filter(Boolean);
}

// Whether every conflicting hunk of a 3-way merge of the index is made of index
// rows only. <merged> is `git merge-file -p --diff3 --marker-size=<markerSize>`
// output: each hunk is `<<<…` ours `|||…` base `===…` theirs `>>>…`, and every
// line of all three sides must be a row. The union driver is safe there: it
// keeps both sides' rows, and a row both sides edited shows up as an ADR listed
// twice (adrIndexDuplicates). On any other line, such as the intro, the "when
// to write an ADR" list, or the table's header and separator that a re-padded
// table rewrites, union would quietly keep both wordings (ADR-0105).
//
// The markers are read strictly: a hunk is exactly one of each, in that order,
// and a marker-like line anywhere else (a setext `=======` underline, say) is
// neither a row nor a marker, so it refuses union rather than being mistaken
// for a separator. A hunk where a side dropped a base row (a row deleted on one
// side, edited on the other) refuses too: union would keep the edited row and
// quietly undo the deletion.
export function conflictsOnlyOnIndexRows(merged, markerSize) {
  const marker = (ch) => new RegExp(`^\\${ch}{${markerSize}}(?: |$)`);
  // In hunk order: what each marker opens.
  const markers = [
    [marker("<"), "ours"],
    [marker("|"), "base"],
    [marker("="), "theirs"],
    [marker(">"), null],
  ];
  let at = -1; // index into markers of the last one seen; -1 outside a hunk
  let rows = null;
  for (const line of String(merged ?? "").split("\n")) {
    const seen = markers.findIndex(([re]) => re.test(line));
    if (seen !== -1) {
      if (seen !== (at + 1) % markers.length) return false;
      if (seen === 0) rows = { ours: new Set(), base: new Set(), theirs: new Set() };
      if (seen === 3) {
        for (const n of rows.base) if (!rows.ours.has(n) || !rows.theirs.has(n)) return false;
      }
      at = seen === 3 ? -1 : seen;
      continue;
    }
    if (at === -1) continue;
    const row = INDEX_ROW.exec(line);
    if (!row) return false;
    rows[markers[at][1]].add(row[1]);
  }
  return at === -1;
}

// Numbers the index lists on more than one row: [{ number, rows }], in number
// order. The factory merges the index with git's union driver (ADR-0105), which
// keeps every line either side added. Two PRs that both edited one row (a
// status change on each side) leave two rows for one ADR, which only a person
// or the conflict pass can reconcile.
export function adrIndexDuplicates(text) {
  const counts = new Map();
  for (const number of adrIndexNumbers(text)) counts.set(number, (counts.get(number) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, rows]) => rows > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([number, rows]) => ({ number, rows }));
}

// Duplicates in <text> that main's index (<mainText>) doesn't already have.
export function newAdrIndexDuplicates(text, mainText) {
  const onMain = new Set(adrIndexDuplicates(mainText).map((d) => d.number));
  return adrIndexDuplicates(text).filter((d) => !onMain.has(d.number));
}

function isSorted(numbers) {
  return numbers.every((n, i) => i === 0 || numbers[i - 1] <= n);
}

// Whether the index rows are in number order.
export function adrIndexSorted(text) {
  return isSorted(adrIndexNumbers(text));
}

// The index with its rows in number order, or null when there is nothing to
// do or it isn't safe to: the rows are already sorted, a number is listed
// twice, or the rows aren't one unbroken block of lines. The union merge keeps
// the PR's new row and main's in the order git met them, so a PR that took
// 0100 while main merged 0099 would otherwise list 0100 first.
export function sortAdrIndex(text) {
  const lines = String(text ?? "").split("\n");
  const at = [];
  lines.forEach((line, i) => {
    if (INDEX_ROW.test(line)) at.push(i);
  });
  if (at.length < 2) return null;
  if (at[at.length - 1] - at[0] !== at.length - 1) return null;
  const rows = at.map((i) => lines[i]);
  const numbers = rows.map((row) => INDEX_ROW.exec(row)[1]);
  if (isSorted(numbers) || new Set(numbers).size !== numbers.length) return null;
  const sorted = rows
    .map((row, i) => ({ row, number: numbers[i] }))
    .sort((a, b) => a.number.localeCompare(b.number))
    .map((r) => r.row);
  return [...lines.slice(0, at[0]), ...sorted, ...lines.slice(at[at.length - 1] + 1)].join("\n");
}
