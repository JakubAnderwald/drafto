#!/usr/bin/env node
// Ship merged support fixes as beta builds: the decisions behind
// scripts/nightly-support.sh Phase 4 (ADR-0042).
//
// Why the RUNNER does this and not the Claude session that wrote the fix: on
// #658 the session started the Fastlane lanes as background tasks and ended its
// turn; `claude -p` exited and took the lanes with it ~4 s in, so the fix never
// shipped and nobody was told. Now the session stops at the merge, and the bash
// runner — which can wait — dispatches the lanes through dispatch-release.mjs,
// waits for them, and retries on later nights. This module is the part of that
// worth testing: what still needs a build, whether main is green, and what a
// finished lane actually delivered.
//
// "Delivered" means the Fastlane post-hook (comment-released-issues.mjs) posted
// `<!-- now-live:<platform>:<build> -->` on the issue — the same notice the
// support agent forwards to the reporter. A lane that exits 0 without it did not
// get the news to anyone, so it counts as a failed attempt.
//
// Subcommands (JSON on stdout; errors as {"error": …} on stderr, exit 1):
//   pending [--window-days N] [--max-failures N] [--state-file P] [--flag-expired]
//        Support issues closed as completed in the last N days (default
//        $SUPPORT_RELEASE_WINDOW_DAYS or 14) whose merged closing PR touched a
//        native app, minus the platforms already announced since the issue's
//        latest close and the ones that have failed N times (default
//        $SUPPORT_RELEASE_MAX_FAILURES or 3). Prints
//          {sha, issues:[{number, closedAt, platforms}], lanes:{mobile, desktop},
//           releaseIssues, laneIssues:{mobile, desktop}, expired:[…], errors:[…]}
//        `sha` is origin/main's head — the commit every lane builds. `laneIssues`
//        are the per-lane --release-issues CSVs: a mobile-only fix must not be
//        announced by the macOS build.
//        `expired` lists fixes that left the window unshipped (closed up to
//        EXPIRED_GRACE_DAYS before it); with --flag-expired each is labelled
//        needs-manual-intervention with one operator comment, so a fix that only
//        ever hit "not tonight" (CI red, root busy, volume unmounted) can't run out
//        of window silently. `errors` lists issues a GitHub call failed for —
//        skipped tonight, not fatal for the rest.
//   main-ci <sha> [--wait-min 45] [--interval-sec 30]
//        Poll the branch-protection required checks of <sha> (fallback: every
//        check run on it). Exit 0 green, 1 failed, 2 timed out.
//   settle --pending-file P --lanes mobile=<rc>,desktop=<rc>
//          [--logs mobile=<path>,desktop=<path>] [--max-failures N] [--state-file P]
//        After the lanes finished (<rc> = exit code, or a word such as "killed"):
//        for every pending issue/platform whose lane ran, record ok/fail by
//        whether the now-live notice appeared. At N failures, label the issue
//        needs-manual-intervention and leave an operator comment (no progress
//        marker — it is not forwarded to the reporter) naming the lane log.
//
// main-ci exits 3 (not 1) when it could not judge CI at all (bad argument,
// unexpected error), so the runner never reports a tool error as "CI failed".
//
// Retry state lives in logs/support-release-state.json, NOT support-state.json:
// support-agent.sh rewrites that file every minute through state-cli.mjs, whose
// load → mutate → save is not a transaction, so a second writer could silently
// drop one of its cursor updates (and re-send a customer email). The nightly is
// the only writer of this file.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";
import { derivePlatforms } from "./dispatch-release.mjs";
import { hasNowLive } from "./now-live.mjs";

const execFileP = promisify(execFile);
const REPO = "JakubAnderwald/drafto";
const REPO_OWNER = "JakubAnderwald";
const REPO_NAME = "drafto";

export const DEFAULT_WINDOW_DAYS = 14;
// How long after leaving the window an unshipped fix is still looked at — only
// to flag it. A few nights, so one missed nightly run can't skip the flag.
export const EXPIRED_GRACE_DAYS = 3;
export const DEFAULT_MAX_FAILURES = 3;
export const GAVE_UP_LABEL = "needs-manual-intervention";

export const DEFAULT_RELEASE_STATE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "logs",
  "support-release-state.json",
);

let _execFileForTests = null;
export function _setExecFileForTests(impl) {
  _execFileForTests = impl;
}
let _sleepForTests = null;
export function _setSleepForTests(impl) {
  _sleepForTests = impl;
}

async function run(cmd, args) {
  const fn = _execFileForTests ?? execFileP;
  const { stdout } = await fn(cmd, args, { maxBuffer: 32 * 1024 * 1024 });
  return String(stdout ?? "");
}
const sleep = (ms) =>
  (_sleepForTests ?? ((t) => new Promise((resolve) => setTimeout(resolve, t))))(ms);

// ── Pure helpers ────────────────────────────────────────────────────────────

// Store platforms a lane ships. mobile = `release:beta:all` (Android, then
// iOS); desktop = the macOS lane.
const LANE_PLATFORMS = Object.freeze({ mobile: ["android", "ios"], desktop: ["macos"] });

export function laneForPlatform(platform) {
  if (platform === "android" || platform === "ios") return "mobile";
  if (platform === "macos") return "desktop";
  return null;
}

// Beta platforms for a PR's changed files (packages/shared ships to both apps;
// apps/web deploys itself and needs no beta).
export function betaPlatformsForFiles(files) {
  const list = Array.isArray(files) ? files.join("\n") : String(files ?? "");
  const p = derivePlatforms(list);
  return [...(p.mobile ? LANE_PLATFORMS.mobile : []), ...(p.desktop ? LANE_PLATFORMS.desktop : [])];
}

// "YYYY-MM-DD" N days before `now`, for GitHub's `closed:>=` search.
export function windowStartDate(now, days) {
  const ms = (now instanceof Date ? now.getTime() : Date.parse(now)) - days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function emptyReleaseState() {
  return { issues: {} };
}

// Failures count against ONE fix: the record carries the issue's closedAt at the
// time, and a record from an earlier close (the issue was reopened and fixed
// again) no longer counts — the new fix gets a fresh budget, just as the
// now-live check ignores the old fix's notices. A record without closedAt
// (written by hand via state-cli) always counts.
export function releaseFailures(state, issueNumber, platform, { closedAt } = {}) {
  const rec = state?.issues?.[String(issueNumber)]?.releaseAttempts?.[platform];
  const n = rec?.failures;
  if (!Number.isInteger(n) || n <= 0) return 0;
  if (closedAt && rec.closedAt && rec.closedAt !== closedAt) return 0;
  return n;
}

// Record one attempt. ok resets the failure count (a later regression starts a
// fresh budget); fail increments it — from zero when the previous record belongs
// to an earlier close. Returns the updated record.
export function recordReleaseAttempt(state, issueNumber, platform, result, now, { closedAt } = {}) {
  if (result !== "ok" && result !== "fail") {
    throw new Error(`release attempt result must be ok|fail (got ${JSON.stringify(result)})`);
  }
  if (!["android", "ios", "macos"].includes(platform)) {
    throw new Error(`unknown release platform ${JSON.stringify(platform)} (android|ios|macos)`);
  }
  state.issues ??= {};
  const key = String(issueNumber);
  state.issues[key] ??= {};
  state.issues[key].releaseAttempts ??= {};
  const prev = state.issues[key].releaseAttempts[platform] ?? {};
  const prior = releaseFailures(state, key, platform, { closedAt });
  const failures = result === "ok" ? 0 : prior + 1;
  const rec = { failures, lastAttemptAt: now, lastResult: result };
  const close = closedAt ?? prev.closedAt;
  if (close) rec.closedAt = close;
  state.issues[key].releaseAttempts[platform] = rec;
  return rec;
}

export function resetReleaseAttempts(state, issueNumber) {
  const key = String(issueNumber);
  if (state?.issues?.[key]) delete state.issues[key].releaseAttempts;
}

// Which platforms of one closed issue still need a beta.
//   issue:   {number, closedAt}
//   prs:     [{state, baseRefName, files}] — the issue's closing PRs
//   comments: the issue's comments ({body, created_at})
export function pendingPlatformsForIssue({ issue, prs, comments, state, maxFailures }) {
  const wanted = new Set();
  for (const pr of prs ?? []) {
    if (pr?.state !== "MERGED" || pr?.baseRefName !== "main") continue;
    for (const p of betaPlatformsForFiles(pr.files)) wanted.add(p);
  }
  return ["android", "ios", "macos"].filter(
    (p) =>
      wanted.has(p) &&
      !hasNowLive(comments, p, { since: issue.closedAt }) &&
      releaseFailures(state, issue.number, p, { closedAt: issue.closedAt }) < maxFailures,
  );
}

// Shape the `pending` output from the per-issue results.
export function summarizePending(sha, pendingIssues) {
  const issues = (pendingIssues ?? []).filter((i) => i.platforms.length > 0);
  const laneIssue = (lane) =>
    issues
      .filter((i) => i.platforms.some((p) => laneForPlatform(p) === lane))
      .map((i) => i.number)
      .sort((a, b) => a - b)
      .join(",");
  const laneIssues = { mobile: laneIssue("mobile"), desktop: laneIssue("desktop") };
  return {
    sha,
    issues,
    lanes: { mobile: laneIssues.mobile !== "", desktop: laneIssues.desktop !== "" },
    releaseIssues: issues
      .map((i) => i.number)
      .sort((a, b) => a - b)
      .join(","),
    laneIssues,
  };
}

const CHECK_PASS = new Set(["success", "neutral", "skipped"]);
const STATUS_PASS = new Set(["success"]);
const STATUS_FAIL = new Set(["failure", "error"]);

// Latest outcome per check name: "pass" | "fail" | "pending". A re-run leaves
// the earlier run on the commit, so only the newest (highest id) counts.
export function latestCheckOutcomes({ checkRuns = [], statuses = [] } = {}) {
  const byName = new Map();
  for (const r of checkRuns) {
    const prev = byName.get(r.name);
    if (!prev || Number(r.id) > Number(prev.id)) byName.set(r.name, r);
  }
  const out = {};
  for (const [name, r] of byName) {
    if (r.status !== "completed") out[name] = "pending";
    else out[name] = CHECK_PASS.has(String(r.conclusion)) ? "pass" : "fail";
  }
  // The combined-status endpoint already reports the latest status per context.
  for (const s of statuses) {
    if (out[s.context]) continue;
    out[s.context] = STATUS_PASS.has(s.state)
      ? "pass"
      : STATUS_FAIL.has(s.state)
        ? "fail"
        : "pending";
  }
  return out;
}

// green | failed | pending for the required contexts (or every check when the
// required set is unknown — an unreadable protection rule must not pass a red
// commit, and "no checks at all" is not green).
export function evaluateChecks({ required = [], outcomes = {} }) {
  const names = required.length > 0 ? required : Object.keys(outcomes);
  if (names.length === 0) return "pending";
  const states = names.map((n) => outcomes[n] ?? "pending");
  if (states.includes("fail")) return "failed";
  return states.every((s) => s === "pass") ? "green" : "pending";
}

// ── I/O ─────────────────────────────────────────────────────────────────────

async function ghJson(args) {
  return JSON.parse(await run("gh", args));
}

export async function loadReleaseState(file = DEFAULT_RELEASE_STATE_PATH) {
  try {
    const raw = await fs.readFile(file, "utf8");
    if (!raw.trim()) return emptyReleaseState();
    const parsed = JSON.parse(raw);
    return parsed &&
      typeof parsed === "object" &&
      parsed.issues &&
      typeof parsed.issues === "object"
      ? parsed
      : emptyReleaseState();
  } catch (err) {
    if (err.code === "ENOENT") return emptyReleaseState();
    throw err;
  }
}

// Atomic (temp file + rename), mode 0600 — the support-state.json convention.
export async function saveReleaseState(state, file = DEFAULT_RELEASE_STATE_PATH) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function listClosedSupportIssues(sinceDate) {
  const data = await ghJson([
    "issue",
    "list",
    "--repo",
    REPO,
    "--label",
    "support",
    "--state",
    "closed",
    "--search",
    `closed:>=${sinceDate}`,
    "--json",
    "number,stateReason,closedAt",
    "--limit",
    "200",
  ]);
  return (Array.isArray(data) ? data : [])
    .filter((i) => String(i?.stateReason ?? "").toUpperCase() === "COMPLETED")
    .map((i) => ({ number: Number(i.number), closedAt: i.closedAt ?? null }))
    .filter((i) => Number.isInteger(i.number) && i.number > 0);
}

// No --jq: `gh api --paginate` merges an array response's pages into one array.
async function issueComments(issueNumber) {
  const data = await ghJson(["api", "--paginate", `repos/${REPO}/issues/${issueNumber}/comments`]);
  return Array.isArray(data) ? data : [];
}

async function closingPrs(issueNumber) {
  const view = await ghJson([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    REPO,
    "--json",
    "closedByPullRequestsReferences",
  ]);
  const refs = (view?.closedByPullRequestsReferences ?? []).filter((r) => {
    const repo = r?.repository;
    if (!repo) return true;
    return (
      String(repo.name ?? "").toLowerCase() === REPO_NAME &&
      String(repo.owner?.login ?? REPO_OWNER).toLowerCase() === REPO_OWNER.toLowerCase()
    );
  });
  const prs = [];
  for (const ref of refs) {
    const n = Number(ref?.number);
    if (!Number.isInteger(n) || n <= 0) continue;
    const pr = await ghJson([
      "pr",
      "view",
      String(n),
      "--repo",
      REPO,
      "--json",
      "number,state,baseRefName",
    ]);
    // `gh pr diff --name-only`, not `--json files`: the latter stops at 100.
    const files =
      pr?.state === "MERGED"
        ? (await run("gh", ["pr", "diff", String(n), "--repo", REPO, "--name-only"]))
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    prs.push({ number: n, state: pr?.state, baseRefName: pr?.baseRefName, files });
  }
  return prs;
}

// origin/main's head without touching any local checkout (the nightly runs in
// the primary checkout, which must not move). gh first, then git ls-remote.
async function mainHeadSha() {
  try {
    const sha = (await run("gh", ["api", `repos/${REPO}/commits/main`, "--jq", ".sha"])).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  } catch {
    /* fall through */
  }
  const out = await run("git", ["ls-remote", "origin", "refs/heads/main"]);
  const sha = out.split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("could not resolve origin/main");
  return sha;
}

function expiredMarker(closedAt) {
  return `<!-- drafto-nightly-release-expired:${closedAt ?? "open"} -->`;
}

export function expiredComment({ platforms, closedAt, windowDays }) {
  return [
    `**Nightly beta release window closed — ${platforms.join(", ")} never shipped.**`,
    "",
    `The fix for this issue merged (closed ${closedAt}), but no "now live" ${platforms.join("/")} build ` +
      `landed within the ${windowDays}-day nightly window. Nights that could not attempt a build — main CI ` +
      "red or still running, a build root in use, the build volume unmounted — spend no attempt, so the " +
      "give-up never fired. The nightly runner will not try again; `logs/nightly-*.log` on the Mac mini has " +
      "the `Phase 4:` lines for each night.",
    "",
    `Ship it by hand: ${platforms.map((p) => `\`${manualCommand(p)}\``).join(" · ")}.`,
    "",
    expiredMarker(closedAt),
  ].join("\n");
}

export async function computePending({
  windowDays = DEFAULT_WINDOW_DAYS,
  maxFailures = DEFAULT_MAX_FAILURES,
  statePath = DEFAULT_RELEASE_STATE_PATH,
  now = new Date(),
  flagExpired = false,
} = {}) {
  const state = await loadReleaseState(statePath);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const windowStartMs = nowMs - windowDays * 86_400_000;
  // Look a few days past the window too, only to catch fixes that ran out of it.
  const closed = await listClosedSupportIssues(
    windowStartDate(now, windowDays + EXPIRED_GRACE_DAYS),
  );
  const results = [];
  const expired = [];
  const errors = [];
  for (const issue of closed) {
    // One issue's GitHub failure (a diff too large for `gh pr diff`, a 502) must
    // not stop every other fix from shipping: skip it tonight and say so.
    try {
      const prs = await closingPrs(issue.number);
      // Cheap pre-check before fetching comments: no native change, nothing to do.
      if (!prs.some((pr) => pr.state === "MERGED" && betaPlatformsForFiles(pr.files).length > 0)) {
        continue;
      }
      const comments = await issueComments(issue.number);
      const platforms = pendingPlatformsForIssue({ issue, prs, comments, state, maxFailures });
      if (platforms.length === 0) continue;
      const closedMs = Date.parse(issue.closedAt ?? "");
      if (Number.isNaN(closedMs) || closedMs >= windowStartMs) {
        results.push({ number: issue.number, closedAt: issue.closedAt, platforms });
        continue;
      }
      const marker = expiredMarker(issue.closedAt);
      const alreadyFlagged = comments.some(
        (c) => typeof c?.body === "string" && c.body.includes(marker),
      );
      const entry = { number: issue.number, closedAt: issue.closedAt, platforms, alreadyFlagged };
      if (flagExpired && !alreadyFlagged) {
        await run("gh", [
          "issue",
          "edit",
          String(issue.number),
          "--repo",
          REPO,
          "--add-label",
          GAVE_UP_LABEL,
        ]);
        await run("gh", [
          "issue",
          "comment",
          String(issue.number),
          "--repo",
          REPO,
          "--body",
          expiredComment({ platforms, closedAt: issue.closedAt, windowDays }),
        ]);
        entry.flagged = true;
      }
      expired.push(entry);
    } catch (err) {
      errors.push({ number: issue.number, error: err.message });
    }
  }
  const summary = summarizePending(null, results);
  summary.expired = expired;
  summary.errors = errors;
  // Only resolve the sha when there is something to build: an empty night
  // should cost one search query, not three.
  summary.sha = summary.issues.length > 0 ? await mainHeadSha() : null;
  return summary;
}

async function requiredContexts() {
  try {
    const data = await ghJson([
      "api",
      `repos/${REPO}/branches/main/protection/required_status_checks`,
    ]);
    const names = new Set([
      ...(data?.contexts ?? []),
      ...(data?.checks ?? []).map((c) => c?.context).filter(Boolean),
    ]);
    return [...names];
  } catch {
    return [];
  }
}

async function commitChecks(sha) {
  // Per-page --jq on an object response (pages don't merge): one JSON object per
  // line, parsed as NDJSON.
  const lines = await run("gh", [
    "api",
    "--paginate",
    `repos/${REPO}/commits/${sha}/check-runs?per_page=100`,
    "--jq",
    ".check_runs[] | {id, name, status, conclusion}",
  ]);
  const checkRuns = lines
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  let statuses = [];
  try {
    const combined = await ghJson(["api", `repos/${REPO}/commits/${sha}/status?per_page=100`]);
    statuses = Array.isArray(combined?.statuses) ? combined.statuses : [];
  } catch {
    statuses = [];
  }
  return { checkRuns, statuses };
}

// Poll until green / failed / out of time. A failed poll (gh hiccup) is just a
// pending one: the deadline still bounds it.
export async function waitForMainCi({
  sha,
  waitMs = 45 * 60_000,
  intervalMs = 30_000,
  clock = () => Date.now(),
} = {}) {
  const required = await requiredContexts();
  const deadline = clock() + waitMs;
  let outcomes = {};
  for (;;) {
    let result = "pending";
    try {
      outcomes = latestCheckOutcomes(await commitChecks(sha));
      result = evaluateChecks({ required, outcomes });
    } catch (err) {
      process.stderr.write(`support-release main-ci: poll failed (${err.message}); retrying\n`);
    }
    if (result !== "pending") return { sha, result, required, checks: outcomes };
    if (clock() + intervalMs > deadline)
      return { sha, result: "timeout", required, checks: outcomes };
    await sleep(intervalMs);
  }
}

function parseLaneMap(csv) {
  const out = {};
  for (const pair of String(csv ?? "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const lane = pair.slice(0, eq).trim();
    if (lane !== "mobile" && lane !== "desktop") continue;
    out[lane] = pair.slice(eq + 1).trim();
  }
  return out;
}

function gaveUpMarker(platform, closedAt) {
  return `<!-- drafto-nightly-release-gave-up:${platform}:${closedAt ?? "open"} -->`;
}

function manualCommand(platform) {
  if (platform === "android") return "cd apps/mobile && pnpm release:beta:android";
  if (platform === "ios") return "cd apps/mobile && pnpm release:beta:ios";
  return "cd /Users/jakub/code/drafto && git pull && cd apps/desktop && pnpm release:beta   # fossil checkout, NEVER pnpm install";
}

export function gaveUpComment({ issueNumber, platform, failures, laneResult, logPath, closedAt }) {
  return [
    `**Nightly beta release gave up on ${platform}.**`,
    "",
    `The fix for this issue is merged, but ${failures} nightly attempt(s) to ship it did not produce a ` +
      `"now live" ${platform} build (last lane outcome: \`${laneResult}\`). The nightly runner will not retry it.`,
    "",
    `Lane log on the Mac mini: \`${logPath || "(no log recorded)"}\``,
    "",
    `To retry: fix the cause, run \`node scripts/lib/state-cli.mjs reset-release-attempts ${issueNumber}\` ` +
      `on the Mac mini and remove the \`${GAVE_UP_LABEL}\` label — or ship it by hand: \`${manualCommand(platform)}\`.`,
    "",
    gaveUpMarker(platform, closedAt),
  ].join("\n");
}

export async function settle({
  pending,
  lanes,
  logs = {},
  maxFailures = DEFAULT_MAX_FAILURES,
  statePath = DEFAULT_RELEASE_STATE_PATH,
  now = new Date().toISOString(),
} = {}) {
  const state = await loadReleaseState(statePath);
  const settled = [];
  let dirty = false;
  for (const issue of pending?.issues ?? []) {
    const ranPlatforms = issue.platforms.filter((p) => lanes[laneForPlatform(p)] !== undefined);
    if (ranPlatforms.length === 0) continue;
    let comments;
    try {
      comments = await issueComments(issue.number);
    } catch (err) {
      // Unknown is not a failure: nothing is recorded and the next night looks again.
      for (const p of ranPlatforms) {
        settled.push({ number: issue.number, platform: p, result: "unknown", reason: err.message });
      }
      continue;
    }
    for (const platform of ranPlatforms) {
      const lane = laneForPlatform(platform);
      const laneResult = lanes[lane];
      const shipped = hasNowLive(comments, platform, { since: issue.closedAt });
      const rec = recordReleaseAttempt(
        state,
        issue.number,
        platform,
        shipped ? "ok" : "fail",
        now,
        {
          closedAt: issue.closedAt,
        },
      );
      dirty = true;
      const entry = {
        number: issue.number,
        platform,
        lane,
        laneResult,
        result: shipped ? "ok" : "fail",
        failures: rec.failures,
        gaveUp: false,
      };
      if (!shipped && laneResult === "0")
        entry.reason = "lane exited 0 but posted no now-live notice";
      if (!shipped && rec.failures >= maxFailures) {
        entry.gaveUp = true;
        try {
          await run("gh", [
            "issue",
            "edit",
            String(issue.number),
            "--repo",
            REPO,
            "--add-label",
            GAVE_UP_LABEL,
          ]);
        } catch (err) {
          entry.labelError = err.message;
        }
        const marker = gaveUpMarker(platform, issue.closedAt);
        if (!comments.some((c) => typeof c?.body === "string" && c.body.includes(marker))) {
          try {
            await run("gh", [
              "issue",
              "comment",
              String(issue.number),
              "--repo",
              REPO,
              "--body",
              gaveUpComment({
                issueNumber: issue.number,
                platform,
                failures: rec.failures,
                laneResult,
                logPath: logs[lane],
                closedAt: issue.closedAt,
              }),
            ]);
          } catch (err) {
            entry.commentError = err.message;
          }
        }
      }
      settled.push(entry);
    }
  }
  if (dirty) await saveReleaseState(state, statePath);
  return { settled };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function positiveInt(raw, fallback, name) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`${name} must be a positive integer (got ${raw})`);
  return n;
}

function positiveNumber(raw, fallback, name) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`${name} must be a positive number (got ${raw})`);
  return n;
}

export async function main(argv, env = process.env) {
  const [sub, ...rawRest] = argv;
  // parseFlags requires a value for every flag, so pull the bare booleans first.
  const BOOLEAN_FLAGS = ["--flag-expired"];
  const argvFlags = new Set(rawRest.filter((a) => BOOLEAN_FLAGS.includes(a)));
  const rest = rawRest.filter((a) => !BOOLEAN_FLAGS.includes(a));
  const { flags, positional } = parseFlags(rest);
  const statePath = flags["state-file"] ?? DEFAULT_RELEASE_STATE_PATH;
  const maxFailures = positiveInt(
    flags["max-failures"] ?? env.SUPPORT_RELEASE_MAX_FAILURES,
    DEFAULT_MAX_FAILURES,
    "--max-failures",
  );
  switch (sub) {
    case "pending":
      return {
        code: 0,
        out: await computePending({
          windowDays: positiveInt(
            flags["window-days"] ?? env.SUPPORT_RELEASE_WINDOW_DAYS,
            DEFAULT_WINDOW_DAYS,
            "--window-days",
          ),
          maxFailures,
          statePath,
          flagExpired: argvFlags.has("--flag-expired"),
        }),
      };
    case "main-ci": {
      const sha = positional[0];
      if (!/^[0-9a-f]{7,40}$/.test(String(sha ?? ""))) {
        throw new Error("main-ci requires a commit sha");
      }
      const out = await waitForMainCi({
        sha,
        waitMs: positiveNumber(flags["wait-min"], 45, "--wait-min") * 60_000,
        intervalMs: positiveNumber(flags["interval-sec"], 30, "--interval-sec") * 1000,
      });
      return { code: out.result === "green" ? 0 : out.result === "failed" ? 1 : 2, out };
    }
    case "settle": {
      if (!flags["pending-file"]) throw new Error("settle requires --pending-file <path>");
      const lanes = parseLaneMap(flags.lanes);
      if (Object.keys(lanes).length === 0)
        throw new Error("settle requires --lanes mobile=<rc>,desktop=<rc>");
      const pending = JSON.parse(readFileSync(flags["pending-file"], "utf8"));
      return {
        code: 0,
        out: await settle({
          pending,
          lanes,
          logs: parseLaneMap(flags.logs),
          maxFailures,
          statePath,
        }),
      };
    }
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        "Usage: support-release.mjs <pending [--window-days N] [--max-failures N] [--flag-expired]|" +
          "main-ci <sha> [--wait-min M] [--interval-sec S]|" +
          "settle --pending-file P --lanes mobile=<rc>,desktop=<rc> [--logs mobile=<p>,desktop=<p>]> " +
          "[--state-file <path>]\n",
      );
      return { code: 0, out: null };
    default:
      throw new Error(`Unknown subcommand: ${sub}`);
  }
}

if (isMainModule(import.meta.url)) {
  // exitCode, not exit(): let a large JSON payload on a pipe drain first.
  main(process.argv.slice(2)).then(
    ({ code, out }) => {
      if (out !== null && out !== undefined) process.stdout.write(JSON.stringify(out) + "\n");
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      // 1 means "CI failed" for main-ci; a tool error must not read as that.
      process.exitCode = process.argv[2] === "main-ci" ? 3 : 1;
    },
  );
}
