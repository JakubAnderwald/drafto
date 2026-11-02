#!/usr/bin/env node
// Phase G: comment "Now live in <platform> <build>." on the support issues
// closed by PRs that landed in the current release.
//
// Walks `git log <last-tag>..HEAD --no-merges --format=%B -- <paths>`,
// extracts `Closes #N` / `Fixes #N` / `Resolves #N` references from each
// squashed commit body, intersects with `gh issue list --label support` so
// we only comment on actual support issues (not internal refactors that
// happen to reference a #N), and posts an idempotent progress comment on
// each match.
//
// Usage (called from apps/{mobile,desktop}/fastlane/Fastfile after
// post-release-notes.mjs uploads the notes):
//
//   node scripts/comment-released-issues.mjs \
//        --platform android|ios|macos \
//        --build <identifier> \
//        --track "<customer-facing label, e.g. 'TestFlight build 145'>" \
//        --tag-prefix mobile@|desktop@ \
//        --paths apps/mobile/,packages/shared/
//
// `--track` is the customer-facing label that appears in the email — it
// should encode both the channel ("TestFlight" vs "App Store" vs "Google
// Play internal") and the build identifier in human-readable form. The
// caller composes it because Fastlane has direct access to the lane
// (beta vs production), the build number, and the marketing version.
//
// `--build` and `--platform` are used ONLY for the idempotency fingerprint
// `<!-- now-live:<platform>:<build> -->`. They never appear in the
// customer-visible message body.
//
// Idempotency: each comment carries the same `<!-- drafto-progress -->`
// marker as the other support-pipeline progress comments, AND a fingerprint
// `<!-- now-live:<platform>:<build> -->`. An issue is announced ONCE per
// platform: any existing fingerprint for the platform — whatever its build —
// posted since the issue's latest close suppresses a new one (see
// lib/now-live.mjs). Keying on the build alone let every later build whose tag
// range still covered the fix announce it again.
//
// Candidates are the tag-range `Closes #N` refs UNIONED with
// $DRAFTO_RELEASE_ISSUES (comma-separated issue numbers), which
// scripts/nightly-support.sh passes through dispatch-release.mjs
// --release-issues for the support fixes a lane was dispatched to ship
// (ADR-0042). The tag walk alone can miss them: `mobile@` is shared by the
// `+ios.` and `+android.` tags and `-v:refname` sorts the iOS tag first, so an
// Android build can start its range past a fix it never shipped. Either source
// is still intersected with the support-labelled issues.
//
// Best-effort: any individual comment failure is logged but does not abort
// the run — the rest of the release pipeline shouldn't fail because GitHub
// rate-limited a single comment.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isMainModule } from "./lib/is-main.mjs";
import { parseFlags } from "./lib/parse-flags.mjs";
import { extractIssueRefs } from "./lib/github-sync.mjs";
import { nowLiveFingerprint, hasNowLive } from "./lib/now-live.mjs";

const execFileP = promisify(execFile);
const REPO = "JakubAnderwald/drafto";
const PROGRESS_MARKER = "<!-- drafto-progress -->";

let _execFileForTests = null;
export function _setExecFileForTests(impl) {
  _execFileForTests = impl;
}
async function run(cmd, args) {
  const fn = _execFileForTests ?? execFileP;
  const { stdout } = await fn(cmd, args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// Find the most recent tag matching `<prefix>*`, falling back to "" (caller
// treats that as "walk the full HEAD history").
async function findLastReleaseTag(prefix) {
  let stdout;
  try {
    stdout = await run("git", ["tag", "--list", `${prefix}*`, "--sort=-v:refname"]);
  } catch {
    return "";
  }
  const lines = stdout.split("\n").filter((s) => s.length > 0);
  if (lines.length === 0) return "";
  // If the latest tag points at HEAD (the release just tagged itself), step
  // back one — otherwise the range `<tag>..HEAD` is empty and we'd never
  // comment on anything. Mirrors apps/mobile/scripts/generate-release-notes.sh.
  let tag = lines[0];
  let tagSha;
  let headSha;
  try {
    [tagSha, headSha] = await Promise.all([
      run("git", ["rev-parse", tag]).then((s) => s.trim()),
      run("git", ["rev-parse", "HEAD"]).then((s) => s.trim()),
    ]);
  } catch {
    return tag;
  }
  if (tagSha === headSha && lines.length >= 2) {
    tag = lines[1];
  }
  return tag;
}

// Collect issue numbers referenced by `Closes #N` etc. in commits between
// `tag..HEAD`, restricted to the given paths so a desktop release doesn't
// claim mobile-only PRs as "now live".
export async function findClosedIssueNumbers({ tag, paths }) {
  const range = tag ? `${tag}..HEAD` : "HEAD";
  // Use a unique record separator (NUL) so multi-line commit bodies don't
  // confuse parsing.
  const args = ["log", range, "--no-merges", "--format=%B%x00", "--", ...paths];
  let stdout;
  try {
    stdout = await run("git", args);
  } catch {
    return [];
  }
  const refs = new Set();
  for (const body of stdout.split("\0")) {
    for (const n of extractIssueRefs(body)) refs.add(n);
  }
  return [...refs].sort((a, b) => a - b);
}

// Issue numbers from $DRAFTO_RELEASE_ISSUES. Lenient: dispatch-release.mjs
// already validated the list, and a stray token must not cost the release its
// announcements, so anything that isn't an issue number is skipped.
export function parseReleaseIssuesEnv(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[1-9][0-9]*$/.test(s))
    .map(Number);
}

// Tag-range refs ∪ explicitly-released issues, sorted and de-duplicated.
export function unionCandidates(rangeRefs, envRefs) {
  return [...new Set([...(rangeRefs ?? []), ...(envRefs ?? [])])].sort((a, b) => a - b);
}

// Support-labelled issues → their latest close time (null while open). The
// close time scopes the "already announced" check to the current fix.
async function getSupportIssues() {
  let stdout;
  try {
    // Paginate via the underlying API rather than `gh issue list --limit N`:
    // the CLI caps `--limit` and silently truncates beyond 500, which would
    // mean older support issues stop receiving "Now live" notifications once
    // the project crosses that threshold. `gh api --paginate` follows the
    // Link header to fetch every page and emits the concatenated JSON array.
    stdout = await run("gh", [
      "api",
      "--paginate",
      `repos/${REPO}/issues?labels=support&state=all&per_page=100`,
    ]);
  } catch {
    return new Map();
  }
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return new Map();
  }
  // The `/issues` endpoint includes PRs (each PR is also an issue). We only
  // label issues with `support`, but filter defensively by the absence of
  // `.pull_request` so a future labelled PR doesn't slip into the candidate
  // set and confuse the per-issue comment posting below.
  const out = new Map();
  for (const entry of Array.isArray(data) ? data : []) {
    if (entry?.pull_request != null) continue;
    const n = Number(entry?.number);
    if (!Number.isInteger(n) || n <= 0) continue;
    out.set(n, typeof entry.closed_at === "string" ? entry.closed_at : null);
  }
  return out;
}

// Has <platform> already been announced for this issue's current fix? A
// failed lookup reads as "no" (best-effort, as before): a duplicate notice is
// better than a fix nobody is told about.
async function alreadyAnnounced(issueNumber, platform, closedAt) {
  let stdout;
  try {
    // No --jq: `gh api --paginate` merges the pages of an array response into
    // one array, which a per-page --jq would not.
    stdout = await run("gh", ["api", "--paginate", `repos/${REPO}/issues/${issueNumber}/comments`]);
  } catch {
    return false;
  }
  let comments;
  try {
    comments = JSON.parse(stdout);
  } catch {
    return false;
  }
  return hasNowLive(comments, platform, { since: closedAt ?? undefined });
}

async function postNowLiveComment({ issueNumber, platform, build, track }) {
  const fp = nowLiveFingerprint(platform, build);
  const body = `Now live in ${track}. ${PROGRESS_MARKER} ${fp}`;
  await run("gh", ["issue", "comment", String(issueNumber), "--repo", REPO, "--body", body]);
}

// Exported (with its `env`) for the tests; the CLI below calls it with argv.
export async function main(argv, env = process.env) {
  const { flags } = parseFlags(argv);
  const platform = flags.platform;
  const build = flags.build;
  // `--track` is required and is what the customer reads. `--platform` and
  // `--build` are kept for the idempotency fingerprint only; falling back to
  // the raw "android 145" wording would be a regression.
  const track = flags.track;
  const tagPrefix = flags["tag-prefix"];
  const pathsCsv = flags.paths;
  if (!platform || !build || !track || !tagPrefix || !pathsCsv) {
    throw new Error(
      'comment-released-issues.mjs requires --platform <p> --build <id> --track "<label>" --tag-prefix <p> --paths <a,b,c>',
    );
  }
  const paths = pathsCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (paths.length === 0) throw new Error("--paths must list at least one path");

  const tag = await findLastReleaseTag(tagPrefix);
  process.stderr.write(`comment-released-issues: range ${tag || "(no tag)"}..HEAD\n`);

  const envRefs = parseReleaseIssuesEnv(env.DRAFTO_RELEASE_ISSUES);
  if (envRefs.length > 0) {
    process.stderr.write(
      `comment-released-issues: DRAFTO_RELEASE_ISSUES adds #${envRefs.join(", #")}\n`,
    );
  }
  const candidates = unionCandidates(await findClosedIssueNumbers({ tag, paths }), envRefs);
  if (candidates.length === 0) {
    process.stderr.write("comment-released-issues: no Closes #N refs in this range\n");
    return { commented: [], skipped: [], skippedNonSupport: [] };
  }

  const supportIssues = await getSupportIssues();
  const commented = [];
  const skipped = [];
  const skippedNonSupport = [];

  for (const issueNumber of candidates) {
    if (!supportIssues.has(issueNumber)) {
      skippedNonSupport.push(issueNumber);
      continue;
    }
    if (await alreadyAnnounced(issueNumber, platform, supportIssues.get(issueNumber))) {
      skipped.push(issueNumber);
      continue;
    }
    try {
      await postNowLiveComment({ issueNumber, platform, build, track });
      commented.push(issueNumber);
    } catch (err) {
      process.stderr.write(
        `comment-released-issues: failed on issue #${issueNumber}: ${err?.message ?? err}\n`,
      );
    }
  }
  return { commented, skipped, skippedNonSupport };
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => {
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    },
    (err) => {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(1);
    },
  );
}
