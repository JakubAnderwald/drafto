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
// `<!-- now-live:<platform>:<build> -->` so a second run for the same build
// doesn't re-post.
//
// Best-effort: any individual comment failure is logged but does not abort
// the run — the rest of the release pipeline shouldn't fail because GitHub
// rate-limited a single comment.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isMainModule } from "./lib/is-main.mjs";
import { parseFlags } from "./lib/parse-flags.mjs";
import { extractIssueRefs } from "./lib/github-sync.mjs";

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

async function getSupportIssueNumbers() {
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
    return new Set();
  }
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return new Set();
  }
  // The `/issues` endpoint includes PRs (each PR is also an issue). We only
  // label issues with `support`, but filter defensively by the absence of
  // `.pull_request` so a future labelled PR doesn't slip into the candidate
  // set and confuse the per-issue comment posting below.
  return new Set(
    (Array.isArray(data) ? data : [])
      .filter((entry) => entry?.pull_request == null)
      .map((entry) => Number(entry.number))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

function fingerprintMarker(platform, build) {
  return `<!-- now-live:${platform}:${build} -->`;
}

async function alreadyCommented(issueNumber, fingerprint) {
  let stdout;
  try {
    stdout = await run("gh", [
      "api",
      "--paginate",
      `repos/${REPO}/issues/${issueNumber}/comments`,
      "--jq",
      ".[].body // empty",
    ]);
  } catch {
    return false;
  }
  return stdout.includes(fingerprint);
}

async function postNowLiveComment({ issueNumber, platform, build, track }) {
  const fp = fingerprintMarker(platform, build);
  const body = `Now live in ${track}. ${PROGRESS_MARKER} ${fp}`;
  await run("gh", ["issue", "comment", String(issueNumber), "--repo", REPO, "--body", body]);
}

async function main(argv) {
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

  const candidates = await findClosedIssueNumbers({ tag, paths });
  if (candidates.length === 0) {
    process.stderr.write("comment-released-issues: no Closes #N refs in this range\n");
    return { commented: [], skipped: [], skippedNonSupport: [] };
  }

  const supportNumbers = await getSupportIssueNumbers();
  const fingerprint = fingerprintMarker(platform, build);
  const commented = [];
  const skipped = [];
  const skippedNonSupport = [];

  for (const issueNumber of candidates) {
    if (!supportNumbers.has(issueNumber)) {
      skippedNonSupport.push(issueNumber);
      continue;
    }
    if (await alreadyCommented(issueNumber, fingerprint)) {
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
