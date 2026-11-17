// implement_handle_result: what --implement does with a finished claude run,
// pulled out of the loop body verbatim so a detached run (ADR-0085) can be
// collected through the same code. And slot_acquire, which reads
// factory:slot-acquire's JSON because the CLI exits 0 when it refuses (#466).
//
// The handler runs for real in bash, with node, gh, git and the follow-on
// helpers stubbed, once per branch. It is called from a two-card loop, as the
// --implement loop calls it: `return 0` must go on to the next card, and a
// session limit must end the whole tick (`exit 0`).
//
// slot_acquire runs against the real state CLI and a temp state file, with a
// real process standing in for a detached implement run.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..");
const AGENT = resolve(SCRIPTS, "factory-agent.sh");
const script = readFileSync(AGENT, "utf8");

function fnText(name) {
  const a = script.indexOf(`\n${name}() {\n`);
  assert.ok(a !== -1, `${name} not found`);
  const b = script.indexOf("\n}\n", a);
  return script.slice(a + 1, b + 3);
}

const HANDLER = fnText("implement_handle_result");
const SLOT_ACQUIRE = fnText("slot_acquire");

const dirs = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "fa-impl-handler-"));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const read = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

describe("implement_handle_result: where it lives", () => {
  const section = script.slice(
    script.indexOf("# ── --implement mode"),
    script.indexOf("# ── --watch mode"),
  );

  it("is defined inside the --implement section, before the mode's if", () => {
    const def = section.indexOf("\nimplement_handle_result() {\n");
    const modeIf = section.indexOf('\nif [[ "$MODE_IMPLEMENT" -eq 1 ]]; then\n');
    assert.ok(def !== -1 && modeIf !== -1 && def < modeIf);
  });

  it("is called straight after the implement claude run, as the loop body's last step", () => {
    assert.match(
      section,
      /"\$IMPL_SESSION_FLAG" "\$IMPL_SESSION_ID" \) >"\$CLAUDE_OUTPUT_FILE" 2>>"\$LOG_FILE" \|\| EXIT_CODE=\$\?\n\n {4}implement_handle_result\n {2}done\n/,
    );
    assert.equal(section.split(/\n\s*implement_handle_result\n/).length - 1, 1);
  });

  it("has no `continue` left (it isn't in a loop) and still exits 0 at a session limit", () => {
    assert.doesNotMatch(HANDLER, /^\s*continue\b/m);
    assert.match(HANDLER, /pause_for_session_limit\n[^\n]*completed in[^\n]*\n\s*exit 0\n/);
  });
});

// Run the handler for card #7 in a two-card loop. `vars` override the globals
// the loop body sets; FAKE_* steer the stubs.
function runHandler(vars = {}, { output = "" } = {}) {
  const dir = tempDir();
  const calls = join(dir, "calls");
  const outFile = join(dir, "claude-out");
  const v = {
    ISSUE_NUM: "7",
    ITEM_ID: "item-7",
    ITEM_LABELS: "status:in-progress",
    SLOT: "1",
    WT_PATH: dir,
    EXIT_CODE: "0",
    CLAUDE_OUTPUT_FILE: outFile,
    CLAUDE_START_ISO: "2026-11-16T10:00:00Z",
    IMPL_START_EPOCH: "1700000000",
    IMPL_RESUMED: "0",
    IMPL_SESSION_ID: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    IMPL_TASK_KEY: "plan:1@x|rev:",
    IMPL_FEEDBACK_DIGEST: "f".repeat(64),
    PRE_HEAD_OID: "",
    PRE_HEAD_KNOWN: "1",
    CHAIN_PRE_HEAD_OID: "",
    CHAIN_PRE_HEAD_KNOWN: "1",
    PRIOR_PR: "null",
    COMMENTS_JSON: "[]",
    BUNDLE: "{}",
    AFFECTED: "web",
    PARITY_OVERRIDE: "",
    IS_REVISION: "0",
    FEEDBACK_CONSUMED_AT: "",
    REPLY_MARKERS: "[]",
    IMPLEMENT_TIMEOUT_SEC: "2700",
    MODE_NAME: "implement",
    START_TIME: "0",
    FAKE_PR: '{"number":9,"url":"https://github.com/JakubAnderwald/drafto/pull/9","state":"OPEN"}',
    FAKE_POST_HEAD: "",
    FAKE_LIMIT: "1",
    FAKE_NEVER_STARTED: "1",
    FAKE_PARITY: "0",
    FAKE_LANDED: "0",
    FAKE_LOCAL_HEAD: "",
    FAKE_ANCESTOR: "1", // merge-base --is-ancestor's exit code
    FAKE_SHOWN: "",
    FAKE_UNTOUCHED: "0",
    ...vars,
  };
  const snippet = [
    "set -euo pipefail",
    `SCRIPT_DIR=/stub; STATE_FILE="${join(dir, "state.json")}"; LOG_FILE="${join(dir, "log")}"; CALLS="${calls}"`,
    ...Object.entries(v).map(([k, val]) => `${k}='${val}'`),
    'log() { printf "%s\\n" "$*" >>"$LOG_FILE"; }',
    'rec() { printf "%s\\n" "$*" >>"$CALLS"; }',
    'node() { shift; rec "node $*"; case "$*" in *factory:get-issue*) printf \'{"intestCommentSha":"%s"}\' "$FAKE_SHOWN" ;; esac; }',
    'gh() { rec "gh $1 $2"; }',
    'git() { case "$*" in *"rev-parse HEAD"*) printf "%s\\n" "$FAKE_LOCAL_HEAD" ;; *merge-base*) rec "merge-base"; return "$FAKE_ANCESTOR" ;; *) return 1 ;; esac; }',
    'transition_status() { rec "transition $3"; }',
    'check_session_limit() { rec "check-limit $3"; return "$FAKE_LIMIT"; }',
    'pause_for_session_limit() { rec "pause"; }',
    'implement_mark_resumable() { rec "mark-resumable $3 $5 $6 $7 $8"; }',
    'implement_resume_never_started() { rec "never-started? $1"; return "$FAKE_NEVER_STARTED"; }',
    'find_prior_pr() { printf "%s" "$FAKE_PR"; }',
    'pr_head_oid() { rec "pr-head $1"; printf "%s" "$FAKE_POST_HEAD"; }',
    'implement_head_landed() { rec "landed? $3"; return "$FAKE_LANDED"; }',
    'implement_parity_gate() { rec "parity $4 $5"; return "$FAKE_PARITY"; }',
    'implement_migration_claim_check() { rec "claim pr=$2 head=$3 since=$4"; }',
    'revise_replies_check() { rec "replies $2 $4"; }',
    'revision_noop_route() { rec "noop-route head=$4 pr=$6 mark=$8"; }',
    'revision_return_to_test() { rec "return-to-test head=$3 pr=$5 mark=$7 $8"; }',
    'implement_park_blocked() { rec "blocked slot=$3: $4"; }',
    'worktree_untouched() { return "$FAKE_UNTOUCHED"; }',
    HANDLER,
    // Each card gets its own claude output file, as each loop pass does.
    "for CARD in 1 2; do",
    '  printf "%s" "$CLAUDE_OUT_TEXT" >"$CLAUDE_OUTPUT_FILE"',
    "  implement_handle_result",
    '  echo "after-$CARD"',
    "done",
    'echo "loop-done"',
  ].join("\n");
  const r = spawnSync("bash", ["-c", snippet], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_OUT_TEXT: output },
  });
  return {
    ...r,
    calls: read(calls),
    log: read(join(dir, "log")),
    outFileLeft: existsSync(outFile),
  };
}

// Each card goes through the handler and on to the next: no early exit.
function assertContinues(r) {
  assert.equal(r.status, 0, r.stderr + r.log);
  assert.match(r.stdout, /after-1\nafter-2\nloop-done/);
}
const count = (s, re) => (s.match(new RegExp(re, "gm")) || []).length;

describe("implement_handle_result: exit code branches", () => {
  it("124, fresh run: logs the output, deletes it, marks the session resumable, spends the attempt", () => {
    const r = runHandler({ EXIT_CODE: "124", CHAIN_PRE_HEAD_OID: "c0" }, { output: "partial\n" });
    assertContinues(r);
    assert.match(r.log, /claude timed out \(>2700s\) for #7; keeping slot for retry\npartial/);
    assert.equal(r.outFileLeft, false);
    assert.equal(
      count(r.calls, "^mark-resumable 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d c0 1 timed out f+$"),
      2,
    );
    assert.equal(count(r.calls, "factory:bump-attempts 7"), 2);
    assert.doesNotMatch(r.calls, /transition|check-limit/);
  });

  it("124, resumed run: not marked again (one resume per chain), attempt spent", () => {
    const r = runHandler({ EXIT_CODE: "124", IMPL_RESUMED: "1" });
    assertContinues(r);
    assert.doesNotMatch(r.calls, /mark-resumable/);
    assert.match(r.calls, /factory:bump-attempts 7/);
  });

  it("non-zero at the session limit: marks resumable, pauses, and ends the tick with exit 0", () => {
    const r = runHandler(
      { EXIT_CODE: "1", IMPL_RESUMED: "1", CHAIN_PRE_HEAD_OID: "c0", FAKE_LIMIT: "0" },
      { output: "limit text\n" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /after-1|loop-done/, "the tick ends at the first card");
    assert.match(r.calls, /^check-limit 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d$/m);
    assert.match(r.calls, /^mark-resumable \S+ c0 1 session limit f+\npause$/m);
    assert.doesNotMatch(r.calls, /bump-attempts/);
    assert.match(r.log, /limit text/);
    assert.match(r.log, /session limit — keeping slot 1 \+ worktree/);
    assert.match(r.log, /=== factory-agent --implement completed in \d+s ===/);
    assert.equal(r.outFileLeft, false);
  });

  it("other non-zero exit on a fresh run: attempt spent, no resume record", () => {
    const r = runHandler({ EXIT_CODE: "3" });
    assertContinues(r);
    assert.match(r.log, /claude exited non-zero \(3\) for #7 --implement/);
    assert.equal(count(r.calls, "factory:bump-attempts 7"), 2);
    assert.doesNotMatch(r.calls, /mark-resumable|never-started|pause/);
    assert.equal(r.outFileLeft, false);
  });

  it("non-zero exit of a resume that never started: no attempt spent", () => {
    const r = runHandler({ EXIT_CODE: "1", IMPL_RESUMED: "1", FAKE_NEVER_STARTED: "0" });
    assertContinues(r);
    assert.match(r.log, /resumed session \S+ never started \(exit 1\); no attempt spent/);
    assert.doesNotMatch(r.calls, /bump-attempts/);
  });

  it("non-zero exit of a resume that did start: attempt spent", () => {
    const r = runHandler({ EXIT_CODE: "1", IMPL_RESUMED: "1", FAKE_NEVER_STARTED: "1" });
    assertContinues(r);
    assert.match(r.calls, /never-started\?/);
    assert.match(r.calls, /factory:bump-attempts 7/);
  });
});

describe("implement_handle_result: summary line", () => {
  it("no summary line: logs the output, spends the attempt", () => {
    const r = runHandler({}, { output: "just chatter\n" });
    assertContinues(r);
    assert.match(r.log, /just chatter\nWARNING: no well-formed summary line from claude for #7/);
    assert.equal(count(r.calls, "factory:bump-attempts 7"), 2);
    assert.doesNotMatch(r.calls, /never-started/, "only a resumed run asks");
    assert.equal(r.outFileLeft, false);
  });

  it("no summary line from a resume that never started: no attempt spent", () => {
    const r = runHandler({ IMPL_RESUMED: "1", FAKE_NEVER_STARTED: "0" }, { output: "" });
    assertContinues(r);
    assert.match(r.log, /never started \(no summary line\); no attempt spent/);
    assert.doesNotMatch(r.calls, /bump-attempts/);
  });

  it("an unknown action: warns and spends the attempt", () => {
    const r = runHandler({}, { output: "issue=7 action=shrugged pr=none\n" });
    assertContinues(r);
    assert.match(r.log, /Claude summary: issue=7 action=shrugged pr=none/);
    assert.match(r.log, /unrecognised action 'shrugged' from claude for #7/);
    assert.equal(count(r.calls, "factory:bump-attempts 7"), 2);
    assert.doesNotMatch(r.calls, /transition/);
  });
});

const IMPLEMENTED =
  "issue=7 action=implemented pr=https://github.com/JakubAnderwald/drafto/pull/9\n";
const NOOP = "issue=7 action=noop pr=https://github.com/JakubAnderwald/drafto/pull/9\n";

describe("implement_handle_result: action=implemented", () => {
  it("fresh PR, everything landed: In Review, attempts reset, feedback marked now", () => {
    const r = runHandler({ FAKE_POST_HEAD: "h1" }, { output: IMPLEMENTED });
    assertContinues(r);
    const order = [
      "landed? h1",
      "parity 9 web",
      "claim pr=9 head= since=all",
      "transition In Review",
    ];
    let at = -1;
    for (const step of order) {
      const i = r.calls.indexOf(step, at + 1);
      assert.ok(i > at, `${step} out of order in:\n${r.calls}`);
      at = i;
    }
    assert.match(r.calls, /factory:set-issue-field 7 lastImplementAt/);
    assert.match(r.calls, /factory:set-issue-field 7 lastFeedbackAt \d{4}-/);
    assert.match(r.calls, /factory:reset-attempts 7/);
    assert.match(r.calls, /factory:set-issue-field 7 branchUpdates/);
    assert.doesNotMatch(r.calls, /bump-attempts|replies/);
    assert.match(
      r.log,
      /advanced to In Review \(PR https:\/\/github\.com\/JakubAnderwald\/drafto\/pull\/9; slot 1 retained/,
    );
  });

  it("revision: consumes only the feedback it was given, and replies", () => {
    const r = runHandler(
      {
        IS_REVISION: "1",
        FEEDBACK_CONSUMED_AT: "2026-11-16T09:00:00Z",
        PRE_HEAD_OID: "h0",
        CHAIN_PRE_HEAD_OID: "h0",
        PRIOR_PR: '{"number":9,"state":"OPEN"}',
        FAKE_POST_HEAD: "h1",
      },
      { output: IMPLEMENTED },
    );
    assertContinues(r);
    assert.match(r.calls, /^claim pr=9 head=h1 since=h0$/m);
    assert.match(r.calls, /lastFeedbackAt 2026-11-16T09:00:00Z/);
    assert.match(r.calls, /^replies 9 implemented$/m);
    assert.match(r.log, /revision pushed → In Review/);
  });

  it("head unchanged since the chain's baseline: comments once, attempt spent, not advanced", () => {
    const r = runHandler(
      { PRE_HEAD_OID: "h0", CHAIN_PRE_HEAD_OID: "h0", FAKE_POST_HEAD: "h0" },
      { output: IMPLEMENTED },
    );
    assertContinues(r);
    assert.match(r.log, /claimed action=implemented but PR #9 head is unchanged \(h0\)/);
    assert.match(r.calls, /^gh issue comment$/m);
    assert.match(r.calls, /factory:bump-attempts 7/);
    assert.doesNotMatch(r.calls, /transition|lastFeedbackAt|parity|landed/);
  });

  it("head unchanged with the marker comment already there: no second comment", () => {
    const r = runHandler(
      {
        PRE_HEAD_OID: "h0",
        CHAIN_PRE_HEAD_OID: "h0",
        FAKE_POST_HEAD: "h0",
        COMMENTS_JSON: '[{"body":"<!-- drafto-factory-head-unchanged -->"}]',
      },
      { output: IMPLEMENTED },
    );
    assertContinues(r);
    assert.doesNotMatch(r.calls, /gh issue comment/);
  });

  it("no PR on the head branch: attempt spent", () => {
    const r = runHandler({ FAKE_PR: "null" }, { output: IMPLEMENTED });
    assertContinues(r);
    assert.match(r.log, /action=implemented but no PR on head factory\/issue-7/);
    assert.match(r.calls, /factory:bump-attempts 7/);
    assert.doesNotMatch(r.calls, /transition/);
  });

  it("the head before the run is unknown: not advanced, attempt spent", () => {
    const r = runHandler({ PRE_HEAD_KNOWN: "0" }, { output: IMPLEMENTED });
    assertContinues(r);
    assert.match(r.log, /action=implemented cannot be verified/);
    assert.match(r.calls, /factory:bump-attempts 7/);
    assert.doesNotMatch(r.calls, /transition|pr-head/);
  });

  it("the PR head can't be read after the run: not advanced, attempt spent", () => {
    const r = runHandler(
      { PRE_HEAD_OID: "h0", CHAIN_PRE_HEAD_OID: "h0", FAKE_POST_HEAD: "" },
      { output: IMPLEMENTED },
    );
    assertContinues(r);
    assert.match(r.log, /could not read PR #9 head OID/);
    assert.match(r.calls, /factory:bump-attempts 7/);
    assert.doesNotMatch(r.calls, /transition/);
  });

  it("worktree commits not on the PR: not advanced, attempt spent", () => {
    const r = runHandler({ FAKE_POST_HEAD: "h1", FAKE_LANDED: "1" }, { output: IMPLEMENTED });
    assertContinues(r);
    assert.match(r.log, /the worktree's commits aren't all on PR #9/);
    assert.match(r.calls, /factory:bump-attempts 7/);
    assert.doesNotMatch(r.calls, /transition|parity/);
  });

  it("parity violation: the gate parks it; the handler goes on to the next card", () => {
    const r = runHandler({ FAKE_POST_HEAD: "h1", FAKE_PARITY: "1" }, { output: IMPLEMENTED });
    assertContinues(r);
    assert.match(r.calls, /parity 9 web/);
    assert.doesNotMatch(r.calls, /transition|bump-attempts|claim/);
  });
});

describe("implement_handle_result: action=noop", () => {
  it("fresh, PR already open: migration check over all of it, then In Review", () => {
    const r = runHandler({}, { output: NOOP });
    assertContinues(r);
    assert.match(r.calls, /^claim pr=9 head= since=all\ntransition In Review$/m);
    assert.match(r.calls, /factory:reset-attempts 7/);
    assert.match(
      r.log,
      /noop \(PR https:\/\/github\.com\/JakubAnderwald\/drafto\/pull\/9 already open\); advanced to In Review/,
    );
  });

  it("fresh, no PR found: attempt spent", () => {
    const r = runHandler({ FAKE_PR: "null" }, { output: NOOP });
    assertContinues(r);
    assert.match(r.log, /action=noop but no PR found/);
    assert.match(r.calls, /factory:bump-attempts 7/);
    assert.doesNotMatch(r.calls, /transition/);
  });

  const revision = {
    IS_REVISION: "1",
    FEEDBACK_CONSUMED_AT: "2026-11-16T09:00:00Z",
    PRE_HEAD_OID: "h0",
    PRIOR_PR: '{"number":9,"state":"OPEN"}',
  };

  it("revision, worktree on the PR head: revision_noop_route with the run's head and mark", () => {
    const r = runHandler({ ...revision, FAKE_LOCAL_HEAD: "h0" }, { output: NOOP });
    assertContinues(r);
    assert.match(r.calls, /^noop-route head=h0 pr=9 mark=2026-11-16T09:00:00Z$/m);
    assert.doesNotMatch(r.calls, /bump-attempts|transition/);
  });

  it("revision, worktree ahead of the PR head: work not landed, attempt spent", () => {
    const r = runHandler(
      { ...revision, FAKE_LOCAL_HEAD: "h9", FAKE_ANCESTOR: "1" },
      { output: NOOP },
    );
    assertContinues(r);
    assert.match(
      r.log,
      /returned action=noop but the worktree HEAD \(h9\) differs from the PR head \(h0\)/,
    );
    assert.match(r.calls, /factory:bump-attempts 7/);
    assert.doesNotMatch(r.calls, /noop-route/);
  });

  it("revision, worktree merely behind the PR head: still a genuine noop", () => {
    const r = runHandler(
      { ...revision, FAKE_LOCAL_HEAD: "h-old", FAKE_ANCESTOR: "0" },
      { output: NOOP },
    );
    assertContinues(r);
    assert.match(r.calls, /merge-base\nnoop-route head=h0/);
    assert.doesNotMatch(r.calls, /bump-attempts/);
  });

  it("revision, head before the run unknown: attempt spent", () => {
    const r = runHandler({ ...revision, PRE_HEAD_KNOWN: "0" }, { output: NOOP });
    assertContinues(r);
    assert.match(r.log, /action=noop cannot be verified/);
    assert.match(r.calls, /factory:bump-attempts 7/);
  });
});

describe("implement_handle_result: blocked, incomplete, declined", () => {
  it("blocked: parked with its slot", () => {
    const r = runHandler({}, { output: "issue=7 action=blocked pr=none\n" });
    assertContinues(r);
    assert.match(r.calls, /^blocked slot=1: implementer returned blocked$/m);
    assert.doesNotMatch(r.calls, /bump-attempts|transition/);
  });

  it("incomplete, fresh run: resumable, attempt spent, card stays", () => {
    const r = runHandler(
      { CHAIN_PRE_HEAD_OID: "c0" },
      { output: "issue=7 action=incomplete pr=none\n" },
    );
    assertContinues(r);
    assert.match(r.calls, /^mark-resumable \S+ c0 1 action=incomplete f+$/m);
    assert.match(r.calls, /factory:bump-attempts 7/);
    assert.doesNotMatch(r.calls, /transition|slot-release/);
  });

  it("incomplete, resumed run: not marked again", () => {
    const r = runHandler({ IMPL_RESUMED: "1" }, { output: "issue=7 action=incomplete pr=none\n" });
    assertContinues(r);
    assert.doesNotMatch(r.calls, /mark-resumable/);
    assert.match(r.calls, /factory:bump-attempts 7/);
  });

  const declinedRun = {
    IS_REVISION: "1",
    FEEDBACK_CONSUMED_AT: "2026-11-16T09:00:00Z",
    PRE_HEAD_OID: "h0",
    PRIOR_PR: '{"number":9,"state":"OPEN"}',
    FAKE_SHOWN: "h0",
    FAKE_POST_HEAD: "h0",
    FAKE_UNTOUCHED: "0",
  };
  const DECLINED = "issue=7 action=declined pr=https://github.com/JakubAnderwald/drafto/pull/9\n";

  it("declined on the head shown at In Test, untouched: back to In Test", () => {
    const r = runHandler(declinedRun, { output: DECLINED });
    assertContinues(r);
    assert.match(r.calls, /^return-to-test head=h0 pr=9 mark=2026-11-16T09:00:00Z declined$/m);
    assert.doesNotMatch(r.calls, /blocked/);
  });

  for (const [why, vars] of [
    ["the PR moved meanwhile", { FAKE_POST_HEAD: "h1" }],
    ["a different head was shown", { FAKE_SHOWN: "hx" }],
    ["the worktree changed", { FAKE_UNTOUCHED: "1" }],
    ["not a revision", { IS_REVISION: "0" }],
  ]) {
    it(`declined, but ${why}: parked in Blocked`, () => {
      const r = runHandler({ ...declinedRun, ...vars }, { output: DECLINED });
      assertContinues(r);
      assert.match(r.calls, /^blocked slot=1: implementer declined, but/m);
      assert.doesNotMatch(r.calls, /return-to-test/);
    });
  }
});

// ── slot_acquire (#466) ─────────────────────────────────────────────────────

// Runs under /bin/bash (the Mac mini's 3.2), from a file named
// factory-agent.sh as the real one is. `claimFirst` records the slot for #7
// under this very process before slot_acquire runs.
function runSlotAcquire(state, args, { nodeStub = "", claimFirst = false } = {}) {
  const dir = tempDir();
  const stateFile = join(dir, "state.json");
  const logFile = join(dir, "log");
  if (state) writeFileSync(stateFile, JSON.stringify(state));
  const snippet = [
    "set -euo pipefail",
    `SCRIPT_DIR="${SCRIPTS}"; STATE_FILE="${stateFile}"; LOG_FILE="${logFile}"`,
    'log() { printf "%s\\n" "$*" >>"$LOG_FILE"; }',
    nodeStub,
    SLOT_ACQUIRE,
    claimFirst
      ? 'node "$SCRIPT_DIR/lib/state-cli.mjs" factory:slot-acquire 0 7 "$$" --state-file "$STATE_FILE" >/dev/null'
      : "",
    `if slot_acquire ${args.map((a) => `'${a}'`).join(" ")}; then echo ACQUIRED; else echo DEFERRED; fi`,
  ].join("\n");
  const agent = join(dir, "factory-agent.sh");
  writeFileSync(agent, snippet);
  const r = spawnSync("/bin/bash", [agent], { encoding: "utf8" });
  return {
    ...r,
    log: read(logFile),
    state: existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null,
  };
}

const DEAD_PID = 1_999_999;
const slotState = (slot) => ({ slots: { 0: slot } });

describe("slot_acquire", () => {
  it("acquires a free slot", () => {
    const r = runSlotAcquire(null, ["0", "7", String(process.pid)]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ACQUIRED$/m);
    assert.equal(r.state.slots["0"].issueNumber, "7");
    assert.equal(r.state.slots["0"].pid, process.pid);
  });

  it("acquires a slot whose recorded pid is dead (the CLI steals it)", () => {
    const r = runSlotAcquire(slotState({ pid: DEAD_PID, issueNumber: "42", acquiredAt: "x" }), [
      "0",
      "7",
      "123",
    ]);
    assert.match(r.stdout, /^ACQUIRED$/m);
    assert.equal(r.state.slots["0"].issueNumber, "7");
  });

  it("defers when another issue holds the slot under a live pid, leaving it untouched", () => {
    const held = { pid: process.pid, issueNumber: "42", acquiredAt: "x" };
    const r = runSlotAcquire(slotState(held), ["0", "7", "123"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^DEFERRED$/m);
    assert.match(r.log, /slot 0 is held by #42 \(pid \d+\); deferring/);
    assert.deepEqual(r.state.slots["0"], held);
  });

  it("takes back its own slot from a live pid that isn't working on it", () => {
    // The test runner is alive, and is neither a detached implement run nor
    // factory-agent.sh: a pid reused since the slot was recorded.
    const r = runSlotAcquire(slotState({ pid: process.pid, issueNumber: "7", acquiredAt: "x" }), [
      "0",
      "7",
      "123",
    ]);
    assert.match(r.stdout, /^ACQUIRED$/m);
    assert.match(r.log, /which isn't working on it; taking it over/);
    assert.equal(r.state.slots["0"].pid, 123);
    assert.equal(r.state.slots["0"].issueNumber, "7");
  });

  it("takes back its own slot recorded under this very process", () => {
    const r = runSlotAcquire(null, ["0", "7", "123"], { claimFirst: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ACQUIRED$/m);
    assert.match(r.log, /taking it over/);
    assert.equal(r.state.slots["0"].pid, 123);
  });

  it("defers when another factory-agent.sh process holds its own slot", async () => {
    // A mode run by hand alongside the loop's, working on the same card.
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "factory-agent.sh", "--watch"],
      { stdio: "ignore" },
    );
    try {
      await new Promise((ok) => setTimeout(ok, 200));
      const held = { pid: child.pid, issueNumber: "7", acquiredAt: "x" };
      const r = runSlotAcquire(slotState(held), ["0", "7", "123"]);
      assert.match(r.stdout, /^DEFERRED$/m);
      assert.match(r.log, /held by another running factory-agent\.sh for this issue \(pid \d+\)/);
      assert.deepEqual(r.state.slots["0"], held);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("takes back its own slot recorded without a pid", () => {
    const r = runSlotAcquire(slotState({ pid: null, issueNumber: "7", acquiredAt: "x" }), [
      "0",
      "7",
      "123",
    ]);
    assert.match(r.stdout, /^ACQUIRED$/m);
    assert.equal(r.state.slots["0"].pid, 123);
  });

  it("defers when its own slot is held by a live detached implement run", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "implement-lane.mjs", "_supervise"],
      { stdio: "ignore" },
    );
    try {
      await new Promise((ok) => setTimeout(ok, 200));
      const held = { pid: child.pid, issueNumber: "7", acquiredAt: "x" };
      const r = runSlotAcquire(slotState(held), ["0", "7", "123"]);
      assert.match(r.stdout, /^DEFERRED$/m);
      assert.match(r.log, /held by its own running implement \(pid \d+\); deferring/);
      assert.deepEqual(r.state.slots["0"], held);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("defers when the CLI fails", () => {
    const r = runSlotAcquire(null, ["0", "7", "123"], {
      nodeStub: "node() { return 1; }",
    });
    assert.match(r.stdout, /^DEFERRED$/m);
    assert.match(r.log, /slot-acquire 0 for #7 failed; deferring/);
  });

  it("defers on an answer it can't read", () => {
    const r = runSlotAcquire(null, ["0", "7", "123"], {
      nodeStub: "node() { echo 'not json'; }",
    });
    assert.match(r.stdout, /^DEFERRED$/m);
    assert.match(r.log, /refused \(unreadable answer\); deferring/);
  });

  it("defers when the --force retry is refused too", () => {
    const r = runSlotAcquire(null, ["0", "7", "123"], {
      nodeStub:
        'node() { echo \'{"ok":false,"reason":"slot-occupied","occupiedBy":{"issueNumber":"7","pid":null}}\'; }',
    });
    assert.match(r.stdout, /^DEFERRED$/m);
    assert.match(r.log, /slot-acquire --force 0 for #7 was refused; deferring/);
  });

  it("is the only way --implement and --watch claim a slot, and a refusal skips the card", () => {
    const callLines = script
      .split("\n")
      .filter((l) => l.includes("factory:slot-acquire") && !/^\s*#/.test(l));
    assert.equal(callLines.length, 2, callLines.join("\n"));
    for (const l of callLines) assert.ok(SLOT_ACQUIRE.includes(l), `outside slot_acquire: ${l}`);
    // parse-flags.mjs gives every flag a value: a bare --force would swallow
    // --state-file and write the default state file instead.
    assert.match(SLOT_ACQUIRE, /--force true \\\n\s*--state-file "\$STATE_FILE"/);
    assert.doesNotMatch(script, /factory:slot-acquire[^\n]*\n[^\n]*\|\| true/);
    const calls = script.match(
      /\n\s*if ! slot_acquire "\$SLOT" "\$ISSUE_NUM" "\$\$"; then\n\s*continue\n/g,
    );
    assert.equal(calls?.length, 2);
    const implementAt = script.indexOf(
      'if ! slot_acquire "$SLOT"',
      script.indexOf("# ── --implement mode"),
    );
    const watchAt = script.indexOf(
      'if ! slot_acquire "$SLOT"',
      script.indexOf("# ── --watch mode"),
    );
    assert.ok(implementAt < script.indexOf("# ── --watch mode"));
    assert.ok(watchAt > script.indexOf("# ── --watch mode"));
  });
});
