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
import { hermeticEnv } from "./helpers/hermetic-env.mjs";

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
      /CLAUDE_CALL_KILL_GRACE_SEC="\$FACTORY_IMPLEMENT_TERM_GRACE_SEC" CLAUDE_CALL_KILL_GROUP=1 \\\n\s*node "\$SCRIPT_DIR\/lib\/run-claude\.mjs" -p "\$CLAUDE_INPUT" --dangerously-skip-permissions --effort "\$FACTORY_EFFORT" --no-chrome --strict-mcp-config \\\n\s*"\$IMPL_SESSION_FLAG" "\$IMPL_SESSION_ID" \)/,
    );
    assert.equal(script.split("CLAUDE_CALL_KILL_GRACE_SEC=").length - 1, 1);
    // Claude's descendants die with it at the cap (#842 review); other calls
    // keep signalling the direct child only.
    assert.equal(script.split("CLAUDE_CALL_KILL_GROUP=1").length - 1, 1);
    assert.equal(script.split('"$IMPL_SESSION_FLAG" "$IMPL_SESSION_ID"').length - 1, 1);
  });

  it("decides after the PR head capture and before the run, and inherits the first run's head", () => {
    const capture = IMPLEMENT.indexOf('PRE_HEAD_OID=$(pr_head_oid "$(echo "$PRIOR_PR"');
    const decide = IMPLEMENT.indexOf("if ! implement_resume_decide ");
    const inherit = IMPLEMENT.indexOf('CHAIN_PRE_HEAD_OID="$IMPL_RESUME_PRE_HEAD"');
    const run = IMPLEMENT.indexOf("Invoking claude for #$ISSUE_NUM (--implement");
    assert.ok(capture !== -1 && capture < decide && decide < inherit && inherit < run);
    assert.match(
      IMPLEMENT,
      /CHAIN_PRE_HEAD_OID="\$PRE_HEAD_OID"\n\s*CHAIN_PRE_HEAD_KNOWN="\$PRE_HEAD_KNOWN"\n\s*if \[\[ "\$IMPL_RESUMED" -eq 1 \]\]; then\n\s*CHAIN_PRE_HEAD_OID="\$IMPL_RESUME_PRE_HEAD"\n\s*CHAIN_PRE_HEAD_KNOWN=1\n/,
    );
    // The current head is never overwritten: the noop and declined checks
    // compare with the PR head at this run's start (#842 review).
    assert.doesNotMatch(IMPLEMENT, /\n\s*PRE_HEAD_OID="\$IMPL_RESUME_PRE_HEAD"/);
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
      /if \[\[ "\$IMPL_RESUMED" -eq 0 \]\]; then\n\s*implement_mark_resumable "\$ISSUE_NUM" "\$WT_PATH" "\$IMPL_SESSION_ID" "\$IMPL_TASK_KEY" \\\n\s*"\$CHAIN_PRE_HEAD_OID" "\$CHAIN_PRE_HEAD_KNOWN" "timed out" "\$IMPL_FEEDBACK_DIGEST"\n\s*fi/,
    );
    assert.match(branch, /factory:bump-attempts "\$ISSUE_NUM"/);
    assert.match(branch, /return 0\n$/);
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
      /if \[\[ "\$IMPL_RESUMED" -eq 1 \]\] \\\n\s*&& implement_resume_never_started "\$IMPL_SESSION_ID" "\$CLAUDE_START_ISO" "\$IMPL_START_EPOCH"; then\n\s*log "[^"]*never started[^"]*"\n\s*return 0\n/,
    );
  });

  it("records a session the limit stopped, resumed or not, before pausing", () => {
    const branch = slice(
      'if check_session_limit "$WT_PATH" "$CLAUDE_START_ISO" "$IMPL_SESSION_ID"; then',
      "        exit 0\n",
    );
    const mark = branch.indexOf("implement_mark_resumable ");
    assert.ok(mark !== -1 && mark < branch.indexOf("pause_for_session_limit"));
    assert.match(
      branch,
      /"\$CHAIN_PRE_HEAD_OID" "\$CHAIN_PRE_HEAD_KNOWN" "session limit" "\$IMPL_FEEDBACK_DIGEST"\n/,
    );
    assert.doesNotMatch(branch, /IMPL_RESUMED/, "a resumed run is recorded again after a limit");
    assert.doesNotMatch(branch, /bump-attempts/);
  });

  it("spends an attempt when the worktree diverged from the PR branch, so the card can reach Blocked", () => {
    const branch = slice("WT_DIVERGED=0\n", '    fi\n    cat "$WT_ERR_FILE"');
    assert.match(branch, /grep -q 'has diverged from' "\$WT_ERR_FILE"/);
    assert.ok(
      branch.indexOf("WT_DIVERGED=1") < branch.indexOf("worktree_cli_error"),
      "read the error before worktree_cli_error deletes the file",
    );
    assert.match(
      branch,
      /if \[\[ "\$WT_DIVERGED" -eq 1 \]\]; then\n[^\n]*has diverged[^\n]*\n\s*node "\$SCRIPT_DIR\/lib\/state-cli\.mjs" factory:bump-attempts "\$ISSUE_NUM"/,
    );
    // Any other add failure (origin unreachable…) still spends nothing.
    assert.equal(branch.split("bump-attempts").length - 1, 1);
  });

  it("gives action=incomplete its own arm: resumable when fresh, attempt spent", () => {
    const arm = slice("      incomplete)\n", "        ;;\n");
    assert.match(arm, /action=incomplete\); keeping slot \$SLOT for retry/);
    assert.match(arm, /if \[\[ "\$IMPL_RESUMED" -eq 0 \]\]; then\n\s*implement_mark_resumable /);
    assert.match(arm, /"action=incomplete" "\$IMPL_FEEDBACK_DIGEST"\n/);
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
  // The harness commits too (the "HEAD moved" case), without the env above:
  // CI runners have no global identity.
  git(wt, "config", "user.name", "t");
  git(wt, "config", "user.email", "t@example.com");
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
    env: hermeticEnv({ HOME: dir, CLAUDE_CONFIG_DIR: "", ...env }),
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

  it("reports null counts, not 0, when git can't read the worktree", () => {
    withDir((dir) => {
      const notGit = join(dir, "plain");
      mkdirSync(notGit);
      const r = harness(dir, `implement_runtime_facts 1763294400 0 '{"reused":true}' "${notGit}"`);
      assert.equal(r.status, 0, r.stderr + r.log);
      const facts = JSON.parse(r.stdout);
      assert.equal(facts.worktree.unpushedCommits, null);
      assert.equal(facts.worktree.uncommittedChanges, null);
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
  const REVS = JSON.stringify([
    { id: 40, body: "make it blue" },
    { id: 5, body: "and faster" },
  ]);
  const PRIOR = JSON.stringify({ number: 9, state: "OPEN" });
  const ISSUE = JSON.stringify({ number: 7, title: "feat: x", body: "### What\nA" });

  // Run 1 (fresh) decides, then times out and records itself; run 2 decides.
  function chain(
    dir,
    wt,
    {
      wt2 = { reused: true, fastForwarded: false },
      between = "",
      plan2 = PLAN,
      revs2 = REVS,
      issue2 = ISSUE,
      comments1 = "[]",
      comments2 = comments1,
      env = { PHASE: "C" },
    } = {},
  ) {
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
        `implement_resume_decide 7 "${wt}" '${wt1}' '${PRIOR}' '${PLAN}' '${REVS}' '${ISSUE}' '${comments1}'`,
        'echo "run1 $IMPL_RESUMED $IMPL_SESSION_FLAG $IMPL_SESSION_ID $IMPL_TASK_KEY"',
        `implement_mark_resumable 7 "${wt}" "$IMPL_SESSION_ID" "$IMPL_TASK_KEY" "${pre}" 1 "timed out" "$IMPL_FEEDBACK_DIGEST"`,
        'mkdir -p "$HOME/.claude/projects/-wt"',
        'printf "{}\\n" >"$HOME/.claude/projects/-wt/$IMPL_SESSION_ID.jsonl"',
        "FIRST=$IMPL_SESSION_ID",
        between,
        `implement_resume_decide 7 "${wt}" '${JSON.stringify(wt2)}' '${PRIOR}' '${plan2}' '${revs2}' '${issue2}' '${comments2}'`,
        'echo "run2 $IMPL_RESUMED $IMPL_SESSION_FLAG $IMPL_SESSION_ID $FIRST $IMPL_RESUME_PRE_HEAD"',
        // A third start finds the record already spent.
        `implement_resume_decide 7 "${wt}" '${JSON.stringify(wt2)}' '${PRIOR}' '${PLAN}' '${REVS}' '${ISSUE}'`,
        'echo "run3 $IMPL_RESUMED $IMPL_SESSION_FLAG"',
      ].join("\n"),
      env,
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
      assert.match(
        key1,
        /^plan:111@[0-9a-f]{16}\|rev:5@[0-9a-f]{16},40@[0-9a-f]{16}\|issue:[0-9a-f]{16}\|phase:C$/,
      );
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
        /resume session [0-9a-f-]{36} \(worktree head [0-9a-f]{12} and files unchanged; PR head before the first run: b{40}\)/,
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

  // #842 review: an approved plan edited in place keeps its comment id.
  it("runs fresh when the approved plan was edited in place since the stop", () => {
    withDir((dir) => {
      const wt = makeWorktree(dir);
      const edited = JSON.stringify({ id: 111, body: "<!-- drafto-factory-plan -->\nNow also X." });
      const r = chain(dir, wt, { plan2: edited });
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.match(r.stdout, /^run2 0 --session-id /m);
      assert.match(r.log, /no resume: task-changed/);
    });
  });

  // #842 review: the issue body is the spec; a fresh bundle reads it again.
  it("runs fresh when the issue body was edited since the stop", () => {
    withDir((dir) => {
      const wt = makeWorktree(dir);
      const edited = JSON.stringify({ number: 7, title: "feat: x", body: "### What\nB" });
      const r = chain(dir, wt, { issue2: edited });
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.match(r.stdout, /^run2 0 --session-id /m);
      assert.match(r.log, /no resume: task-changed/);
    });
  });

  // #842 review: a session started under another FACTORY_PHASE holds that
  // phase's scope.
  // #842 review: a first implementation's key names no feedback, so the
  // resume compares the reporter's comments in the stopped run's snapshot
  // (the one its bundle was built from) with this start's. GitHub data only.
  describe("the comment snapshot", () => {
    const c = (id, body, createdAt = "2026-11-16T09:00:00Z", who = "OWNER") => ({
      id,
      authorAssociation: who,
      body,
      createdAt,
    });
    const planC = c(1, "<!-- drafto-factory-plan -->\nPlan");
    const snap = [planC, c(2, "an early question")];
    const S = (list) => JSON.stringify(list);
    const second = (dir, comments2) => {
      const wt = makeWorktree(dir);
      return chain(dir, wt, { comments1: S(snap), comments2: S(comments2) });
    };

    it("runs fresh for a comment that landed after the snapshot but before claude started", () => {
      withDir((dir) => {
        // Stamped before the stopped run's start (and before the snapshot's
        // newest): only the snapshot can tell it wasn't in the bundle.
        const r = second(dir, [...snap, c(3, "please also handle X", "2026-11-16T08:59:00Z")]);
        assert.equal(r.status, 0, r.stderr + r.log);
        assert.match(r.stdout, /^run2 0 --session-id /m);
        assert.match(r.log, /no resume: new-feedback, the comments changed/);
      });
    });

    it("runs fresh when a reporter comment was edited or deleted", () => {
      withDir((dir) => {
        assert.match(
          second(dir, [planC, c(2, "an edited question")]).log,
          /no resume: new-feedback/,
        );
      });
      withDir((dir) => {
        assert.match(second(dir, [planC]).log, /no resume: new-feedback/);
      });
    });

    it("runs fresh for a support-agent forward (ADR-0066)", () => {
      withDir((dir) => {
        const fwd = c(
          4,
          "**Customer replied via support@drafto.eu:**\n> hi\n<!-- drafto-support-forward sender:a@b.c -->",
        );
        assert.match(second(dir, [...snap, fwd]).log, /no resume: new-feedback/);
      });
    });

    it("resumes past the factory's own marker comments and other people's", () => {
      withDir((dir) => {
        const r = second(dir, [
          ...snap,
          c(5, "🏭 fixed\n<!-- drafto-factory-revise-reply-2 -->"),
          c(6, "drive-by", "2026-11-16T10:00:00Z", "NONE"),
        ]);
        assert.equal(r.status, 0, r.stderr + r.log);
        assert.match(r.stdout, /^run2 1 --resume /m);
      });
    });
  });

  it("runs fresh when FACTORY_PHASE changed since the stop", () => {
    withDir((dir) => {
      const wt = makeWorktree(dir);
      const r = chain(dir, wt, { between: "PHASE=D" });
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.match(r.stdout, /^run2 0 --session-id /m);
      assert.match(r.log, /no resume: task-changed/);
    });
  });

  it("runs fresh when a feedback comment was edited in place since the stop", () => {
    withDir((dir) => {
      const wt = makeWorktree(dir);
      const edited = JSON.stringify([
        { id: 40, body: "make it green" },
        { id: 5, body: "and faster" },
      ]);
      const r = chain(dir, wt, { revs2: edited });
      assert.match(r.stdout, /^run2 0 --session-id /m);
      assert.match(r.log, /no resume: task-changed/);
    });
  });

  // #842 review: uncommitted edits that don't move HEAD.
  it("runs fresh when an uncommitted file changed but HEAD didn't", () => {
    withDir((dir) => {
      const wt = makeWorktree(dir);
      const r = chain(dir, wt, { between: `printf 'edited\\n' >"${wt}/d.txt"` });
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.match(r.stdout, /^run2 0 --session-id /m);
      assert.match(r.log, /no resume: worktree-dirty-changed/);
    });
  });

  it("runs fresh when a new untracked file appeared, and resumes past an ignored one", () => {
    withDir((dir) => {
      const wt = makeWorktree(dir);
      const added = chain(dir, wt, { between: `printf 'x\\n' >"${wt}/e.txt"` });
      assert.match(added.log, /no resume: worktree-dirty-changed/);
    });
    withDir((dir) => {
      const wt = makeWorktree(dir);
      const ignored = chain(dir, wt, {
        between: `printf 'e.txt\\n' >>"${wt}/.git/info/exclude"; printf 'x\\n' >"${wt}/e.txt"`,
      });
      assert.match(ignored.stdout, /^run2 1 --resume /m);
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

// #842 review: a resumed run keeps two PR heads. PRE_HEAD_OID is the head at
// its own start (the noop and declined checks); CHAIN_PRE_HEAD_OID is the head
// before the chain's first run (implemented's "did the PR move" and the
// migration post-check). These run the real `case "$ACTION"` arms with the
// board, gh and the follow-on helpers stubbed, for a resumed revision run whose
// stopped predecessor had already pushed.
describe("result handler on a resumed run whose predecessor already pushed (real arms)", () => {
  const caseStart = script.indexOf('    case "$ACTION" in\n      implemented)');
  const caseEnd = script.indexOf("\n    esac\n", caseStart) + "\n    esac\n".length;
  const CASE = script.slice(caseStart, caseEnd);

  // B0: the head shown at In Test (the chain's baseline). B1: what the stopped
  // predecessor pushed. B2: an unpushed chore(wip) commit on top of B1.
  function repo(dir) {
    const wt = join(dir, "wt");
    mkdirSync(wt);
    git(wt, "init", "-q");
    git(wt, "config", "user.name", "t");
    git(wt, "config", "user.email", "t@example.com");
    git(wt, "config", "commit.gpgsign", "false");
    const shas = [];
    for (const name of ["B0", "B1", "B2"]) {
      git(wt, "commit", "-q", "--allow-empty", "-m", name);
      shas.push(git(wt, "rev-parse", "HEAD"));
    }
    return { wt, b0: shas[0], b1: shas[1], b2: shas[2] };
  }

  function run(dir, vars) {
    const calls = join(dir, "calls");
    const v = {
      ISSUE_NUM: "7",
      ITEM_ID: "item-7",
      SLOT: "0",
      IS_REVISION: "1",
      PRE_HEAD_KNOWN: "1",
      CHAIN_PRE_HEAD_KNOWN: "1",
      PR_URL: "https://github.com/JakubAnderwald/drafto/pull/9",
      PRIOR_PR: JSON.stringify({ number: 9, state: "OPEN" }),
      COMMENTS_JSON: "[]",
      NOW_ISO: "2026-11-16T12:00:00Z",
      FEEDBACK_MARK: "2026-11-16T11:00:00Z",
      REPLY_MARKERS: "[]",
      AFFECTED: "web",
      PARITY_OVERRIDE: "",
      BUNDLE: "{}",
      ITEM_LABELS: "status:in-progress",
      IMPL_RESUMED: "1",
      IMPL_SESSION_ID: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      IMPL_TASK_KEY: "plan:1@x|rev:",
      IMPL_FEEDBACK_DIGEST: "f".repeat(64),
      ...vars,
    };
    const snippet = [
      "set -euo pipefail",
      `SCRIPT_DIR=/stub; STATE_FILE="${join(dir, "state.json")}"; LOG_FILE="${join(dir, "log")}"; CALLS="${calls}"`,
      ...Object.entries(v).map(([k, val]) => `${k}='${val}'`),
      'log() { printf "%s\\n" "$*" >>"$LOG_FILE"; }',
      'find_prior_pr() { printf \'{"number":9,"url":"%s","state":"OPEN"}\' "$PR_URL"; }',
      'pr_head_oid() { printf "%s" "$FAKE_POST_HEAD"; }',
      'transition_status() { echo "transition $3" >>"$CALLS"; }',
      'implement_parity_gate() { echo "parity" >>"$CALLS"; }',
      'implement_migration_claim_check() { echo "claim head=$3 since=$4" >>"$CALLS"; }',
      'revise_replies_check() { echo "replies $4" >>"$CALLS"; }',
      'revision_noop_route() { echo "noop-route head=$4" >>"$CALLS"; }',
      'revision_return_to_test() { echo "return-to-test head=$3" >>"$CALLS"; }',
      'implement_park_blocked() { echo "blocked: $4" >>"$CALLS"; }',
      'implement_mark_resumable() { echo "mark-resumable $5 $6 $7 $8" >>"$CALLS"; }',
      "worktree_untouched() { return 0; }",
      'implement_head_landed() { echo "landed? $3" >>"$CALLS"; [[ "${FAKE_LANDED:-1}" == "1" ]]; }',
      'gh() { echo "gh $1 $2" >>"$CALLS"; }',
      'node() { echo "node $2 $3 $4" >>"$CALLS"; case "$*" in *factory:get-issue*) printf \'{"intestCommentSha":"%s"}\' "$FAKE_SHOWN" ;; esac; }',
      // The arms live in implement_handle_result, where `return 0` ends a card.
      "_arms() {",
      CASE,
      "}",
      "_arms",
      'echo "exit-ok"',
    ].join("\n");
    const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8", env: hermeticEnv() });
    const read = (f) => {
      try {
        return readFileSync(f, "utf8");
      } catch {
        return "";
      }
    };
    return { ...r, calls: read(calls), log: read(join(dir, "log")) };
  }

  it("implemented with nothing more to push: the predecessor's push counts, no false 'head unchanged'", () => {
    withDir((dir) => {
      const { wt, b0, b1 } = repo(dir);
      git(wt, "checkout", "-q", b1);
      const r = run(dir, {
        ACTION: "implemented",
        WT_PATH: wt,
        PRE_HEAD_OID: b1,
        CHAIN_PRE_HEAD_OID: b0,
        FAKE_POST_HEAD: b1,
      });
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.match(r.stdout, /exit-ok/);
      assert.doesNotMatch(r.log, /head is unchanged/);
      assert.match(r.calls, /^transition In Review$/m);
      // Migrations: everything the chain added since its baseline is this card's.
      assert.match(r.calls, new RegExp(`^claim head=${b1} since=${b0}$`, "m"));
      assert.doesNotMatch(r.calls, /bump-attempts/);
      assert.match(r.calls, /factory:reset-attempts/);
    });
  });

  it("implemented whose worktree commits never reached the PR: not advanced, feedback unconsumed", () => {
    withDir((dir) => {
      const { wt, b0, b1, b2 } = repo(dir);
      git(wt, "checkout", "-q", b2);
      const r = run(dir, {
        ACTION: "implemented",
        WT_PATH: wt,
        PRE_HEAD_OID: b1,
        CHAIN_PRE_HEAD_OID: b0,
        FAKE_POST_HEAD: b1,
        FAKE_LANDED: "0",
      });
      assert.equal(r.status, 0, r.stderr + r.log);
      // The chain moved the PR (B0 → B1), so only the landed check stops it.
      assert.doesNotMatch(r.log, /head is unchanged/);
      assert.match(r.calls, new RegExp(`^landed\\? ${b1}$`, "m"));
      assert.match(r.log, /the worktree's commits aren't all on PR #9/);
      assert.match(r.calls, /factory:bump-attempts/);
      assert.doesNotMatch(r.calls, /transition In Review|lastFeedbackAt|parity/);
    });
  });

  it("implemented that moved nothing since the chain's baseline is still a failed attempt", () => {
    withDir((dir) => {
      const { wt, b0 } = repo(dir);
      const r = run(dir, {
        ACTION: "implemented",
        WT_PATH: wt,
        PRE_HEAD_OID: b0,
        CHAIN_PRE_HEAD_OID: b0,
        FAKE_POST_HEAD: b0,
      });
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.match(r.log, /claimed action=implemented but PR #9 head is unchanged/);
      assert.match(r.calls, /factory:bump-attempts/);
      assert.doesNotMatch(r.calls, /transition In Review/);
    });
  });

  it("implemented on a chain whose first run had no PR: the whole PR is the chain's", () => {
    withDir((dir) => {
      const { wt, b1 } = repo(dir);
      git(wt, "checkout", "-q", b1);
      const r = run(dir, {
        ACTION: "implemented",
        IS_REVISION: "0",
        WT_PATH: wt,
        PRE_HEAD_OID: b1,
        CHAIN_PRE_HEAD_OID: "",
        FAKE_POST_HEAD: b1,
      });
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.match(r.calls, /^claim head= since=all$/m);
      assert.match(r.calls, /^transition In Review$/m);
    });
  });

  it("noop with the worktree on the pushed head: routed on the current head, not the stale baseline", () => {
    withDir((dir) => {
      const { wt, b0, b1 } = repo(dir);
      git(wt, "checkout", "-q", b1);
      const r = run(dir, {
        ACTION: "noop",
        WT_PATH: wt,
        PRE_HEAD_OID: b1,
        CHAIN_PRE_HEAD_OID: b0,
        FAKE_SHOWN: b0,
      });
      assert.equal(r.status, 0, r.stderr + r.log);
      // revision_noop_route compares this with the head shown at In Test (B0),
      // so B1 goes through In Review instead of re-presenting a moved PR.
      assert.match(r.calls, new RegExp(`^noop-route head=${b1}$`, "m"));
      assert.doesNotMatch(r.calls, /bump-attempts/);
    });
  });

  it("noop with an unpushed wip commit on top: work not landed, attempt spent", () => {
    withDir((dir) => {
      const { wt, b0, b1, b2 } = repo(dir);
      git(wt, "checkout", "-q", b2);
      const r = run(dir, {
        ACTION: "noop",
        WT_PATH: wt,
        PRE_HEAD_OID: b1,
        CHAIN_PRE_HEAD_OID: b0,
      });
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.match(r.log, /work was committed and not landed/);
      assert.match(r.calls, /factory:bump-attempts/);
      assert.doesNotMatch(r.calls, /noop-route/);
    });
  });

  it("declined after the predecessor pushed: the PR isn't the one shown at In Test, so Blocked", () => {
    withDir((dir) => {
      const { wt, b0, b1 } = repo(dir);
      git(wt, "checkout", "-q", b1);
      const r = run(dir, {
        ACTION: "declined",
        WT_PATH: wt,
        PRE_HEAD_OID: b1,
        CHAIN_PRE_HEAD_OID: b0,
        FAKE_SHOWN: b0,
        FAKE_POST_HEAD: b1,
      });
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.match(r.calls, /^blocked: implementer declined/m);
      assert.doesNotMatch(r.calls, /return-to-test/);
    });
  });

  it("incomplete on a resumed run spends the attempt and records nothing new", () => {
    withDir((dir) => {
      const { wt, b0, b1 } = repo(dir);
      const r = run(dir, {
        ACTION: "incomplete",
        WT_PATH: wt,
        PRE_HEAD_OID: b1,
        CHAIN_PRE_HEAD_OID: b0,
      });
      assert.equal(r.status, 0, r.stderr + r.log);
      assert.match(r.calls, /factory:bump-attempts/);
      assert.doesNotMatch(r.calls, /mark-resumable/);
      // A fresh run's incomplete records the chain baseline.
      const fresh = run(dir, {
        ACTION: "incomplete",
        IMPL_RESUMED: "0",
        WT_PATH: wt,
        PRE_HEAD_OID: b0,
        CHAIN_PRE_HEAD_OID: b0,
      });
      assert.match(
        fresh.calls,
        new RegExp(`^mark-resumable ${b0} 1 action=incomplete ${"f".repeat(64)}$`, "m"),
      );
    });
  });
});

// #842 review: action=implemented only advances when the worktree's commits
// are on the PR. The real helper, against a bare origin.
describe("implement_head_landed (real helper, bare origin)", () => {
  function setup(dir) {
    const origin = join(dir, "origin.git");
    const wt = join(dir, "wt");
    mkdirSync(wt);
    spawnSync("git", ["init", "-q", "--bare", origin]);
    git(wt, "init", "-q");
    git(wt, "config", "user.name", "t");
    git(wt, "config", "user.email", "t@example.com");
    git(wt, "config", "commit.gpgsign", "false");
    git(wt, "remote", "add", "origin", origin);
    git(wt, "commit", "-q", "--allow-empty", "-m", "B0");
    const b0 = git(wt, "rev-parse", "HEAD");
    git(wt, "commit", "-q", "--allow-empty", "-m", "B1");
    const b1 = git(wt, "rev-parse", "HEAD");
    git(wt, "push", "-q", "origin", "HEAD:refs/heads/factory/issue-7");
    return { wt, b0, b1 };
  }

  const check = (dir, wt, head) =>
    harness(
      dir,
      [
        extract("implement_head_landed"),
        `if implement_head_landed "${wt}" 7 "${head}"; then echo landed; else echo missing; fi`,
      ].join("\n"),
    );

  it("lands when the worktree HEAD is the PR head, or behind it", () => {
    withDir((dir) => {
      const { wt, b0, b1 } = setup(dir);
      assert.equal(check(dir, wt, b1).stdout.trim(), "landed");
      git(wt, "checkout", "-q", b0);
      assert.equal(check(dir, wt, b1).stdout.trim(), "landed");
    });
  });

  it("is missing when the worktree has a commit the branch lacks, whatever head GitHub reported", () => {
    withDir((dir) => {
      const { wt, b1 } = setup(dir);
      git(wt, "commit", "-q", "--allow-empty", "-m", "wip");
      assert.equal(check(dir, wt, b1).stdout.trim(), "missing");
      assert.equal(check(dir, wt, "").stdout.trim(), "missing");
    });
  });

  // #842 review: GitHub's PR view can lag a push, so a stale reported head
  // must not reject work origin already accepted.
  it("reads the branch head origin accepted, not a stale reported PR head", () => {
    withDir((dir) => {
      const { wt, b0 } = setup(dir);
      git(wt, "commit", "-q", "--allow-empty", "-m", "B2");
      git(wt, "push", "-q", "origin", "HEAD:refs/heads/factory/issue-7");
      // GitHub still reports B0; the branch on origin is the worktree's B2.
      assert.equal(check(dir, wt, b0).stdout.trim(), "landed");
      assert.equal(check(dir, wt, "").stdout.trim(), "landed");
    });
  });

  it("is missing when the branch isn't on origin at all", () => {
    withDir((dir) => {
      const { wt, b0 } = setup(dir);
      git(wt, "push", "-q", "origin", "--delete", "factory/issue-7");
      git(wt, "update-ref", "-d", "refs/remotes/origin/factory/issue-7");
      assert.equal(check(dir, wt, b0).stdout.trim(), "missing");
    });
  });

  it("fetches a PR head it doesn't have yet before judging", () => {
    withDir((dir) => {
      const { wt, b1 } = setup(dir);
      // Someone else pushes on top of B1; the worktree never saw that commit.
      const other = join(dir, "other");
      spawnSync("git", ["clone", "-q", join(dir, "origin.git"), other]);
      git(other, "config", "user.name", "t");
      git(other, "config", "user.email", "t@example.com");
      git(other, "checkout", "-q", "factory/issue-7");
      git(other, "commit", "-q", "--allow-empty", "-m", "B2");
      const b2 = git(other, "rev-parse", "HEAD");
      git(other, "push", "-q", "origin", "HEAD:refs/heads/factory/issue-7");
      git(wt, "checkout", "-q", b1);
      assert.equal(check(dir, wt, b2).stdout.trim(), "landed");
    });
  });
});

// #842 review: what the factory hands task-key is the raw plan comment that
// extract_plan_comment picks from fetch_issue_comments' output ({id, body}),
// not the bundle's approvedPlan. Through that real path, an edit to the plan's
// body changes the key.
describe("task key through the caller's real plan comment shape", () => {
  const comments = (planBody) =>
    JSON.stringify([
      {
        id: 111,
        user: { login: "o" },
        body: `<!-- drafto-factory-plan -->\n${planBody}`,
        createdAt: "2026-11-16T10:00:00Z",
        authorAssociation: "OWNER",
      },
      {
        id: 112,
        user: { login: "x" },
        body: "a comment from someone else",
        createdAt: "2026-11-16T10:05:00Z",
        authorAssociation: "NONE",
      },
    ]);
  const key = (dir, planBody) =>
    harness(
      dir,
      [
        extract("plan_comment_jq"),
        extract("extract_plan_comment"),
        `plan=$(extract_plan_comment '${comments(planBody)}')`,
        'echo "$plan" | jq -r .id',
        `node "$SCRIPT_DIR/lib/implement-resume.mjs" task-key --plan-comment "$plan" --revision-comments '[]'`,
      ].join("\n"),
    );

  it("keys on the plan comment's id and body, and changes when the body is edited", () => {
    withDir((dir) => {
      const a = key(dir, "## Approach\nDo A.");
      assert.equal(a.status, 0, a.stderr + a.log);
      const [id, k] = a.stdout.trim().split("\n");
      assert.equal(id, "111");
      assert.match(k, /^plan:111@[0-9a-f]{16}\|rev:\|issue:/);
      const b = key(dir, "## Approach\nDo B.");
      assert.notEqual(b.stdout.trim().split("\n")[1], k);
    });
  });
});
