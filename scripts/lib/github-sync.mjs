#!/usr/bin/env node
// Wrappers around the gh CLI for the support agent's GitHub-side flows.
//
// The agent already relies on the gh CLI on the Mac mini (Stage 2 nightly
// auto-implementation, the failure-issue path in support-agent.sh). Reusing
// it here keeps the auth model identical: no new tokens, no new env vars.
//
// Subcommands (called from scripts/support-agent.sh during --comment-sync
// and --state-sync):
//   list-support-issues [--state <open|closed|all>] [--limit <n>]
//        Returns the support-labelled issues, with body + createdAt + labels
//        + state + stateReason (Phase G state-sync needs the latter two).
//
//   list-new-comments <issue-number> --since <iso> [--bot-user <login>]
//        Returns issue comments newer than --since AND not authored by
//        --bot-user. Defaults bot-user to JakubAnderwald (the human auth on
//        the Mac mini — anything *we* post via gh appears as that login,
//        whether by Stage 2's auto-impl Claude session or by manual reply,
//        so we filter all of it out of the customer-facing forward).
//
//   find-linked-thread <issue-number>
//        Reads the issue body and returns the `zoho-thread-id` field from the
//        agent's footer. Empty string if no footer or no field.
//
//   state-change-info <issue-number> [--bot-user <login>]
//        Returns `{zoho_thread_id, platforms, lastComment}` for the issue.
//        Used by Phase G --state-sync to enrich a transition into a
//        github_state_change bundle. `platforms` is derived from the
//        closing PR's changed paths; `lastComment` is the most recent
//        non-bot comment body, used as the human-readable reason text on
//        `closed/not_planned` / `duplicate` transitions.
//
// All subcommands print JSON (or a plain string for find-linked-thread) to
// stdout and exit 0. Errors print `{"error": "..."}` to stderr and exit
// non-zero — same shape as zoho-cli.mjs / state-cli.mjs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";
import { parseIssueFooter } from "./parse-issue-footer.mjs";

const execFileP = promisify(execFile);

const REPO = "JakubAnderwald/drafto";
const DEFAULT_BOT_USER = "JakubAnderwald";

// Hidden marker the support pipeline writes onto bot-authored progress
// comments that we DO want forwarded to the customer (Phase G):
//   - nightly-support.sh's "Working on it now" / "Hit a blocker" / "Fix in
//     review" comments.
//   - post-release-notes.mjs's "Now live in <platform> <build>" comments.
// Without this marker, the default bot-author filter (introduced to break
// the customer→GH→Zoho echo loop on "Customer replied via support@..."
// forwards) would also suppress legitimate progress updates. The marker is
// stripped from the customer-facing reply by build-bundle.mjs before the
// model sees it, so it never leaks into outbound mail.
export const PROGRESS_MARKER = "<!-- drafto-progress -->";

let _execFileForTests = null;
let _sleepForTests = null;

export function _setExecFileForTests(impl) {
  _execFileForTests = impl;
}

export function _setSleepForTests(impl) {
  _sleepForTests = impl;
}

// Transient errors we should retry rather than surface to the caller. Real
// case from 2026-05-05: GitHub returned `HTTP 504: 504 Gateway Timeout` to
// `gh issue list`, the support-agent's --state-sync mode exited 1, and the
// failure-issue trap filed issue #376. The next 5-minute tick would have
// succeeded — retrying inline keeps a transient hiccup from spamming
// nightly-failure issues.
function isTransientGhError(err) {
  const text = `${err?.message ?? ""} ${err?.stderr ?? ""} ${err?.stdout ?? ""}`;
  if (/\bHTTP\s+(?:429|500|502|503|504)\b/i.test(text)) return true;
  if (/\bgateway\s+time-?out\b/i.test(text)) return true;
  if (/\b(?:ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED)\b/i.test(text)) {
    return true;
  }
  // gh prints a generic "connection reset"/"i/o timeout" line on flaky
  // networks where the upstream HTTP code is unavailable.
  if (/\b(?:connection reset|i\/o timeout|temporary failure)\b/i.test(text)) return true;
  return false;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000];

async function runGh(args) {
  const fn = _execFileForTests ?? execFileP;
  const sleep = _sleepForTests ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastError;
  // One initial attempt + up to RETRY_DELAYS_MS.length retries.
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      // 16 MiB output cap — gh api --paginate can return large JSON arrays for
      // long-lived issues; the default 1 MiB cap was hit during dev.
      const { stdout } = await fn("gh", args, { maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    } catch (err) {
      lastError = err;
      if (attempt === RETRY_DELAYS_MS.length || !isTransientGhError(err)) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

export async function listSupportIssues({ state = "all", limit = 200 } = {}) {
  const stdout = await runGh([
    "issue",
    "list",
    "--repo",
    REPO,
    "--label",
    "support",
    "--state",
    state,
    "--json",
    "number,title,state,stateReason,body,createdAt,labels",
    "--limit",
    String(limit),
  ]);
  return JSON.parse(stdout);
}

export async function listIssueComments(issueNumber) {
  const stdout = await runGh(["api", "--paginate", `repos/${REPO}/issues/${issueNumber}/comments`]);
  // gh api --paginate concatenates pages by emitting the merged array as a
  // single JSON document. Defensive parse: if it ever changes to NDJSON we'd
  // see a parse error and the caller would log + skip.
  return JSON.parse(stdout);
}

export async function getIssueBody(issueNumber) {
  const stdout = await runGh([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    REPO,
    "--json",
    "body",
  ]);
  const data = JSON.parse(stdout);
  return data?.body ?? "";
}

// Pure (no IO) — kept exported so tests can drive it without the gh shim.
// GitHub usernames are case-insensitive (the API normalises display, but
// JSON payloads can vary in casing across endpoints), so the bot-user match
// lowercases both sides to avoid a silent miss like `jakubanderwald` vs
// `JakubAnderwald` where the customer-side reply would be forwarded back to
// the customer (an echo loop).
//
// Bot-authored comments are filtered out by default — except those carrying
// the progress marker (`<!-- drafto-progress -->`), which the support
// pipeline uses to tag deliberate customer-facing progress updates that
// must reach the customer regardless of who posted them. See PROGRESS_MARKER
// above for the full list of writers.
export function filterNewComments(comments, sinceIso, botUser = DEFAULT_BOT_USER) {
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  if (Number.isNaN(since)) {
    throw new Error(`filterNewComments: --since is not a valid ISO timestamp: ${sinceIso}`);
  }
  const botUserLower = (botUser ?? "").toLowerCase();
  return (Array.isArray(comments) ? comments : []).filter((c) => {
    const author = (c?.user?.login ?? c?.author?.login ?? "").toLowerCase();
    const body = typeof c?.body === "string" ? c.body : "";
    if (author === botUserLower && !body.includes(PROGRESS_MARKER)) return false;
    const t = Date.parse(c?.created_at ?? c?.createdAt ?? "");
    if (Number.isNaN(t)) return false;
    return t > since;
  });
}

export async function findLinkedThread(issueNumber) {
  const body = await getIssueBody(issueNumber);
  const fields = parseIssueFooter(body);
  return fields?.["zoho-thread-id"] ?? "";
}

// Pure: bucket changed file paths into the platform-tag set the prompt
// uses to choose between "live on drafto.eu now" vs "we'll email you when
// it's live". Anything outside `apps/{web,mobile,desktop}/` is ignored
// (shared `packages/`, root configs, etc. don't pin a single platform).
export function derivePlatforms(files) {
  const set = new Set();
  for (const entry of Array.isArray(files) ? files : []) {
    const path = typeof entry === "string" ? entry : (entry?.path ?? entry?.filename ?? "");
    if (typeof path !== "string") continue;
    if (path.startsWith("apps/web/")) set.add("web");
    else if (path.startsWith("apps/mobile/")) set.add("mobile");
    else if (path.startsWith("apps/desktop/")) set.add("desktop");
  }
  return [...set].sort();
}

function normaliseStateReason(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  return s === "" || s === "null" ? null : s;
}

// Pure: compare current support-issue states against the persisted
// `lastKnownState` map and return one entry per issue that needs handling.
// Bootstrap entries (no prior state) are flagged so the runner can record
// them without firing a customer email — otherwise the first run after this
// PR lands would email every closed support issue retroactively.
export function diffStateChanges(issues, lastKnownState = {}) {
  const changes = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    const number = issue?.number;
    if (number == null) continue;
    const newState = {
      state: String(issue?.state ?? "").toLowerCase(),
      state_reason: normaliseStateReason(issue?.stateReason),
    };
    const known = lastKnownState?.[String(number)] ?? null;
    if (!known || typeof known !== "object" || !known.state) {
      changes.push({ issueNumber: number, oldState: null, newState, isBootstrap: true });
      continue;
    }
    const oldState = {
      state: String(known.state ?? "").toLowerCase(),
      state_reason: normaliseStateReason(known.state_reason),
    };
    if (oldState.state !== newState.state || oldState.state_reason !== newState.state_reason) {
      changes.push({ issueNumber: number, oldState, newState, isBootstrap: false });
    }
  }
  return changes;
}

// Pure: pull `Closes #N` / `Fixes #N` / `Resolves #N` style refs out of a
// commit message or PR body. Used by scripts/comment-released-issues.mjs to
// map merged PRs back to the support issues they closed.
export function extractIssueRefs(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const refs = new Set();
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) refs.add(Number(m[1]));
  // Also match the long-form GitHub URL — Dependabot and a few external
  // tools write that instead of the shorthand.
  const urlRe =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)\b/gi;
  while ((m = urlRe.exec(text)) !== null) refs.add(Number(m[1]));
  return [...refs].sort((a, b) => a - b);
}

export async function getClosingPrFiles(issueNumber) {
  let raw;
  try {
    raw = await runGh([
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      REPO,
      "--json",
      "closedByPullRequestsReferences",
    ]);
  } catch {
    return [];
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const refs = data?.closedByPullRequestsReferences ?? [];
  if (!Array.isArray(refs) || refs.length === 0) return [];
  // The latest PR (highest number) is the actual fix in the rare case there
  // were multiple — duplicates / superseded PRs come earlier. GitHub's
  // GraphQL `closedByPullRequestsReferences` doesn't document an ordering
  // guarantee, so sort explicitly by number rather than trusting array
  // position.
  const pr = refs
    .map((ref) => Number(ref?.number))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)
    .at(-1);
  if (!pr) return [];
  let prRaw;
  try {
    prRaw = await runGh(["pr", "view", String(pr), "--repo", REPO, "--json", "files"]);
  } catch {
    return [];
  }
  let prData;
  try {
    prData = JSON.parse(prRaw);
  } catch {
    return [];
  }
  return Array.isArray(prData?.files) ? prData.files : [];
}

// Window inside which a non-bot comment is plausibly the closing rationale.
// Picked to cover both `gh issue close --comment "..."` (which posts the
// comment seconds before/after the close event) and the GitHub web UI
// "Close with comment" affordance.
const CLOSING_COMMENT_WINDOW_MS = 60_000;

// Returns the comment body that explains the most recent close event, or
// `null` if no comment can be tied to the closure. We match by (a) the
// actor who closed the issue, and (b) a temporal window around the close
// event. Without these correlations, the "last non-bot comment" heuristic
// would surface unrelated reporter chatter as a "Reason: ..." in the
// customer-facing not_planned/duplicate email, which is worse than
// silence — see PR #352 / CodeRabbit review.
export async function getClosingComment(issueNumber, botUser = DEFAULT_BOT_USER) {
  let eventsRaw;
  try {
    eventsRaw = await runGh(["api", "--paginate", `repos/${REPO}/issues/${issueNumber}/events`]);
  } catch {
    return null;
  }
  let events;
  try {
    events = JSON.parse(eventsRaw);
  } catch {
    return null;
  }
  if (!Array.isArray(events) || events.length === 0) return null;
  // GitHub returns events oldest-first; the most recent close is the one
  // we care about (an issue may be closed→reopened→closed multiple times).
  let closeEvent = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.event === "closed") {
      closeEvent = events[i];
      break;
    }
  }
  if (!closeEvent) return null;
  const closeTime = Date.parse(closeEvent.created_at ?? "");
  const closer = (closeEvent.actor?.login ?? "").toLowerCase();
  if (Number.isNaN(closeTime) || !closer) return null;

  let commentsRaw;
  try {
    commentsRaw = await runGh([
      "api",
      "--paginate",
      `repos/${REPO}/issues/${issueNumber}/comments`,
    ]);
  } catch {
    return null;
  }
  let comments;
  try {
    comments = JSON.parse(commentsRaw);
  } catch {
    return null;
  }
  if (!Array.isArray(comments) || comments.length === 0) return null;

  const botUserLower = (botUser ?? "").toLowerCase();
  let best = null;
  for (const c of comments) {
    const author = (c?.user?.login ?? c?.author?.login ?? "").toLowerCase();
    if (!author || author === botUserLower) continue;
    if (author !== closer) continue;
    const t = Date.parse(c?.created_at ?? c?.createdAt ?? "");
    if (Number.isNaN(t)) continue;
    if (Math.abs(t - closeTime) > CLOSING_COMMENT_WINDOW_MS) continue;
    const body = c?.body;
    if (typeof body !== "string" || body.length === 0) continue;
    if (!best || t > Date.parse(best.created_at ?? best.createdAt ?? "")) best = c;
  }
  return best?.body ?? null;
}

export async function getStateChangeInfo(issueNumber, { botUser = DEFAULT_BOT_USER } = {}) {
  const [body, files, lastComment] = await Promise.all([
    getIssueBody(issueNumber),
    getClosingPrFiles(issueNumber),
    getClosingComment(issueNumber, botUser),
  ]);
  const fields = parseIssueFooter(body);
  return {
    zoho_thread_id: fields?.["zoho-thread-id"] ?? "",
    platforms: derivePlatforms(files),
    lastComment,
  };
}

async function main(argv) {
  const [sub, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);
  switch (sub) {
    case "list-support-issues":
      return listSupportIssues({
        state: flags.state ?? "all",
        limit: Number(flags.limit ?? 200),
      });
    case "list-new-comments": {
      const issueNumber = positional[0];
      if (!issueNumber) throw new Error("list-new-comments requires <issue-number>");
      if (!flags.since) throw new Error("list-new-comments requires --since <iso>");
      const comments = await listIssueComments(issueNumber);
      return filterNewComments(comments, flags.since, flags["bot-user"] ?? DEFAULT_BOT_USER);
    }
    case "find-linked-thread": {
      const issueNumber = positional[0];
      if (!issueNumber) throw new Error("find-linked-thread requires <issue-number>");
      return findLinkedThread(issueNumber);
    }
    case "state-change-info": {
      const issueNumber = positional[0];
      if (!issueNumber) throw new Error("state-change-info requires <issue-number>");
      return getStateChangeInfo(issueNumber, {
        botUser: flags["bot-user"] ?? DEFAULT_BOT_USER,
      });
    }
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        "Usage: github-sync.mjs <list-support-issues [--state <s>] [--limit <n>]|" +
          "list-new-comments <issue-number> --since <iso> [--bot-user <login>]|" +
          "find-linked-thread <issue-number>|" +
          "state-change-info <issue-number> [--bot-user <login>]>\n",
      );
      return null;
    default:
      throw new Error(`Unknown subcommand: ${sub}`);
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => {
      if (out === null || out === undefined) return;
      // find-linked-thread returns a bare string; everything else is JSON.
      // Bash callers parse JSON for arrays / objects, so emit the canonical
      // pretty-printed form, but leave plain strings raw (the bash side
      // captures them as `$(node github-sync.mjs find-linked-thread N)` and
      // expects a value, not `"value"`).
      if (typeof out === "string") process.stdout.write(out);
      else process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    },
    (err) => {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(1);
    },
  );
}
