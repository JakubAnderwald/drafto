// ADR-0084: implement deadline + resume after a timeout.
//
// Five --implement wall-cap timeouts burned 13.5% of the factory's tokens, and
// every retry started a fresh session (#797). Now each implement run has a
// claude session id and a "Run-time facts" block with its deadlines; a fresh
// run that hits the cap (or stops with action=incomplete) is recorded, and the
// next run resumes that session when nothing it relied on changed.
//
// Two layers: static wiring over the script source, and the real bash helpers
// run against the real node CLIs, a temp state file, a temp git worktree and a
// fake claude transcript under a temp HOME.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..");
const AGENT = resolve(SCRIPTS, "factory-agent.sh");
const script = readFileSync(AGENT, "utf8");

const extract = (fn) => `eval "$(awk '/^${fn}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${AGENT}")"`;

function slice(from, to) {
  const a = script.indexOf(from);
  assert.ok(a !== -1, `not found: ${from}`);
  const b = script.indexOf(to, a + from.length);
  assert.ok(b !== -1, `not found after ${from}: ${to}`);
  return script.slice(a, b);
}

const IMPLEMENT = slice('\nif [[ "$MODE_IMPLEMENT" -eq 1 ]]; then\n', "# ── --watch mode");

describe("implement resume: knobs", () => {
  it("defaults and validates the four knobs", () => {
    for (const [knob, def, re] of [
      ["FACTORY_IMPLEMENT_RESUME", "1", /case "\$FACTORY_IMPLEMENT_RESUME" in\n\s*0\|1\)/],
      ["FACTORY_IMPLEMENT_SOFT_MARGIN_MIN", "15", /\^\(0\|\[1-9\]\[0-9\]\*\)\$/],
      ["FACTORY_IMPLEMENT_RESUME_MAX_AGE_MIN", "360", /\^\[1-9\]\[0-9\]\*\$/],
      ["FACTORY_IMPLEMENT_TERM_GRACE_SEC", "30", /\^\[1-9\]\[0-9\]\*\$/],
    ]) {
      assert.match(script, new RegExp(`${knob}="\\$\\{${knob}:-${def}\\}"`), knob);
      assert.match(script, new RegExp(`invalid ${knob}='\\$${knob}'; defaulting to ${def}`), knob);
      assert.match(script, re, knob);
    }
  });
});

describe("implement resume: wiring in the --implement block", () => {
  it("passes the session flag as plain strings and the 30 s kill grace on the implement call only", () => {
    assert.match(
      IMPLEMENT,
      /CLAUDE_CALL_KILL_GRACE_SEC="\$FACTORY_IMPLEMENT_TERM_GRACE_SEC" \\\n\s*node "\$SCRIPT_DIR\/lib\/run-claude\.mjs" -p "\$CLAUDE_INPUT" --dangerously-skip-permissions --effort "\$FACTORY_EFFORT" --no-chrome --strict-mcp-config \\\n\s*"\$IMPL_SESSION_FLAG" "\$IMPL_SESSION_ID" \)/,
    );
    assert.equal(script.split("CLAUDE_CALL_KILL_GRACE_SEC=").length - 1, 1);
    assert.equal(script.split('"$IMPL_SESSION_FLAG" "$IMPL_SESSION_ID"').length - 1, 1);
  });

  it("decides after the PR head capture and before the run, and inherits the first run's head", () => {
    const capture = IMPLEMENT.indexOf('PRE_HEAD_OID=$(pr_head_oid "$(echo "$PRIOR_PR"');
    const decide = IMPLEMENT.indexOf("if ! implement_resume_decide ");
    const inherit = IMPLEMENT.indexOf('PRE_HEAD_OID="$IMPL_RESUME_PRE_HEAD"');
    const run = IMPLEMENT.indexOf("Invoking claude for #$ISSUE_NUM (--implement");
    assert.ok(capture !== -1 && capture < decide && decide < inherit && inherit < run);
    assert.match(
      IMPLEMENT,
      /if \[\[ "\$IMPL_RESUMED" -eq 1 \]\]; then\n\s*PRE_HEAD_OID="\$IMPL_RESUME_PRE_HEAD"\n\s*PRE_HEAD_KNOWN=1\n/,
    );
  });

  it("sends a resumed session the resume note and the facts, not the prompt and bundle again", () => {
    assert.match(
      IMPLEMENT,
      /CLAUDE_INPUT=\$\(printf '%s\\n%s\\n' "\$RESUME_PROMPT_TEXT" "\$IMPL_FACTS_BLOCK"\)/,
    );
    assert.match(IMPLEMENT, /"\$PROMPT_TEXT" "\$BUNDLE" "\$IMPL_FACTS_BLOCK"\)/);
    assert.match(IMPLEMENT, /## Run-time facts/);
    assert.match(IMPLEMENT, /factory-implement-resume-prompt\.md/);
  });

  it("logs a timeout's output before deleting it, records a fresh run as resumable, still spends the attempt", () => {
    const branch = slice(
      '      log "WARNING: claude timed out (>${IMPLEMENT_TIMEOUT_SEC}s) for #$ISSUE_NUM; keeping slot for retry"',
      "    elif [[ $EXIT_CODE -ne 0 ]]; then",
    );
    const cat = branch.indexOf('cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE"');
    const rm = branch.indexOf('rm -f "$CLAUDE_OUTPUT_FILE"');
    assert.ok(cat !== -1 && cat < rm, "stdout is logged before the file is deleted");
    assert.match(
      branch,
      /if \[\[ "\$IMPL_RESUMED" -eq 0 \]\]; then\n\s*implement_mark_resumable "\$ISSUE_NUM" "\$WT_PATH" "\$IMPL_SESSION_ID" "\$IMPL_TASK_KEY" \\\n\s*"\$PRE_HEAD_OID" "\$PRE_HEAD_KNOWN" "timed out"\n\s*fi/,
    );
    assert.match(branch, /factory:bump-attempts "\$ISSUE_NUM"/);
    assert.match(branch, /continue\n$/);
  });

  it("checks the named session for a limit, then lets a resume that never started off the attempt", () => {
    const branch = slice(
      'log "ERROR: claude exited non-zero ($EXIT_CODE) for #$ISSUE_NUM --implement"',
      '    cat "$CLAUDE_OUTPUT_FILE" >>"$LOG_FILE"\n',
    );
    const limit = branch.indexOf(
      'check_session_limit "$WT_PATH" "$CLAUDE_START_ISO" "$IMPL_SESSION_ID"',
    );
    const never = branch.indexOf("implement_resume_never_started");
    const bump = branch.indexOf("factory:bump-attempts");
    assert.ok(limit !== -1 && limit < never && never < bump);
    assert.match(
      branch,
      /if \[\[ "\$IMPL_RESUMED" -eq 1 \]\] \\\n\s*&& implement_resume_never_started "\$IMPL_SESSION_ID" "\$CLAUDE_START_ISO" "\$IMPL_START_EPOCH"; then\n\s*log "[^"]*never started[^"]*"\n\s*continue\n/,
    );
  });

  it("gives action=incomplete its own arm: resumable when fresh, attempt spent", () => {
    const arm = slice("      incomplete)\n", "        ;;\n");
    assert.match(arm, /action=incomplete\); keeping slot \$SLOT for retry/);
    assert.match(arm, /if \[\[ "\$IMPL_RESUMED" -eq 0 \]\]; then\n\s*implement_mark_resumable /);
    assert.match(arm, /"action=incomplete"\n/);
    assert.match(arm, /factory:bump-attempts "\$ISSUE_NUM"/);
    assert.doesNotMatch(arm, /transition_status|slot-release/);
  });
});

// ── Real helpers ────────────────────────────────────────────────────────────

function git(cwd, ...args) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// A worktree on factory/issue-7 with origin/main and origin/factory/issue-7
// refs, one commit ahead of the PR branch and one uncommitted file.
function makeWorktree(dir) {
  const wt = join(dir, "wt");
  mkdirSync(wt);
  git(wt, "init", "-q", "-b", "factory/issue-7");
  git(wt, "config", "commit.gpgsign", "false");
  writeFileSync(join(wt, "a.txt"), "a\n");
  git(wt, "add", "a.txt");
  git(wt, "commit", "-q", "-m", "chore: base");
  git(wt, "update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(wt, "b.txt"), "b\n");
  git(wt, "add", "b.txt");
  git(wt, "commit", "-q", "-m", "feat: pushed");
  git(wt, "update-ref", "refs/remotes/origin/factory/issue-7", "HEAD");
  writeFileSync(join(wt, "c.txt"), "c\n");
  git(wt, "add", "c.txt");
  git(wt, "commit", "-q", "-m", "chore(wip): local");
  writeFileSync(join(wt, "d.txt"), "d\n");
  return wt;
}

const HELPERS = [
  "implement_runtime_facts",
  "implement_resume_decide",
  "implement_mark_resumable",
  "implement_resume_never_started",
];

function harness(dir, body, env = {}) {
  const snippet = [
    "set -euo pipefail",
    `SCRIPT_DIR="${SCRIPTS}"`,
    `LOG_FILE="${join(dir, "log")}"`,
    `STATE_FILE="${join(dir, "state.json")}"`,
    'IMPLEMENT_TIMEOUT_SEC="${IMPLEMENT_TIMEOUT_SEC:-2700}"',
    'FACTORY_IMPLEMENT_RESUME="${FACTORY_IMPLEMENT_RESUME:-1}"',
    'FACTORY_IMPLEMENT_SOFT_MARGIN_MIN="${FACTORY_IMPLEMENT_SOFT_MARGIN_MIN:-15}"',
    "FACTORY_IMPLEMENT_RESUME_MAX_AGE_MIN=360",
    'log() { printf "%s\\n" "$*" >>"$LOG_FILE"; }',
    ...HELPERS.map(extract),
    body,
  ].join("\n");
  const r = spawnSync("bash", ["-c", snippet], {
    encoding: "utf8",
    env: { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: "", ...env },
  });
  let log = "";
  try {
    log = readFileSync(join(dir, "log"), "utf8");
  } catch {
    // Nothing logged.
  }
  return { ...r, log };
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "implement-resume-sh-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedTranscript(dir, session, records) {
  const p = join(dir, ".claude", "projects", "-some-worktree");
  mkdirSync(p, { recursive: true });
  writeFileSync(
    join(p, `${session}.jsonl`),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

describe("implement_runtime_facts (real helper)", () => {
  it("puts the deadlines on the cap and counts what an earlier attempt left", () => {
    withDir((dir) => {
      const wt = makeWorktree(dir);
      const wtJson = JSON.stringify({ path: wt, branch: "factory/issue-7", reused: true });
      const r = harness(dir, `implement_runtime_facts 1763294400 0 '${wtJson}' "${wt}"`);
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.deepEqual(JSON.parse(r.stdout), {
        capMinutes: 45,
        startedAt: "2025-11-16T12:00:00Z",
        softDeadlineAt: "2025-11-16T12:30:00Z",
        hardDeadlineAt: "2025-11-16T12:45:00Z",
        resumed: false,
        worktree: { reused: true, leftoversRef: null, unpushedCommits: 1, uncommittedChanges: 1 },
      });
    });
  });

  it("clamps the margin so a short cap keeps 5 minutes before the soft deadline", () => {
    withDir((dir) => {
      const wt = makeWorktree(dir);
      const wtJson = JSON.stringify({
        branch: "factory/issue-7",
        reused: true,
        fastForwarded: true,
        leftoversRef: "refs/factory-leftovers/x",
      });
      const r = harness(dir, `implement_runtime_facts 1763294400 1 '${wtJson}' "${wt}"`, {
        IMPLEMENT_TIMEOUT_SEC: "600",
      });
      assert.equal(r.status, 0, r.stderr + r.log);
      const facts = JSON.parse(r.stdout);
      assert.equal(facts.capMinutes, 10);
      assert.equal(facts.softDeadlineAt, "2025-11-16T12:05:00Z");
      assert.equal(facts.hardDeadlineAt, "2025-11-16T12:10:00Z");
      assert.equal(facts.resumed, true);
      assert.equal(facts.worktree.leftoversRef, "refs/factory-leftovers/x");
      // A cap under 5 minutes leaves no margin at all.
      const tiny = harness(dir, `implement_runtime_facts 1763294400 0 '{}' "${wt}"`, {
        IMPLEMENT_TIMEOUT_SEC: "180",
      });
      const t = JSON.parse(tiny.stdout);
      assert.equal(t.softDeadlineAt, t.hardDeadlineAt);
    });
  });

  it("counts against origin/main when the PR branch isn't on origin, and fresh worktrees as not reused", () => {
    withDir((dir) => {
      const wt = makeWorktree(dir);
      git(wt, "update-ref", "-d", "refs/remotes/origin/factory/issue-7");
      const wtJson = JSON.stringify({ branch: "factory/issue-7", reused: false, created: true });
      const r = harness(dir, `implement_runtime_facts 1763294400 0 '${wtJson}' "${wt}"`);
      const facts = JSON.parse(r.stdout);
      assert.equal(facts.worktree.unpushedCommits, 2);
      assert.equal(facts.worktree.reused, false);
    });
  });
});

describe("implement_mark_resumable → implement_resume_decide (real helpers)", () => {
  const PLAN = JSON.stringify({ id: 111, body: "<!-- drafto-factory-plan -->" });
  const REVS = JSON.stringify([{ id: 40 }, { id: 5 }]);
  const PRIOR = JSON.stringify({ number: 9, state: "OPEN" });

  // Run 1 (fresh) decides, then times out and records itself; run 2 decides.
  function chain(dir, wt, { wt2 = { reused: true, fastForwarded: false }, between = "" } = {}) {
    const wt1 = JSON.stringify({
      path: wt,
      branch: "factory/issue-7",
      reused: false,
      created: true,
    });
    const pre = "b".repeat(40);
    return harness(
      dir,
      [
        `implement_resume_decide 7 "${wt}" '${wt1}' '${PRIOR}' '${PLAN}' '${REVS}'`,
        'echo "run1 $IMPL_RESUMED $IMPL_SESSION_FLAG $IMPL_SESSION_ID $IMPL_TASK_KEY"',
        `implement_mark_resumable 7 "${wt}" "$IMPL_SESSION_ID" "$IMPL_TASK_KEY" "${pre}" 1 "timed out"`,
        'mkdir -p "$HOME/.claude/projects/-wt"',
        'printf "{}\\n" >"$HOME/.claude/projects/-wt/$IMPL_SESSION_ID.jsonl"',
        "FIRST=$IMPL_SESSION_ID",
        between,
        `implement_resume_decide 7 "${wt}" '${JSON.stringify(wt2)}' '${PRIOR}' '${PLAN}' '${REVS}'`,
        'echo "run2 $IMPL_RESUMED $IMPL_SESSION_FLAG $IMPL_SESSION_ID $FIRST $IMPL_RESUME_PRE_HEAD"',
        // A third start finds the record already spent.
        `implement_resume_decide 7 "${wt}" '${JSON.stringify(wt2)}' '${PRIOR}' '${PLAN}' '${REVS}'`,
        'echo "run3 $IMPL_RESUMED $IMPL_SESSION_FLAG"',
      ].join("\n"),
    );
  }

  it("resumes the timed-out session once, with its PR head, and clears the record", () => {
    withDir((dir) => {
      const wt = makeWorktree(dir);
      const r = chain(dir, wt);
      assert.equal(r.status, 0, r.stderr + r.log);
      const [run1, run2, run3] = r.stdout.trim().split("\n");
      const [, resumed1, flag1, sid1, key1] = run1.split(" ");
      assert.equal(resumed1, "0");
      assert.equal(flag1, "--session-id");
      assert.match(sid1, /^[0-9a-f-]{36}$/);
      assert.equal(key1, "plan:111|rev:5,40");
      const [, resumed2, flag2, sid2, first, preHead] = run2.split(" ");
      assert.equal(resumed2, "1");
      assert.equal(flag2, "--resume");
      assert.equal(sid2, first);
      assert.equal(preHead, "b".repeat(40));
      assert.equal(run3, "run3 0 --session-id");
      assert.match(r.log, /fresh session [0-9a-f-]{36} \(no resume: no-record\)/);
      assert.match(
        r.log,
        /recorded resumable session [0-9a-f-]{36} \(timed out; worktree head [0-9a-f]{12}\)/,
      );
      assert.match(
        r.log,
        /resume session [0-9a-f-]{36} \(worktree head [0-9a-f]{12} unchanged; PR head before the first run: b{40}\)/,
      );
      const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
      assert.equal(state.issues["7"].implementResumeSession, null);
      assert.match(state.issues["7"].implementSessionId, /^[0-9a-f-]{36}$/);
    });
  });

  it("runs fresh when the worktree was fast-forwarded", () => {
    withDir((dir) => {
      const wt = makeWorktree(dir);
      const r = chain(dir, wt, { wt2: { reused: true, fastForwarded: true } });
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.match(r.stdout, /^run2 0 --session-id /m);
      assert.match(r.log, /no resume: worktree-moved, fast-forwarded/);
    });
  });

  it("runs fresh when the worktree HEAD moved since the stop", () => {
    withDir((dir) => {
      const wt = makeWorktree(dir);
      const r = chain(dir, wt, {
        between: `git -C "${wt}" commit -q --allow-empty -m "chore: more"`,
      });
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.match(r.stdout, /^run2 0 --session-id /m);
      assert.match(r.log, /no resume: head-moved/);
    });
  });

  it("runs fresh when resuming is off, and still clears the record", () => {
    withDir((dir) => {
      const wt = makeWorktree(dir);
      const r = chain(dir, wt, { between: "FACTORY_IMPLEMENT_RESUME=0" });
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.match(r.stdout, /^run2 0 --session-id /m);
      // Off also means nothing new is recorded.
      assert.match(r.log, /no resume: off/);
    });
  });

  it("records nothing when the PR head before the run is unknown, or resuming is off", () => {
    withDir((dir) => {
      const wt = makeWorktree(dir);
      const sid = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
      const r = harness(
        dir,
        [
          `implement_mark_resumable 7 "${wt}" ${sid} "plan:1|rev:" "" 0 "timed out"`,
          "FACTORY_IMPLEMENT_RESUME=0",
          `implement_mark_resumable 7 "${wt}" ${sid} "plan:1|rev:" "" 1 "timed out"`,
        ].join("\n"),
      );
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.match(r.log, /not resumable \(timed out\): the PR head before the run is unknown/);
      assert.doesNotMatch(r.log, /recorded resumable/);
      assert.throws(() => readFileSync(join(dir, "state.json")), /ENOENT/);
    });
  });
});

describe("implement_resume_never_started (real helper)", () => {
  const SID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

  function check(dir, startOffsetSec) {
    return harness(
      dir,
      [
        "SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
        `START=$(( $(date +%s) - ${startOffsetSec} ))`,
        `if implement_resume_never_started ${SID} "$SINCE" "$START"; then echo never; else echo started; fi`,
      ].join("\n"),
    );
  }

  it("is true for a quick exit whose session never answered", () => {
    withDir((dir) => {
      seedTranscript(dir, SID, [
        { type: "assistant", timestamp: "2026-01-01T00:00:00Z", message: {} },
      ]);
      const r = check(dir, 5);
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.equal(r.stdout.trim(), "never");
    });
  });

  it("is false after 180 s, whatever the transcript says", () => {
    withDir((dir) => {
      seedTranscript(dir, SID, []);
      assert.equal(check(dir, 181).stdout.trim(), "started");
    });
  });

  it("is false once the session answered after the start", () => {
    withDir((dir) => {
      seedTranscript(dir, SID, [
        { type: "assistant", timestamp: new Date(Date.now() + 60_000).toISOString(), message: {} },
      ]);
      assert.equal(check(dir, 5).stdout.trim(), "started");
    });
  });
});

it("every new helper uses plain strings, no arrays (bash 3.2 under set -u)", () => {
  for (const fn of HELPERS) {
    const m = script.match(new RegExp(`^${fn}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m"));
    assert.ok(m, fn);
    // No arrays: an empty one under set -u throws on the Mac mini's bash 3.2.
    assert.doesNotMatch(m[0], /\w+=\(|"\$\{\w+\[@\]\}"/, `${fn} must not use arrays`);
  }
});
