// ADR numbering checks for the factory's merge-conflict pass (ADR-0061).
//
// Every PR that adds an ADR takes the next free number in docs/adr/, so two
// PRs developed in parallel claim the same one. When main lands first the
// other PR's README index row conflicts — and when the rows happen to merge
// cleanly, git reports nothing at all while docs/adr/ quietly ends up with two
// files sharing a number. The conflict pass checks for both, and hands the
// agent the next free number to renumber the PR's own ADR to.
//
// Pure functions over file names. Callers list the names from git (a commit's
// tree, or the index mid-merge) rather than the filesystem, so an untracked
// stray file never counts.

import path from "node:path";

// docs/adr/NNNN-short-title.md. The template (0000-adr-template.md) and the
// README never collide: the template is the only 0000 and the README has no
// number.
const ADR_FILE = /^(\d{4})-.+\.md$/;

// The ADR directory as git spells it (forward slashes on every platform).
export const ADR_DIR = "docs/adr";

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
