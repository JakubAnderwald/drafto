#!/usr/bin/env node
// Post "iOS beta build 147 is up" on the factory card a PRE-MERGE test build
// belongs to.
//
// The factory dispatches beta lanes from an In Test card's PR head so a native
// change is testable before the merge gate (ADR-0030). A Fastlane lane takes
// 20-40 minutes and runs detached, so the In Test comment can only promise that
// a build is coming — this hook is what closes the loop with the actual build
// number once it lands.
//
// Why not extend comment-released-issues.mjs: both of its premises are false
// pre-merge. It walks `git log <last-tag>..HEAD` for `Closes #N` in *merged*
// commits, and it intersects with `gh issue list --label support` — factory
// cards are not support-labelled and are not merged at In Test. Here the issue
// number is known exactly, from the env the dispatcher injected.
//
// Usage (called from apps/{mobile,desktop}/fastlane/Fastfile, only when
// DRAFTO_INTEST_ISSUE is set — i.e. only for a pre-merge dispatch):
//
//   node scripts/comment-intest-build.mjs \
//        --issue 463 --platform ios|android|macos \
//        --build 147 --track "TestFlight" \
//        [--pr 591] [--sha a1b2c3d4e5f6]
//
// Idempotency: `<!-- drafto-factory-intest-build:<platform>:<build> -->`, so a
// re-run of the same lane doesn't double-post. The marker also starts with
// `drafto-factory`, which keeps the comment out of the In Test feedback sweep
// (owner_comments_since) — a build notice must never be read as a change
// request that rolls the card back to In Progress.
//
// Best-effort by design: a comment failure must never fail a build that already
// shipped, so main() resolves rather than throws on a gh error.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isMainModule } from "./lib/is-main.mjs";
import { parseFlags } from "./lib/parse-flags.mjs";

const execFileP = promisify(execFile);
const REPO = "JakubAnderwald/drafto";

let _execFileForTests = null;
export function _setExecFileForTests(impl) {
  _execFileForTests = impl;
}
async function run(cmd, args) {
  const fn = _execFileForTests ?? execFileP;
  const { stdout } = await fn(cmd, args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// Pure: the idempotency fingerprint. Carries the drafto-factory prefix so the
// feedback sweep ignores it.
export function fingerprintMarker(platform, build) {
  return `<!-- drafto-factory-intest-build:${platform}:${build} -->`;
}

// Pure: the customer-visible body.
export function buildBody({ platform, build, track, pr, sha }) {
  const label = { ios: "iOS", android: "Android", macos: "macOS" }[platform] ?? platform;
  const from = pr ? ` from PR #${pr}${sha ? ` @ \`${String(sha).slice(0, 12)}\`` : ""}` : "";
  return (
    `🏭 **${label} beta build ${build} is up** — ${track}, built${from} (pre-merge). ` +
    `Test it with the scenario above.\n\n${fingerprintMarker(platform, build)}`
  );
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
    // Can't tell — proceed. A duplicate notice is a far smaller problem than a
    // silently missing one.
    return false;
  }
  return stdout.includes(fingerprint);
}

export async function commentIntestBuild({ issue, platform, build, track, pr, sha }) {
  const fp = fingerprintMarker(platform, build);
  if (await alreadyCommented(issue, fp)) {
    process.stderr.write(`comment-intest-build: #${issue} already has ${fp}\n`);
    return { commented: false, reason: "already-commented" };
  }
  await run("gh", [
    "issue",
    "comment",
    String(issue),
    "--repo",
    REPO,
    "--body",
    buildBody({ platform, build, track, pr, sha }),
  ]);
  return { commented: true };
}

async function main(argv) {
  const { flags } = parseFlags(argv);
  const { issue, platform, build, track, pr, sha } = flags;
  if (!issue || !platform || !build || !track) {
    throw new Error(
      'comment-intest-build.mjs requires --issue <n> --platform <ios|android|macos> --build <id> --track "<label>"',
    );
  }
  return commentIntestBuild({ issue, platform, build, track, pr, sha });
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => process.stdout.write(JSON.stringify(out) + "\n"),
    (err) => {
      // Never fail the build over a comment.
      process.stderr.write(`comment-intest-build: ${err.message}\n`);
      process.exit(0);
    },
  );
}
