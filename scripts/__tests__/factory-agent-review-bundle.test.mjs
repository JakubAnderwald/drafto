import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REVIEW_FILE_STATS_MAX,
  buildFactoryReviewBundle,
  parsePrFileStats,
} from "../lib/factory-bundle.mjs";

// The code-review stage's diff hand-off. A diff too large to send inline goes
// to the reviewer as a file list with per-file stats (reviewDiffMode
// "file-list"); bash fetches that list every time, passes the diff to jq
// through a file rather than argv, and lists a PR's files from the files
// endpoint when `gh pr diff` refuses it.

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..");
const script = readFileSync(join(SCRIPTS, "factory-agent.sh"), "utf8");
const reviewPrompt = readFileSync(join(SCRIPTS, "factory-review-prompt.md"), "utf8");

const issue = { number: 7, title: "t", body: "", labels: [] };
const base = { issue, approvedPlan: null, config: {}, repo: {}, nowIso: "2026-01-01T00:00:00Z" };
const bigDiff = (lines) => Array.from({ length: lines }, (_, i) => `+line ${i}`).join("\n");

describe("parsePrFileStats", () => {
  it("parses the files endpoint's TSV lines", () => {
    const out = parsePrFileStats(
      "added\tapps/web/a.ts\t12\t0\nrenamed\tdocs/b.md\t1\t1\nremoved\tc.sh\t0\t40\n",
    );
    assert.deepEqual(out, [
      { status: "added", path: "apps/web/a.ts", additions: 12, deletions: 0 },
      { status: "renamed", path: "docs/b.md", additions: 1, deletions: 1 },
      { status: "removed", path: "c.sh", additions: 0, deletions: 40 },
    ]);
  });

  it("drops lines that don't have the shape, rather than guessing", () => {
    const out = parsePrFileStats(
      [
        "",
        "modified\tok.ts\t1\t2",
        "bogus\tx.ts\t1\t2",
        "modified\t\t1\t2",
        "modified\ty.ts\tmany\t2",
        "modified\tz.ts\t1",
        "modified\tw.ts\t1\t2\textra",
      ].join("\n"),
    );
    assert.deepEqual(out, [{ status: "modified", path: "ok.ts", additions: 1, deletions: 2 }]);
    assert.deepEqual(parsePrFileStats(undefined), []);
  });
});

describe("buildFactoryReviewBundle: inline or file-list", () => {
  it("sends a small diff inline, with no file stats", () => {
    const bundle = buildFactoryReviewBundle({
      ...base,
      prDiff: "diff --git a/x b/x\n+one line",
      prFileStats: "modified\tx\t1\t0",
    });
    assert.equal(bundle.reviewDiffMode, "inline");
    assert.match(bundle.prDiffEnveloped, /\+one line/);
    assert.equal(bundle.prDiffTruncated, false);
    assert.deepEqual(bundle.prFileStats, []);
    assert.equal(bundle.prFileStatsOmitted, 0);
  });

  it("sends a diff truncateDiff would cut as a file list with stats", () => {
    const bundle = buildFactoryReviewBundle({
      ...base,
      prDiff: bigDiff(6000),
      prFileStats: "added\tscripts/a.sh\t4000\t0\nmodified\tdocs/b.md\t1999\t1",
    });
    assert.equal(bundle.reviewDiffMode, "file-list");
    assert.equal(bundle.prDiffEnveloped, "<pr-diff></pr-diff>");
    assert.equal(bundle.prDiffTruncated, true);
    assert.equal(bundle.prDiffOmittedLines, 6000);
    assert.deepEqual(
      bundle.prFileStats.map((f) => f.path),
      ["scripts/a.sh", "docs/b.md"],
    );
    // The In Test bundle owns `prDiffMode`; the review bundle must not reuse it.
    assert.equal(bundle.prDiffMode, undefined);
  });

  it("goes file-list on the byte cap too, not just the line cap", () => {
    const wide = Array.from({ length: 300 }, () => `+${"x".repeat(1000)}`).join("\n");
    const bundle = buildFactoryReviewBundle({
      ...base,
      prDiff: wide,
      prFileStats: "added\tbig.json\t300\t0",
    });
    assert.equal(bundle.reviewDiffMode, "file-list");
  });

  it("reviews from the file list when gh pr diff refused the diff (no diff at all)", () => {
    const bundle = buildFactoryReviewBundle({
      ...base,
      prDiff: "",
      prFileStats: "added\ta.ts\t30000\t0\nmodified\tb.ts\t5\t7",
    });
    assert.equal(bundle.reviewDiffMode, "file-list");
    assert.equal(bundle.prDiffTruncated, true);
    // With no diff, the files' changed-line counts stand in.
    assert.equal(bundle.prDiffOmittedLines, 30012);
  });

  it("caps the file rows and says how many it left out", () => {
    const n = REVIEW_FILE_STATS_MAX + 5;
    const stats = Array.from({ length: n }, (_, i) => `added\tf${i}.ts\t1\t0`).join("\n");
    const bundle = buildFactoryReviewBundle({ ...base, prDiff: bigDiff(5000), prFileStats: stats });
    assert.equal(bundle.prFileStats.length, REVIEW_FILE_STATS_MAX);
    assert.equal(bundle.prFileStatsOmitted, 5);
  });

  it("leaves truncateDiff's limits alone (the In Test bundle shares them)", () => {
    // 4000 lines is still inline; 4001 is not.
    const at = buildFactoryReviewBundle({
      ...base,
      prDiff: bigDiff(4000),
      prFileStats: "added\ta\t4000\t0",
    });
    const over = buildFactoryReviewBundle({
      ...base,
      prDiff: bigDiff(4001),
      prFileStats: "added\ta\t4001\t0",
    });
    assert.equal(at.reviewDiffMode, "inline");
    assert.equal(over.reviewDiffMode, "file-list");
  });
});

describe("factory-bundle CLI passes prFileStats through for factory_review", () => {
  it("dispatches the field", () => {
    const input = {
      kind: "factory_review",
      issue,
      approvedPlan: null,
      prDiff: "",
      prFiles: "a.ts",
      prFileStats: "added\ta.ts\t3\t0",
      headSha: "abc",
      config: {},
      repo: {},
    };
    const res = spawnSync("node", [join(SCRIPTS, "lib", "factory-bundle.mjs")], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.reviewDiffMode, "file-list");
    assert.deepEqual(out.prFileStats, [
      { status: "added", path: "a.ts", additions: 3, deletions: 0 },
    ]);
  });
});

// ── bash ────────────────────────────────────────────────────────────────────

function extract(name) {
  const fn = script.match(new RegExp(`\\n${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(fn, `could not extract ${name}`);
  return fn[0];
}

// Bash with the review helpers loaded and every GitHub / state / Claude touch
// stubbed. `gh pr diff` prints $DIFF_FILE (or fails, as on HTTP 406, when
// GH_DIFF_FAIL=1); `gh api --paginate` prints $STATS_FILE (or fails when
// GH_API_FAIL=1, or after printing it, as a failed later page does, when
// GH_API_PARTIAL=1). The real factory-bundle.mjs builds the bundle; the
// run-claude call is replaced by a stub that saves its -p prompt to
// $PROMPT_OUT. The environment is built from scratch so a FACTORY_* knob
// exported by the caller can't change the results.
function runBash(body, env = {}) {
  const harness = [
    "set -uo pipefail",
    "LOG_FILE=$(mktemp)",
    `trap 'cat "$LOG_FILE"; rm -f "$LOG_FILE"' EXIT`,
    `SCRIPT_DIR='${SCRIPTS}'`,
    'REPO_ROOT="$WORK"',
    "STATE_FILE=/nonexistent",
    `REVIEW_PROMPT_FILE='${join(SCRIPTS, "factory-review-prompt.md")}'`,
    "REVIEW_TIMEOUT_SEC=5",
    "FACTORY_PLAN_EFFORT=xhigh",
    'SUPPORT_ALLOWLIST=""',
    'OAUTH_USER_EMAIL=""',
    "PHASE=B",
    'log() { echo "LOG $*" >>"$LOG_FILE"; }',
    `fetch_issue_record() { echo '{"number":7,"title":"t","body":"","labels":[]}'; }`,
    "fetch_issue_comments() { echo '[]'; }",
    "extract_plan_comment() { echo 'null'; }",
    'review_record_sha() { echo "RECORD $2" >>"$LOG_FILE"; }',
    "pr_has_marker() { return 0; }",
    "check_session_limit() { return 1; }",
    "pause_for_session_limit() { :; }",
    "gh() {",
    '  case "$1 $2" in',
    '    "pr diff") [[ "${GH_DIFF_FAIL:-0}" == 1 ]] && { echo "HTTP 406: diff too_large" >&2; return 1; }',
    '      if [[ " $* " == *" --name-only "* ]]; then echo NAME_ONLY_UNEXPECTED; else cat "$DIFF_FILE"; fi ;;',
    '    "api --paginate") [[ "${GH_API_FAIL:-0}" == 1 ]] && return 1; echo "GH_API $3 $4 $5" >>"$LOG_FILE"; cat "$STATS_FILE"; [[ "${GH_API_PARTIAL:-0}" != 1 ]] ;;',
    '    *) echo "UNEXPECTED gh $*" >>"$LOG_FILE"; return 1 ;;',
    "  esac",
    "}",
    'node() { if [[ "$1" == *run-claude.mjs ]]; then printf "%s" "$3" >"$PROMPT_OUT"; echo "issue=7 action=reviewed pr=-"; else command node "$@"; fi; }',
    extract("pr_file_stats"),
    extract("build_review_bundle"),
    extract("review_stage"),
    body,
  ].join("\n");
  return spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", ...env },
  });
}

describe("build_review_bundle (bash): the diff reaches jq through a file", () => {
  let work;
  before(() => {
    work = mkdtempSync(join(tmpdir(), "review-bundle-"));
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  it("uses --rawfile for the diff and the file lists, never --arg", () => {
    const fn = extract("build_review_bundle");
    assert.match(fn, /--rawfile prDiff /);
    assert.match(fn, /--rawfile prFiles /);
    assert.match(fn, /--rawfile prFileStats /);
    assert.doesNotMatch(fn, /--arg prDiff/);
    assert.match(fn, /rm -rf "\$tmp_dir"/, "the temp dir must be removed");
  });

  it("builds a bundle from a 2 MB diff (jq --arg failed with E2BIG here)", () => {
    // 2 MB is over macOS's 1 MB ARG_MAX and Linux's 128 KB per-argument cap,
    // so the old --arg path fails on both.
    const diffFile = join(work, "diff.txt");
    const statsFile = join(work, "stats.tsv");
    const out = join(work, "bundle.json");
    writeFileSync(diffFile, bigDiff(200_000));
    writeFileSync(statsFile, "added\tbig.ts\t200000\t0\n");
    const res = runBash(
      [
        'build_review_bundle \'{"number":7,"title":"t","body":"","labels":[]}\' null null \\',
        '  "$(cat "$DIFF")" "big.ts" "abc123" "$(cat "$STATS")" >"$OUT"',
        'echo "RC=$?"',
      ].join("\n"),
      { WORK: work, DIFF: diffFile, STATS: statsFile, OUT: out },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /RC=0/, res.stdout + res.stderr);
    const bundle = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(bundle.reviewDiffMode, "file-list");
    assert.equal(bundle.headSha, "abc123");
    assert.equal(bundle.prFiles, "big.ts");
    assert.equal(bundle.prFileStats[0].path, "big.ts");
  });

  it("returns non-zero when the bundle can't be built", () => {
    const res = runBash(
      'build_review_bundle \'not json\' null null "d" "f" "s" "" >/dev/null 2>&1; echo "RC=$?"',
      { WORK: work },
    );
    assert.match(res.stdout, /RC=[1-9]/);
  });
});

describe("review_stage (bash): file listing and modes", () => {
  let work;
  before(() => {
    work = mkdtempSync(join(tmpdir(), "review-stage-"));
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  function stage({ diff, stats, env = {} }) {
    const diffFile = join(work, "diff.txt");
    const statsFile = join(work, "stats.tsv");
    const promptOut = join(work, "prompt.txt");
    writeFileSync(diffFile, diff ?? "");
    writeFileSync(statsFile, stats ?? "");
    rmSync(promptOut, { force: true });
    const res = runBash('review_stage 7 42 \'{"number":42}\' abcdef1234567890 "a.ts"', {
      WORK: work,
      DIFF_FILE: diffFile,
      STATS_FILE: statsFile,
      PROMPT_OUT: promptOut,
      ...env,
    });
    let bundle = null;
    try {
      const prompt = readFileSync(promptOut, "utf8");
      const head = "## Context bundle for this run\n\n```json\n";
      const at = prompt.lastIndexOf(head);
      bundle =
        at === -1 ? null : JSON.parse(prompt.slice(at + head.length).replace(/\n```\n?$/, ""));
    } catch {
      bundle = null;
    }
    return { res, bundle };
  }

  it("always fetches the PR's file listing with the plan's jq projection", () => {
    const fn = extract("pr_file_stats");
    assert.match(fn, /gh api --paginate "repos\/JakubAnderwald\/drafto\/pulls\/\$pr_num\/files"/);
    assert.match(fn, /'\.\[\]\|\[\.status,\.filename,\.additions,\.deletions\]\|@tsv'/);
    const { res } = stage({ diff: "diff --git a/a.ts b/a.ts\n+x", stats: "modified\ta.ts\t1\t0" });
    assert.match(res.stdout, /GH_API repos\/JakubAnderwald\/drafto\/pulls\/42\/files --jq/);
  });

  it("reviews a small diff inline", () => {
    const { res, bundle } = stage({
      diff: "diff --git a/a.ts b/a.ts\n+x",
      stats: "modified\ta.ts\t1\t0",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(bundle, `no prompt captured:\n${res.stdout}`);
    assert.equal(bundle.reviewDiffMode, "inline");
    assert.match(bundle.prDiffEnveloped, /\+x/);
    assert.doesNotMatch(res.stdout, /file-list mode/);
    assert.match(res.stdout, /RECORD abcdef1234567890/);
  });

  it("reviews a large diff in file-list mode and logs it", () => {
    const { res, bundle } = stage({
      diff: bigDiff(5000),
      stats: "added\ta.ts\t5000\t0\n",
    });
    assert.ok(bundle, `no prompt captured:\n${res.stdout}`);
    assert.equal(bundle.reviewDiffMode, "file-list");
    assert.equal(bundle.prDiffEnveloped, "<pr-diff></pr-diff>");
    assert.match(res.stdout, /reviewing in file-list mode \(1 files\)/);
  });

  it("still reviews when gh pr diff refuses the diff (HTTP 406)", () => {
    const { res, bundle } = stage({
      diff: "",
      stats: "added\ta.ts\t30000\t0\n",
      env: { GH_DIFF_FAIL: "1" },
    });
    assert.ok(bundle, `no prompt captured:\n${res.stdout}`);
    assert.equal(bundle.reviewDiffMode, "file-list");
    assert.doesNotMatch(res.stdout, /empty diff/);
  });

  it("skips (and records the SHA) when neither the diff nor the listing came back", () => {
    const { res, bundle } = stage({
      diff: "",
      stats: "",
      env: { GH_DIFF_FAIL: "1", GH_API_FAIL: "1" },
    });
    assert.equal(bundle, null);
    assert.match(res.stdout, /WARNING: empty diff for PR #42; skipping review/);
    assert.match(res.stdout, /RECORD abcdef1234567890/);
  });

  it("drops a listing whose call failed part-way rather than half-using it", () => {
    const { res, bundle } = stage({
      diff: bigDiff(5000),
      stats: "added\ta.ts\t5000\t0\n",
      env: { GH_API_PARTIAL: "1" },
    });
    assert.ok(bundle, `no prompt captured:\n${res.stdout}`);
    assert.equal(bundle.reviewDiffMode, "inline");
    assert.deepEqual(bundle.prFileStats, []);
  });

  it("keeps a truncated inline diff when only the listing failed", () => {
    const { res, bundle } = stage({
      diff: bigDiff(5000),
      stats: "",
      env: { GH_API_FAIL: "1" },
    });
    assert.ok(bundle, `no prompt captured:\n${res.stdout}`);
    assert.equal(bundle.reviewDiffMode, "inline");
    assert.equal(bundle.prDiffTruncated, true);
  });
});

describe("--watch lists a too-large PR's files from the files endpoint", () => {
  // `gh pr diff --name-only` fetches the whole diff, so it fails with HTTP 406
  // on a PR over 300 files or 20,000 lines, and the In Review loop skipped
  // that card on every tick before its code review.
  const start = script.indexOf(
    '    if ! INTEST_DIFF_FILES=$(gh pr diff "$PR_NUM" --repo JakubAnderwald/drafto --name-only',
  );
  const end = script.indexOf("\n    fi\n", start) + "\n    fi\n".length;
  const snippet = script.slice(start, end);

  function run(env) {
    const harness = [
      "set -uo pipefail",
      "LOG_FILE=$(mktemp)",
      `trap 'cat "$LOG_FILE"; rm -f "$LOG_FILE"' EXIT`,
      "PR_NUM=42",
      "ISSUE_NUM=7",
      'log() { echo "LOG $*" >>"$LOG_FILE"; }',
      "gh() {",
      '  case "$1 $2" in',
      '    "pr diff") [[ "${GH_DIFF_FAIL:-0}" == 1 ]] && return 1; printf "a.ts\\nb.ts\\n" ;;',
      '    "api --paginate") [[ "${GH_API_FAIL:-0}" == 1 ]] && return 1; printf "added\\tbig/x.ts\\t1\\t0\\nmodified\\tdocs/y.md\\t2\\t3\\n" ;;',
      "  esac",
      "}",
      extract("pr_file_stats"),
      "for _ in 1; do",
      snippet,
      'echo "FILES=[$INTEST_DIFF_FILES]"',
      "done",
    ].join("\n");
    return spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env },
    });
  }

  it("found the call site", () => {
    assert.ok(start !== -1 && snippet.includes("pr_file_stats"), snippet);
  });

  it("uses gh pr diff --name-only when it works", () => {
    const res = run({});
    assert.match(res.stdout, /FILES=\[a\.ts\nb\.ts\]/);
  });

  it("falls back to the files endpoint when gh pr diff fails", () => {
    const res = run({ GH_DIFF_FAIL: "1" });
    assert.match(res.stdout, /FILES=\[big\/x\.ts\ndocs\/y\.md\]/);
    assert.match(res.stdout, /took its changed files from the files API/);
  });

  it("skips the tick when both fail", () => {
    const res = run({ GH_DIFF_FAIL: "1", GH_API_FAIL: "1" });
    assert.doesNotMatch(res.stdout, /FILES=/);
    assert.match(res.stdout, /WARNING: gh pr diff #42 failed \(transient\?\); skipping this tick/);
  });
});

describe("review prompt: file-list mode", () => {
  it("documents the mode and the new bundle fields", () => {
    assert.match(reviewPrompt, /`reviewDiffMode`/);
    assert.match(reviewPrompt, /`prFileStats`/);
    assert.match(reviewPrompt, /## File-list mode/);
  });

  it("fetches the files once and reads each patch with jq", () => {
    assert.match(
      reviewPrompt,
      /gh api --paginate repos\/JakubAnderwald\/drafto\/pulls\/<PR>\/files > "\$F"/,
    );
    assert.match(reviewPrompt, /select\(\.filename == \$f\) \| \.patch/);
    assert.match(reviewPrompt, /TMPDIR/);
  });

  it("falls back to gh pr diff for one file when GitHub omits the patch", () => {
    assert.match(reviewPrompt, /awk -v h='diff --git a\/<path> b\/<path>'/);
  });

  it("covers every non-generated file, risky ones first, and anchors on fetched lines", () => {
    assert.match(reviewPrompt, /Cover \*\*every\*\* changed file that isn't generated/);
    assert.match(reviewPrompt, /risky ones first/);
    assert.match(reviewPrompt, /Anchor an inline comment only on a line that appears in a patch/);
  });

  it("lists the files GET in the tool allowlist and keeps the review checklist heading", () => {
    const tools = reviewPrompt.slice(
      reviewPrompt.indexOf("## Tools"),
      reviewPrompt.indexOf("## What to review for"),
    );
    assert.match(
      tools,
      /gh api --paginate repos\/JakubAnderwald\/drafto\/pulls\/<n>\/files` \(GET\)/,
    );
    // /drive-issue cites this heading as its review checklist.
    assert.match(reviewPrompt, /^## What to review for$/m);
  });
});
