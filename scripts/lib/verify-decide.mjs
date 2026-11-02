#!/usr/bin/env node
// Decides what the --watch Testing sweep does next with one card in the
// Testing column, the pre-In-Test verification stage (ADR-0053).
//
// Why a module: bash gathers the facts (PR state, required CI, review threads,
// feedback, lane states, the hold-cap clock) and carries the action out, but
// the rules have an order that matters and edge cases (a round left over from
// an earlier commit, the bounce cap, an unreadable thread list, the hold cap)
// that are easy to get wrong in bash and cheap to test exhaustively here. Pure:
// no I/O, no clock of its own (`now` is a fact), so every row of the matrix is
// one call in scripts/__tests__/verify-decide.test.mjs.
//
// Verification is evidence, never a gate (ADR-0035): nothing here can keep a
// card out of In Test for longer than the hold cap, and a lane's verdict never
// changes the action. The hand-backs are about the commit, not the evidence:
// the head moved, required CI is red, the commit missed the code review, or
// review threads are open, all of which In Review's fix loop exists to handle.
//
// Facts (one JSON object; missing fields read as their empty value):
//   enabled          bool   FACTORY_VERIFY=1, the canary label (if one is set)
//                           on the card, and the Testing column ready
//   prState          "OPEN" | "MERGED" | "CLOSED" | ""   (the factory PR's state)
//   headSha          the PR's head commit now
//   verifySha        the head the card's current round is for ("" = none)
//   verifyReportSha  the head the last verification report was posted for
//   requiredCi       "green" | "pending" | "red"   (required checks only)
//   lastReviewSha    the head the code-review stage last ran against
//   openThreads      unresolved review threads, or null when the query failed
//   bounces          hand-backs already spent on headSha
//   bounceMax        FACTORY_VERIFY_BOUNCE_MAX
//   newFeedback      an actionable OWNER comment newer than lastFeedbackAt
//   lanes            { shell: "<state>", browser: "<state>" }: each lane's
//                    state for headSha, the SHA already stripped (see below)
//   startedAt        verifyStartedAt (ISO), the hold-cap anchor
//   now              ISO
//   holdMaxMin       FACTORY_VERIFY_HOLD_MAX_MIN
//
// Lane states are verify-report.mjs's tokens: `reported[:<verdict>]`,
// `timeout`, `unavailable:<reason>`, `stale-branch`, `no-preview` and
// `skipped:<reason>` are TERMINAL (the lane has nothing more to do for this
// commit); anything else (`none`, `running`, the shell lane's `retry:<why>`
// and `deferred:<why>`, an unknown token) is still pending. Bash sends lanes
// that are switched off as `skipped:lane-off` and lanes that aren't built yet
// as `skipped:not-built`, so both count as done. At the hold cap a
// `deferred:<why>` lane is reported as `skipped:<why>`, a `retry:<why>` one
// as `skipped:after-<why>`.
//
// Rules, first match wins:
//   1. PR not open                              → skip (pr-merged|pr-closed|pr-unknown)
//   2. verification off                         → promote (verification-off)
//   3. head unknown                             → wait (head-unknown), or promote (hold-cap)
//   4. actionable new feedback                  → promote (feedback)
//   5. a round is open for another commit       → hand-back (head-moved)
//   6. required CI red                          → hand-back (ci-red)
//   7. head not code-reviewed                   → hand-back (not-reviewed)
//   8. open threads, bounces < bounceMax        → hand-back (threads)
//   9. no round for this head                   → init (no-round|new-round)
//  10. required CI pending                      → wait (ci-pending), or promote (hold-cap)
//  11. thread list unreadable                   → wait (threads-unknown), or promote (hold-cap)
//  12. every lane terminal                      → promote (lanes-done)
//  13. hold cap reached                         → promote (hold-cap)
//  14. otherwise                                → work-lanes (lanes-pending)
//
// `bounces` counts thread hand-backs only (bash bumps verifyBounces for those):
// the other hand-backs are bounded already, by a new commit, the fix loop's
// attempts, or a review that runs once per commit. bash reports `openThreads`
// only once required CI is green, as In Review's fix loop reads them, so a CI
// re-run with a thread open waits here instead of bouncing early.
//
// Where this departs from the table in the approved plan, and why:
//   - A closed or merged PR is checked before "verification off": draining such
//     a card to In Test would dispatch betas for code that is already merged or
//     abandoned. It stays put for the operator, like any card whose PR left.
//   - The hand-backs are checked before "init", so a card dragged into Testing
//     with red CI or an unreviewed head goes back to In Review instead of
//     getting betas and a scenario for a commit In Review hasn't finished with.
//   - A verifySha for another commit is only "the head moved" while that round
//     is still open (no report posted for it). Once its report is out, the card
//     has come back for a new commit (the revision no-op path, or a drag), so
//     it starts a new round instead of being bounced with a misleading comment.
//   - Feedback promotes before the hand-backs, init and the CI-pending wait: the
//     card is about to roll back to In Progress for a revision that replaces
//     this commit, so a fix pass in In Review, betas for this commit or waiting
//     for a CI re-run would only be wasted.
//   - An unreadable thread list waits (bounded by the hold cap) rather than
//     guessing either way.
//   - Past the bounce cap, open threads no longer hand back: the card carries
//     on, and --release still refuses the merge while any thread is open.
//
// CLI:
//   node verify-decide.mjs decide [--facts '<json>']   (facts on stdin otherwise)
//     prints one JSON line: {action, reason, ...}. promote adds `lanes`, the
//     states the report should show (still-pending lanes become
//     `skipped:<reason>`); work-lanes adds `pending`, the lanes still running.
//     Exit 0; 2 on a usage error or facts that aren't a JSON object.

import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";

export const LANES = Object.freeze(["shell", "browser"]);

const TERMINAL_KINDS = new Set([
  "reported",
  "timeout",
  "unavailable",
  "stale-branch",
  "no-preview",
  "skipped",
]);

const MIN_MS = 60 * 1000;

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function count(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

// The kind of a lane state ("reported:pass" → "reported"), lowercased; "none"
// for an empty one.
export function laneKind(state) {
  const s = str(state);
  if (!s) return "none";
  const i = s.indexOf(":");
  return (i === -1 ? s : s.slice(0, i)).toLowerCase();
}

export function isTerminalLaneState(state) {
  return TERMINAL_KINDS.has(laneKind(state));
}

// True once the round has been running for holdMaxMin minutes. A missing or
// unparseable anchor (or clock) counts as expired: the cap exists so a card
// can never be stranded, so doubt resolves toward promotion.
export function holdExpired({ startedAt, now, holdMaxMin }) {
  const start = Date.parse(str(startedAt));
  const t = Date.parse(str(now));
  const cap = Number(holdMaxMin);
  if (Number.isNaN(start) || Number.isNaN(t) || !Number.isFinite(cap) || cap < 0) return true;
  return t - start >= cap * MIN_MS;
}

// The lanes as the report should show them: still-pending lanes become
// `skipped:<reason>`, terminal ones are kept as they are. At the hold cap the
// shell lane's own pending states say more than "the hold cap was reached
// first": a lane left `deferred:<why>` (memory pressure, low disk, another
// card's run, a session limit) shows `skipped:<why>`, and one whose last
// attempt ended `retry:<why>` (an error, no result) shows
// `skipped:after-<why>`, so that attempt's outcome isn't lost.
function reportLanes(lanes, reason) {
  const out = {};
  for (const lane of LANES) {
    const state = str(lanes?.[lane]) || "none";
    const deferred = /^deferred:(.+)$/i.exec(state);
    const retry = /^retry:(.+)$/i.exec(state);
    if (isTerminalLaneState(state)) out[lane] = state;
    else if (reason === "hold-cap" && deferred) out[lane] = `skipped:${deferred[1]}`;
    else if (reason === "hold-cap" && retry) out[lane] = `skipped:after-${retry[1]}`;
    else out[lane] = `skipped:${reason}`;
  }
  return out;
}

function promote(facts, reason) {
  return { action: "promote", reason, lanes: reportLanes(facts.lanes, reason) };
}

/**
 * The one thing the Testing sweep should do with this card now.
 * @param {object} facts see the header
 * @returns {{action: "skip"|"promote"|"hand-back"|"init"|"wait"|"work-lanes", reason: string,
 *   lanes?: Record<string,string>, pending?: string[]}}
 */
export function decide(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const prState = str(f.prState).toUpperCase();
  const head = str(f.headSha);
  const verifySha = str(f.verifySha);
  const reportSha = str(f.verifyReportSha);
  const ci = str(f.requiredCi).toLowerCase();
  const threads = f.openThreads == null ? null : count(f.openThreads);
  const expired = holdExpired(f);

  if (prState !== "OPEN") {
    const reason =
      prState === "MERGED" ? "pr-merged" : prState === "CLOSED" ? "pr-closed" : "pr-unknown";
    return { action: "skip", reason };
  }
  if (f.enabled !== true) return promote(f, "verification-off");
  if (!head) return expired ? promote(f, "hold-cap") : { action: "wait", reason: "head-unknown" };
  if (f.newFeedback === true) return promote(f, "feedback");

  const roundOpenForOtherHead = verifySha !== "" && verifySha !== head && reportSha !== verifySha;
  if (roundOpenForOtherHead) return { action: "hand-back", reason: "head-moved" };
  if (ci === "red") return { action: "hand-back", reason: "ci-red" };
  if (str(f.lastReviewSha) !== head) return { action: "hand-back", reason: "not-reviewed" };
  if (threads != null && threads > 0 && count(f.bounces) < count(f.bounceMax)) {
    return { action: "hand-back", reason: "threads" };
  }
  if (verifySha === "") return { action: "init", reason: "no-round" };
  if (verifySha !== head) return { action: "init", reason: "new-round" };

  if (ci !== "green")
    return expired ? promote(f, "hold-cap") : { action: "wait", reason: "ci-pending" };
  if (threads == null) {
    return expired ? promote(f, "hold-cap") : { action: "wait", reason: "threads-unknown" };
  }

  const pending = LANES.filter((lane) => !isTerminalLaneState(f.lanes?.[lane]));
  if (pending.length === 0) return promote(f, "lanes-done");
  if (expired) return promote(f, "hold-cap");
  return { action: "work-lanes", reason: "lanes-pending", pending };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

class UsageError extends Error {}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseFacts(raw) {
  let facts;
  try {
    facts = JSON.parse(raw);
  } catch {
    throw new UsageError("facts are not valid JSON");
  }
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
    throw new UsageError("facts must be a JSON object");
  }
  return facts;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== "decide") {
    process.stdout.write(
      "Usage: verify-decide.mjs decide [--facts <json>]  (facts on stdin otherwise)\n",
    );
    return cmd && cmd !== "--help" && cmd !== "-h" ? 2 : 0;
  }
  const { flags } = parseFlags(rest);
  const raw = flags.facts ?? (await readStdin());
  process.stdout.write(JSON.stringify(decide(parseFacts(raw))) + "\n");
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(err instanceof UsageError || /^Missing value for --/.test(err.message) ? 2 : 1);
    },
  );
}
