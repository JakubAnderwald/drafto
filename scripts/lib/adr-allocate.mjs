#!/usr/bin/env node
// The ADR number a card's new ADR takes, for the implement bundle (ADR-0105).
//
// Every PR that adds an ADR took the next free number on main, so two cards
// implemented while the other's PR was still open took the same one. Once one
// merged, the other conflicted on the README index and a Claude conflict pass
// renumbered it. Like the migration versions of ADR-0079, the factory now
// picks the number at implement time: one past the highest that main, any
// other open PR, or (on a revision) the card's own PR uses.
//
// Two implement runs that start before either opens its PR can still pick the
// same number. The conflict pass catches that at merge time (adrCollisions and
// adrIndexDuplicates in worktree-cli.mjs merge-main).
//
// CLI (prints one JSON object; exit 1 with {error} on a failure):
//   next-adr [--root <repo>] [--own-pr <n>] [--remote origin]
//       Fetches main, lists the numbered ADR files each open PR adds or renames
//       into docs/adr/ (the same per-PR files sweep as next-version) and prints
//       {mainNewest, next, own, claimed, skipped}. `next` is the number to use;
//       `own` the ADR files the card's own PR (--own-pr, on a revision) already
//       adds; `claimed` other open PRs' ADRs above main's newest, [{pr, file}];
//       `skipped` PRs whose files couldn't be listed. Throws when main can't be
//       fetched, the open PRs can't be listed, --own-pr's files can't be, or
//       the sweep runs out of time; bash then leaves the bundle's field null.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { ADR_DIR, allocateAdrNumber, newestAdrNumber } from "./adr-numbers.mjs";
import { isMainModule } from "./is-main.mjs";
import { fetchMain, gaveUpReason, makeGit, sweepClaims } from "./migration-renumber.mjs";
import { parseFlags } from "./parse-flags.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// A claim's path: a numbered ADR directly under docs/adr. The template is 0000
// and never added again; the README has no number.
export const ADR_CLAIM_PATH_RE = /^docs\/adr\/\d{4}-[^/]+\.md$/;

// Basenames of the files directly under docs/adr in <ref>'s tree.
function adrNamesAt(cwd, ref) {
  const res = makeGit(cwd)(["ls-tree", "--name-only", ref, `${ADR_DIR}/`]);
  return String(res.stdout)
    .split("\n")
    .filter(Boolean)
    .map((f) => path.posix.basename(f));
}

export function nextAdr({ cwd = DEFAULT_ROOT, ownPr = null, remote = "origin", gh, now } = {}) {
  const fetched = fetchMain({ cwd, remote });
  if (!fetched.ok || !fetched.main) {
    throw new Error(`couldn't fetch main: ${fetched.detail ?? "no origin/main"}`);
  }
  const mainNames = adrNamesAt(cwd, fetched.main);
  const sweep = sweepClaims({
    gh,
    now,
    cwd,
    pathRe: ADR_CLAIM_PATH_RE,
    what: "ADR numbers",
    who: "adr-allocate",
  });
  if (sweep.gaveUp) throw new Error(gaveUpReason(sweep));
  const { claimed, skipped } = sweep;
  if (ownPr !== null && skipped.includes(ownPr)) {
    throw new Error(`couldn't list PR #${ownPr}'s files, so its ADR numbers are unknown`);
  }
  const own = claimed.filter((c) => c.pr === ownPr).map((c) => c.file);
  const others = claimed.filter((c) => c.pr !== ownPr);
  const mainNewest = newestAdrNumber(mainNames);
  return {
    mainNewest,
    next: allocateAdrNumber({ mainNames, ownNames: own, claimed: others }),
    own,
    // Claims at or below main's newest can't take the next number.
    claimed: others.filter((c) => mainNewest === null || c.file.slice(0, 4) > mainNewest),
    skipped: skipped.filter((n) => n !== ownPr),
  };
}

export function main(argv, { gh, now } = {}) {
  const [sub, ...rest] = argv;
  const { flags } = parseFlags(rest);
  if (sub !== "next-adr") {
    throw new Error("Usage: adr-allocate.mjs next-adr [--root <repo>] [--own-pr <n>]");
  }
  let ownPr = null;
  if (flags["own-pr"] !== undefined) {
    if (!/^\d+$/.test(flags["own-pr"])) throw new Error("--own-pr must be a PR number");
    ownPr = Number(flags["own-pr"]);
  }
  return nextAdr({
    cwd: flags.root ?? DEFAULT_ROOT,
    ownPr,
    remote: flags.remote ?? "origin",
    gh,
    now,
  });
}

if (isMainModule(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ error: err.message })}\n`);
    process.exitCode = 1;
  }
}
