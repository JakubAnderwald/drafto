// factory-agent.sh's side of detached --implement runs (ADR-0085).
//
//   - The knobs, and their fallbacks.
//   - FACTORY_IMPLEMENT_DETACHED=0 runs the synchronous call and the handler,
//     exactly as before; 1 only starts the run (the loop tail, run for real).
//   - In the loop, a card a run holds is skipped before the retry budget, disk
//     and plan checks; the capacity precheck comes after the budget check.
//   - Collection runs at the top of --implement, before the board query,
//     whatever the knob, and a status failure skips the tick.
//   - The collector (run for real against a fake implement-lane.mjs): finish
//     before the handler, the handler's globals restored, SESSION_LIMIT_NOW
//     set for the handler only, interrupted runs, overdue runs, refusals.
//   - The start: the spec it hands implement-lane.mjs, and a failed start
//     spending no attempt.
//   - The guards: the --watch sweep stops a run before it frees the slot, the
//     teardown helpers keep a live run's worktree, --watch and --release skip
//     a held card.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(resolve(HERE, "..", "factory-agent.sh"), "utf8");
const SID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function fnText(name) {
  const a = script.indexOf(`\n${name}() {\n`);
  assert.ok(a !== -1, `${name} not found`);
  const b = script.indexOf("\n}\n", a);
  return script.slice(a + 1, b + 3);
}
const between = (from, to, start = 0) => {
  const a = script.indexOf(from, start);
  assert.ok(a !== -1, `not found: ${from}`);
  const b = script.indexOf(to, a);
  assert.ok(b !== -1, `not found: ${to}`);
  return script.slice(a, b);
};
const read = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

const dirs = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), "fa-impl-detached-"));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const IMPLEMENT = between("# ── --implement mode", "# ── --watch mode");
const LOOP = IMPLEMENT.slice(IMPLEMENT.indexOf('if [[ "$MODE_IMPLEMENT" -eq 1 ]]; then'));

describe("knobs", () => {
  const knobBlock = between(
    "# Detached --implement runs (ADR-0085).",
    "# ── Claude background-task wait",
  );
  const run = (env) =>
    spawnSync(
      "bash",
      [
        "-c",
        `${knobBlock}\necho "$FACTORY_IMPLEMENT_DETACHED $FACTORY_IMPLEMENT_MAX_RUNNING $FACTORY_IMPLEMENT_KILL_GRACE_SEC"`,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, ...env } },
    );

  it("default to off, one run, 300 s", () => {
    assert.equal(run({}).stdout, "0 1 300\n");
  });

  it("take valid values", () => {
    const r = run({
      FACTORY_IMPLEMENT_DETACHED: "1",
      FACTORY_IMPLEMENT_MAX_RUNNING: "2",
      FACTORY_IMPLEMENT_KILL_GRACE_SEC: "60",
    });
    assert.equal(r.stdout, "1 2 60\n");
  });

  it("fall back, with a warning, on anything else", () => {
    const r = run({
      FACTORY_IMPLEMENT_DETACHED: "yes",
      FACTORY_IMPLEMENT_MAX_RUNNING: "3",
      FACTORY_IMPLEMENT_KILL_GRACE_SEC: "0",
    });
    assert.equal(r.stdout, "0 1 300\n");
    assert.match(r.stderr, /invalid FACTORY_IMPLEMENT_DETACHED='yes'; defaulting to 0/);
    assert.match(r.stderr, /invalid FACTORY_IMPLEMENT_MAX_RUNNING='3'; defaulting to 1/);
    assert.match(r.stderr, /invalid FACTORY_IMPLEMENT_KILL_GRACE_SEC='0'; defaulting to 300/);
  });
});

describe("the loop tail: knob 0 runs the synchronous call, knob 1 only starts", () => {
  const tail = between("    # Invoke claude inside the worktree", "  done\n");
  function runTail(knob) {
    const dir = tempDir();
    const calls = join(dir, "calls");
    const snippet = [
      "set -euo pipefail",
      `CALLS="${calls}"; LOG_FILE="${join(dir, "log")}"; SCRIPT_DIR=/stub; WT_PATH="${dir}"`,
      `FACTORY_IMPLEMENT_DETACHED=${knob}`,
      "ISSUE_NUM=7; SLOT=1; IMPL_RESUMED=0; WT_JSON='{}'; PROMPT_TEXT='prompt'; BUNDLE='{}'",
      `RESUME_PROMPT_TEXT=''; IMPL_SESSION_FLAG=--session-id; IMPL_SESSION_ID=${SID}`,
      "IMPLEMENT_TIMEOUT_SEC=2700; FACTORY_EFFORT=ultracode; FACTORY_IMPLEMENT_TERM_GRACE_SEC=30",
      'rec() { printf "%s\\n" "$*" >>"$CALLS"; }',
      'log() { printf "%s\\n" "$*" >>"$LOG_FILE"; }',
      "implement_runtime_facts() { echo '{\"capMinutes\":45}'; }",
      'reset_reply_dir() { rec "reset-replies $1"; }',
      'implement_lane_start() { rec "detached-start $ISSUE_NUM"; }',
      'implement_handle_result() { rec "handler exit=$EXIT_CODE out=$(cat "$CLAUDE_OUTPUT_FILE")"; rm -f "$CLAUDE_OUTPUT_FILE"; }',
      'node() { shift 3; rec "run-claude $*"; echo "summary"; }',
      "for CARD in 1 2; do",
      tail,
      "done",
      'echo "loop-done"',
    ].join("\n");
    const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /loop-done/);
    return { calls: read(calls), log: read(join(dir, "log")) };
  }

  it("0: the synchronous call and the handler, twice; no detached start", () => {
    const { calls, log } = runTail(0);
    const lines = calls.trim().split("\n");
    assert.deepEqual(
      lines.filter((l) => /^(run-claude|handler|detached)/.test(l)),
      [
        `run-claude --dangerously-skip-permissions --effort ultracode --no-chrome --strict-mcp-config --session-id ${SID}`,
        "handler exit=0 out=summary",
        `run-claude --dangerously-skip-permissions --effort ultracode --no-chrome --strict-mcp-config --session-id ${SID}`,
        "handler exit=0 out=summary",
      ],
    );
    assert.match(
      log,
      /Invoking claude for #7 \(--implement, slot 1, cap 2700s, effort=ultracode\)/,
    );
  });

  it("1: the detached start only, after the reply dir is reset; no claude, no handler", () => {
    const { calls, log } = runTail(1);
    assert.deepEqual(calls.trim().split("\n"), [
      "reset-replies 7",
      "detached-start 7",
      "reset-replies 7",
      "detached-start 7",
    ]);
    assert.doesNotMatch(log, /Invoking claude/);
  });
});

describe("the --implement loop: ordering", () => {
  const idx = (s) => {
    const i = LOOP.indexOf(s);
    assert.ok(i !== -1, `not found in the loop: ${s}`);
    return i;
  };

  it("skips a held card before the retry budget, disk and plan checks, whatever the knob", () => {
    const order = [
      'if implement_lane_holds "$ISSUE_NUM"; then',
      '"$IMPLEMENT_COLLECTED_ISSUES" == *" $ISSUE_NUM "*',
      'log "Issue #$ISSUE_NUM: implementing (phase=$PHASE)"',
      "ATTEMPTS=$(node",
      "implement_lane_precheck",
      "fetch_issue_record",
      "FREE_GB=$(free_disk_gb)",
      "extract_plan_comment",
      "slot_for_issue",
      'slot_acquire "$SLOT" "$ISSUE_NUM" "$$"',
      "implement_resume_decide",
      "implement_lane_start",
      'log "Invoking claude for #$ISSUE_NUM (--implement',
    ];
    for (let i = 1; i < order.length; i++) {
      assert.ok(idx(order[i - 1]) < idx(order[i]), `${order[i - 1]} must come before ${order[i]}`);
    }
    const skip = LOOP.slice(
      idx("# A card a detached implement run still holds"),
      idx("ATTEMPTS=$(node"),
    );
    assert.doesNotMatch(skip, /"\$FACTORY_IMPLEMENT_DETACHED"/, "the skip is not behind the knob");
  });

  it("checks capacity only with the knob on, and a refusal defers the card", () => {
    assert.match(
      LOOP,
      /if \[\[ "\$FACTORY_IMPLEMENT_DETACHED" == "1" && "\$DRY_RUN" -eq 0 \]\] \\\n\s*&& ! implement_lane_precheck "\$ISSUE_NUM"; then\n\s*continue\n\s*fi/,
    );
  });

  it("starts with `implement_lane_start; continue` right before the synchronous call", () => {
    assert.match(
      LOOP,
      /if \[\[ "\$FACTORY_IMPLEMENT_DETACHED" == "1" \]\]; then\n\s*implement_lane_start \|\| true\n\s*continue\n\s*fi\n\s*log "Invoking claude for #\$ISSUE_NUM \(--implement/,
    );
    // Its log line never starts like the synchronous one, which tests pin.
    assert.doesNotMatch(fnText("implement_lane_start"), /Invoking claude for/);
  });

  it("collects before the board query, whatever the knob, and a status failure ends the tick", () => {
    const top = LOOP.slice(0, LOOP.indexOf('--status "In Progress"'));
    assert.match(top, /implement_lane_collect \|\| true/);
    assert.doesNotMatch(top, /"\$FACTORY_IMPLEMENT_DETACHED"/, "not behind the knob");
    assert.match(
      top,
      /if \[\[ "\$IMPLEMENT_LIVE_KNOWN" -ne 1 \]\]; then\n\s*log "WARNING: couldn't read the detached implement runs[^\n]*skipping this --implement tick"\n[^\n]*completed in[^\n]*\n\s*exit 0\n\s*fi/,
    );
  });
});

// ── the collector, for real, against a fake implement-lane.mjs ──────────────

const FAKE_LANE = `
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, "lane " + args.filter((a) => !a.startsWith("/")).join(" ") + "\\n");
const sub = args[0];
const i = args.indexOf("--issue");
const pick = (name, dflt) => (process.env[name] != null ? process.env[name] : dflt);
if (sub === "status") {
  if (pick("FAKE_STATUS_RC", "0") !== "0") process.exit(1);
  process.stdout.write(i === -1 ? pick("FAKE_STATUS", '{"ok":true,"runs":[],"issues":[],"live":[]}') : pick("FAKE_STATUS_ISSUE", ""));
} else if (sub === "finish") {
  process.stdout.write(pick("FAKE_FINISH", '{"ok":true}'));
} else if (sub === "kill") {
  process.stdout.write(pick("FAKE_KILL", '{"ok":true,"state":"gone"}'));
} else {
  process.stdout.write('{"ok":true}');
}
`;
const FAKE_STATE_CLI = `
require("fs").appendFileSync(process.env.CALLS, "state-cli " + process.argv.slice(2).filter((a) => !a.startsWith("/")).join(" ") + "\\n");
`;

function collectEnv() {
  const dir = tempDir();
  mkdirSync(join(dir, "lib"));
  // CommonJS fakes; the harness's node() routes each script name to its fake.
  writeFileSync(join(dir, "lib", "implement-lane.cjs"), FAKE_LANE);
  writeFileSync(join(dir, "lib", "state-cli.cjs"), FAKE_STATE_CLI);
  const runDir = join(dir, "run");
  mkdirSync(runDir);
  return { dir, runDir, calls: join(dir, "calls"), log: join(dir, "log") };
}

const COLLECT_FNS = [
  "implement_lane_finish",
  "implement_lane_ctx_get",
  "implement_lane_restore",
  "implement_lane_collect",
  "implement_lane_collect_one",
].map(fnText);

function runCollect(env, { ctx = {}, stdout = "", stderr = "", vars = {} } = {}) {
  writeFileSync(join(env.runDir, "meta.json"), JSON.stringify({ formatVersion: 1, ctx }));
  writeFileSync(join(env.runDir, "stdout.txt"), stdout);
  writeFileSync(join(env.runDir, "stderr.txt"), stderr);
  const snippet = [
    "set -euo pipefail",
    `SCRIPT_DIR="${env.dir}"; STATE_FILE=/state.json; LOG_FILE="${env.log}"; REPO_ROOT=/repo`,
    "IMPLEMENT_RUN_ROOT=/runs; SESSION_LIMIT_NOW=''; IMPL_END_EPOCH=''; IMPL_END_ISO=''",
    'rec() { printf "%s\\n" "$*" >>"$CALLS"; }',
    'log() { printf "%s\\n" "$*" >>"$LOG_FILE"; }',
    // node: the two fakes, by name; .cjs so `require` works in them.
    'node() { case "$1" in *implement-lane.mjs) shift; command node "$SCRIPT_DIR/lib/implement-lane.cjs" "$@" ;; *state-cli.mjs) shift; command node "$SCRIPT_DIR/lib/state-cli.cjs" "$@" ;; *) rec "node $*" ;; esac; }',
    'implement_lane_card_check() { rec "card $1"; echo "${FAKE_CARD:-ok}"; }',
    'fetch_issue_comments() { rec "comments $1"; [[ "${FAKE_COMMENTS_RC:-0}" == 0 ]] && echo \'[{"id":1}]\'; }',
    'implement_mark_resumable() { rec "mark-resumable $1 $3 $5 $6 $7"; }',
    'implement_handle_result() { rec "handler issue=$ISSUE_NUM item=$ITEM_ID slot=$SLOT wt=$WT_PATH exit=$EXIT_CODE pre=$PRE_HEAD_OID/$PRE_HEAD_KNOWN chain=$CHAIN_PRE_HEAD_OID/$CHAIN_PRE_HEAD_KNOWN resumed=$IMPL_RESUMED sid=$IMPL_SESSION_ID start=$CLAUDE_START_ISO/$IMPL_START_EPOCH now=$SESSION_LIMIT_NOW end=$IMPL_END_EPOCH/$IMPL_END_ISO rev=$IS_REVISION"; rec "handler-pr $PRIOR_PR"; rec "handler-bundle $BUNDLE"; rec "handler-markers $REPLY_MARKERS"; rec "handler-comments $COMMENTS_JSON"; rec "handler-out $(cat "$CLAUDE_OUTPUT_FILE")"; rm -f "$CLAUDE_OUTPUT_FILE"; }',
    ...COLLECT_FNS,
    "rc=0; implement_lane_collect || rc=$?",
    'echo "rc=$rc known=$IMPLEMENT_LIVE_KNOWN live=[$IMPLEMENT_LIVE_ISSUES] collected=[$IMPLEMENT_COLLECTED_ISSUES] now=[$SESSION_LIMIT_NOW] end=[$IMPL_END_EPOCH$IMPL_END_ISO]"',
  ].join("\n");
  const r = spawnSync("bash", ["-c", snippet], {
    encoding: "utf8",
    env: { ...process.env, CALLS: env.calls, ...vars },
  });
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout.trim(), calls: read(env.calls), log: read(env.log) };
}

const statusOf = (env, run) =>
  JSON.stringify({
    ok: true,
    runs: [
      { issue: "7", runId: "R1", slot: 1, worktree: "/wt", runDir: env.runDir, pid: 100, ...run },
    ],
  });

const FULL_CTX = {
  itemId: "item-7",
  itemLabels: "status:in-progress",
  slot: "1",
  wtPath: "/wt/7",
  claudeStartIso: "2026-11-17T10:00:00Z",
  implStartEpoch: "1763373600",
  implResumed: "0",
  implSessionId: SID,
  implTaskKey: "plan:1@x|rev:",
  implFeedbackDigest: "f".repeat(64),
  preHeadOid: "h0",
  preHeadKnown: "1",
  chainPreHeadOid: "h0",
  chainPreHeadKnown: "1",
  priorPr: '{"number":9,\n "state":"OPEN"}',
  bundleMigrations: '{"claimedComplete":true,"claimed":[]}',
  affected: "web",
  parityOverride: "",
  isRevision: "1",
  feedbackConsumedAt: "2026-11-17T09:00:00Z",
  replyMarkers: '[{"commentId":"1"}]',
};
const DONE = (exitCode = 0, extra = {}) => ({
  state: "done",
  alive: false,
  collect: {
    exitCode,
    interrupted: false,
    why: "claude exited",
    endedAt: "2026-11-17T10:40:00Z",
    endedEpoch: 1763376000,
    ...extra,
  },
});

describe("implement_lane_collect: a run that ended", () => {
  it("finishes it BEFORE the handler, which gets the run's globals, output and fresh comments", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      ctx: FULL_CTX,
      stdout: "issue=7 action=implemented pr=x\n",
      stderr: "claude said things\n",
      vars: { FAKE_STATUS: statusOf(env, DONE(0)) },
    });
    const lines = r.calls.trim().split("\n");
    const at = (re) => lines.findIndex((l) => re.test(l));
    assert.ok(at(/^lane housekeeping/) < at(/^lane status/));
    assert.ok(at(/^comments 7$/) < at(/^lane finish --issue 7 --run-id R1 --outcome collected/));
    assert.ok(at(/^lane finish/) < at(/^handler /), "finish comes before the handler");
    assert.match(
      r.calls,
      new RegExp(
        `^handler issue=7 item=item-7 slot=1 wt=/wt/7 exit=0 pre=h0/1 chain=h0/1 resumed=0 sid=${SID} ` +
          "start=2026-11-17T10:00:00Z/1763373600 now=2026-11-17T10:40:00Z end=1763376000/2026-11-17T10:40:00Z rev=1$",
        "m",
      ),
    );
    assert.match(
      r.calls,
      /^handler-pr \{"number":9,\n "state":"OPEN"\}$/m,
      "restored byte for byte",
    );
    assert.match(
      r.calls,
      /^handler-bundle \{"migrations":\{"claimedComplete":true,"claimed":\[\]\}\}$/m,
    );
    assert.match(r.calls, /^handler-markers \[\{"commentId":"1"\}\]$/m);
    assert.match(r.calls, /^handler-comments \[\{"id":1\}\]$/m, "the comments are fetched afresh");
    assert.match(r.calls, /^handler-out issue=7 action=implemented pr=x$/m);
    assert.match(r.calls, /^lane finish --issue 7 --run-id R1 --outcome collected --pid 100 /m);
    assert.match(r.log, /stderr follows\nclaude said things\n/);
    assert.equal(
      r.out,
      "rc=0 known=1 live=[ ] collected=[ 7 ] now=[] end=[]",
      "cleared after the handler",
    );
  });

  it("missing or malformed ctx values get the defaults that make the handler do least", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      ctx: { preHeadKnown: "yes", slot: "x" },
      vars: { FAKE_STATUS: statusOf(env, DONE(124)) },
    });
    assert.match(
      r.calls,
      /^handler issue=7 item= slot=1 wt=\/wt exit=124 pre=\/0 chain=\/0 resumed=0 /m,
    );
    assert.match(r.calls, /^handler-pr null$/m);
    assert.match(r.calls, /^handler-markers \[\]$/m);
    assert.match(r.calls, /^handler-bundle \{"migrations":null\}$/m);
  });

  it("an interrupted run: finished, recorded as resumable, no handler, no attempt", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      ctx: FULL_CTX,
      vars: {
        FAKE_STATUS: statusOf(env, {
          state: "lost",
          collect: { exitCode: null, interrupted: true, why: "no exit.json, before the deadline" },
        }),
      },
    });
    assert.match(r.calls, /^lane finish --issue 7 --run-id R1 --outcome collected/m);
    assert.match(r.calls, new RegExp(`^mark-resumable 7 ${SID} h0 1 interrupted$`, "m"));
    assert.doesNotMatch(r.calls, /handler|bump-attempts/);
    assert.match(r.log, /interrupted before its deadline \(no exit\.json, before the deadline\)/);
    assert.match(r.out, /collected=\[ 7 \]/);
  });

  it("an interrupted resume spends the attempt, so repeated interruptions reach Blocked", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      ctx: { ...FULL_CTX, implResumed: "1" },
      vars: {
        FAKE_STATUS: statusOf(env, {
          state: "done",
          collect: { exitCode: null, interrupted: true, why: "stopped from outside" },
        }),
      },
    });
    assert.match(r.calls, /^mark-resumable /m);
    assert.match(r.calls, /^state-cli factory:bump-attempts 7/m);
    assert.doesNotMatch(r.calls, /^handler/m);
  });

  it("comments that can't be fetched: left for the next tick, not finished", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      ctx: FULL_CTX,
      vars: { FAKE_STATUS: statusOf(env, DONE(0)), FAKE_COMMENTS_RC: "1" },
    });
    assert.doesNotMatch(r.calls, /lane finish|^handler/m);
    assert.match(r.out, /live=\[ 7 \] collected=\[ \]/);
  });

  it("a finish that's refused (someone else finished it): no handler", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      ctx: FULL_CTX,
      vars: {
        FAKE_STATUS: statusOf(env, DONE(0)),
        FAKE_FINISH: '{"ok":false,"reason":"run-id-mismatch"}',
      },
    });
    assert.match(r.calls, /^lane finish/m);
    assert.doesNotMatch(r.calls, /^handler/m);
    assert.match(r.out, /live=\[ 7 \] collected=\[ \]/);
  });
});

describe("implement_lane_collect: runs not (yet) ended, and failures", () => {
  it("a running run marks the card live, and nothing else", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      vars: { FAKE_STATUS: statusOf(env, { state: "running", alive: true }) },
    });
    assert.doesNotMatch(r.calls, /lane (kill|finish)|^handler/m);
    assert.match(r.out, /live=\[ 7 \] collected=\[ \]/);
  });

  it("an overdue run is stopped (no --finish), read again, then collected with its 124", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      ctx: FULL_CTX,
      vars: {
        FAKE_STATUS: statusOf(env, { state: "overdue", alive: true }),
        FAKE_STATUS_ISSUE: statusOf(env, {
          ...DONE(124),
          state: "lost",
          collect: { ...DONE(124).collect, why: "no exit.json, past the deadline" },
        }),
      },
    });
    const lines = r.calls.trim().split("\n");
    const at = (re) => lines.findIndex((l) => re.test(l));
    assert.match(lines[at(/^lane kill/)], /^lane kill --issue 7 --repo-root --state-file$/);
    assert.ok(at(/^lane kill/) < at(/^lane status --issue 7/));
    assert.ok(at(/^lane status --issue 7/) < at(/^lane finish/));
    assert.match(r.calls, /^handler .* exit=124 /m);
  });

  it("an overdue run that won't die stays live, unfinished", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      vars: {
        FAKE_STATUS: statusOf(env, { state: "overdue", alive: true }),
        FAKE_KILL: '{"ok":false,"state":"alive"}',
      },
    });
    assert.doesNotMatch(r.calls, /lane finish|^handler/m);
    assert.match(r.out, /live=\[ 7 \]/);
  });

  for (const [state, spends] of [
    ["unattached", false],
    ["unreadable", true],
  ]) {
    it(`a dead ${state} run is dropped unread, no handler${spends ? ", attempt spent" : ", no attempt"}`, () => {
      const env = collectEnv();
      const r = runCollect(env, {
        vars: { FAKE_STATUS: statusOf(env, { state, alive: false, pid: null }) },
      });
      assert.match(
        r.calls,
        new RegExp(`^lane finish --issue 7 --run-id R1 --outcome ${state}`, "m"),
      );
      assert.doesNotMatch(r.calls, /^handler|mark-resumable/m);
      assert.equal(/state-cli factory:bump-attempts 7/.test(r.calls), spends);
      assert.match(r.out, /collected=\[ 7 \]/);
    });
  }

  it("an unreadable run whose finish is refused stays held, and is charged nothing this tick", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      vars: {
        FAKE_STATUS: statusOf(env, { state: "unreadable", alive: false }),
        FAKE_FINISH: '{"ok":false,"reason":"leftover-unreadable"}',
      },
    });
    assert.match(r.calls, /^lane finish --issue 7 --run-id R1 --outcome unreadable --pid 100/m);
    assert.doesNotMatch(r.calls, /bump-attempts|^handler/m);
    assert.match(r.log, /couldn't drop detached implement run R1 \(leftover-unreadable\)/);
    assert.match(r.out, /live=\[ 7 \] collected=\[ \]/);
  });

  it("a card that left, whose run's finish is refused, stays held", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      ctx: FULL_CTX,
      vars: {
        FAKE_STATUS: statusOf(env, DONE(0)),
        FAKE_CARD: "left",
        FAKE_FINISH: '{"ok":false,"reason":"still-alive"}',
      },
    });
    assert.doesNotMatch(r.calls, /^handler/m);
    assert.match(r.out, /live=\[ 7 \] collected=\[ \]/);
  });

  it("a rollback-pending run, once dead, is dropped unread with no attempt", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      vars: {
        FAKE_STATUS: statusOf(env, { state: "rollback", alive: false, rollbackPending: true }),
      },
    });
    assert.match(r.calls, /^lane finish --issue 7 --run-id R1 --outcome rollback --pid 100/m);
    assert.doesNotMatch(r.calls, /bump-attempts|^handler|^comments/m);
    assert.match(r.log, /is rollback \(a start rolled back\); dropping it unread/);
    assert.match(r.out, /collected=\[ 7 \]/);
  });

  it("a rollback-pending run still alive is stopped first (no --finish)", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      vars: {
        FAKE_STATUS: statusOf(env, { state: "rollback", alive: true, rollbackPending: true }),
        FAKE_STATUS_ISSUE: statusOf(env, {
          state: "rollback",
          alive: false,
          rollbackPending: true,
        }),
      },
    });
    const lines = r.calls.trim().split("\n");
    const at = (re) => lines.findIndex((l) => re.test(l));
    assert.ok(
      at(/^lane kill --issue 7 --repo-root --state-file$/) <
        at(/^lane finish .*--outcome rollback/),
    );
  });

  it("an unverified cleanup holds the card: no kill, no finish, no handler", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      vars: { FAKE_STATUS: statusOf(env, { state: "unverified", alive: false }) },
    });
    assert.doesNotMatch(r.calls, /lane (kill|finish)|^handler|bump-attempts/m);
    assert.match(r.log, /cleanup unverified/);
    assert.match(r.out, /live=\[ 7 \] collected=\[ \]/);
  });

  it("re-reads the card first: factory-pause holds the result back", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      ctx: FULL_CTX,
      vars: { FAKE_STATUS: statusOf(env, DONE(0)), FAKE_CARD: "paused" },
    });
    assert.match(r.calls, /^card 7$/m);
    assert.doesNotMatch(r.calls, /lane finish|^handler|^comments/m);
    assert.match(r.out, /live=\[ 7 \] collected=\[ \]/);
  });

  it("re-reads the card first: one that left the factory's columns gets its run dropped unread", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      ctx: FULL_CTX,
      vars: { FAKE_STATUS: statusOf(env, DONE(0)), FAKE_CARD: "left" },
    });
    assert.match(r.calls, /^lane finish --issue 7 --run-id R1 --outcome stopped/m);
    assert.doesNotMatch(r.calls, /^handler|bump-attempts|^comments/m);
    assert.match(r.out, /collected=\[ 7 \]/);
  });

  it("re-reads the card first: unreadable means next tick", () => {
    const env = collectEnv();
    const r = runCollect(env, {
      ctx: FULL_CTX,
      vars: { FAKE_STATUS: statusOf(env, DONE(0)), FAKE_CARD: "unknown" },
    });
    assert.doesNotMatch(r.calls, /lane finish|^handler/m);
    assert.match(r.out, /live=\[ 7 \]/);
  });

  it("a status failure returns 1 with the live set unknown", () => {
    const env = collectEnv();
    const r = runCollect(env, { vars: { FAKE_STATUS_RC: "1" } });
    assert.equal(r.out, "rc=1 known=0 live=[ ] collected=[ ] now=[] end=[]");
  });
});

describe("implement_lane_ctx → implement_lane_restore round trip", () => {
  it("restores every handler global exactly", () => {
    const env = collectEnv();
    const snippet = [
      "set -euo pipefail",
      ...["implement_lane_ctx", "implement_lane_ctx_get", "implement_lane_restore"].map(fnText),
      "ITEM_ID='item 7'; ITEM_LABELS='a,b'; SLOT=0; WT_PATH='/w t'; IMPL_START_EPOCH=5",
      `IMPL_RESUMED=1; IMPL_SESSION_ID=${SID}; IMPL_TASK_KEY='plan:1@x|rev:2'; IMPL_FEEDBACK_DIGEST=dd`,
      "PRE_HEAD_OID=p; PRE_HEAD_KNOWN=1; CHAIN_PRE_HEAD_OID=c; CHAIN_PRE_HEAD_KNOWN=1",
      `PRIOR_PR=$'{\\n  "number": 9, "title": "it\\'s \\\\"q\\\\" $x"\\n}'`,
      `BUNDLE='{"spec":{},"migrations":{"claimedComplete":false}}'`,
      "AFFECTED='web,mobile'; PARITY_OVERRIDE=web-only; IS_REVISION=1; FEEDBACK_CONSUMED_AT=t",
      `REPLY_MARKERS='[{"m":1}]'`,
      "before=$(declare -p ITEM_ID ITEM_LABELS SLOT WT_PATH IMPL_START_EPOCH IMPL_RESUMED IMPL_SESSION_ID IMPL_TASK_KEY IMPL_FEEDBACK_DIGEST PRE_HEAD_OID PRE_HEAD_KNOWN CHAIN_PRE_HEAD_OID CHAIN_PRE_HEAD_KNOWN PRIOR_PR AFFECTED PARITY_OVERRIDE IS_REVISION FEEDBACK_CONSUMED_AT REPLY_MARKERS)",
      `jq -n --argjson ctx "$(implement_lane_ctx 2026-11-17T10:00:00Z)" '{formatVersion: 1, ctx: $ctx}' >"${join(env.dir, "meta.json")}"`,
      "unset ITEM_ID ITEM_LABELS SLOT WT_PATH IMPL_START_EPOCH IMPL_RESUMED IMPL_SESSION_ID IMPL_TASK_KEY IMPL_FEEDBACK_DIGEST PRE_HEAD_OID PRE_HEAD_KNOWN CHAIN_PRE_HEAD_OID CHAIN_PRE_HEAD_KNOWN PRIOR_PR BUNDLE AFFECTED PARITY_OVERRIDE IS_REVISION FEEDBACK_CONSUMED_AT REPLY_MARKERS",
      `implement_lane_restore "${join(env.dir, "meta.json")}" 7 1 /ledger-wt`,
      "after=$(declare -p ITEM_ID ITEM_LABELS SLOT WT_PATH IMPL_START_EPOCH IMPL_RESUMED IMPL_SESSION_ID IMPL_TASK_KEY IMPL_FEEDBACK_DIGEST PRE_HEAD_OID PRE_HEAD_KNOWN CHAIN_PRE_HEAD_OID CHAIN_PRE_HEAD_KNOWN PRIOR_PR AFFECTED PARITY_OVERRIDE IS_REVISION FEEDBACK_CONSUMED_AT REPLY_MARKERS)",
      '[[ "$before" == "$after" ]] && echo SAME || { echo "$before"; echo ---; echo "$after"; }',
      'echo "issue=$ISSUE_NUM start=$CLAUDE_START_ISO bundle=$BUNDLE"',
    ].join("\n");
    const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      'SAME\nissue=7 start=2026-11-17T10:00:00Z bundle={"migrations":{"claimedComplete":false}}\n',
    );
  });
});

describe("implement_lane_start", () => {
  const START_FNS = ["implement_lane_ctx", "implement_lane_start"].map(fnText);
  function runStart({ answer, resumed = 0 }) {
    const dir = tempDir();
    const calls = join(dir, "calls");
    const snippet = [
      "set -euo pipefail",
      `CALLS="${calls}"; LOG_FILE="${join(dir, "log")}"; SCRIPT_DIR=/stub; STATE_FILE=/state.json`,
      "REPO_ROOT=/repo; IMPLEMENT_RUN_ROOT=/runs; ISSUE_NUM=7; SLOT=1; WT_PATH=/wt/7",
      "ITEM_ID=item-7; ITEM_LABELS=; IMPL_START_EPOCH=5; IMPL_TASK_KEY=k; IMPL_FEEDBACK_DIGEST=d",
      `IMPL_RESUMED=${resumed}; IMPL_SESSION_ID=${SID}; IMPL_SESSION_FLAG=${resumed ? "--resume" : "--session-id"}`,
      "PRE_HEAD_OID=; PRE_HEAD_KNOWN=1; CHAIN_PRE_HEAD_OID=c0; CHAIN_PRE_HEAD_KNOWN=1; PRIOR_PR=null",
      "BUNDLE='{}'; AFFECTED=web; PARITY_OVERRIDE=; IS_REVISION=0; FEEDBACK_CONSUMED_AT=; REPLY_MARKERS='[]'",
      "FACTORY_EFFORT=ultracode; IMPLEMENT_TIMEOUT_SEC=2700; FACTORY_IMPLEMENT_TERM_GRACE_SEC=30",
      "FACTORY_IMPLEMENT_KILL_GRACE_SEC=300; FACTORY_IMPLEMENT_MAX_RUNNING=1",
      `CLAUDE_INPUT=$'the prompt\\n\\n## Context\\n\\n'`,
      'rec() { printf "%s\\n" "$*" >>"$CALLS"; }',
      'log() { printf "%s\\n" "$*" >>"$LOG_FILE"; }',
      'implement_mark_resumable() { rec "mark-resumable $1 $3 $5 $6 $7"; }',
      // implement-lane.mjs start: keep a copy of the spec and the input it was given.
      `node() { shift; if [[ "$1" == start ]]; then cp "$3" "${join(dir, "spec.json")}"; cp "$(jq -r .inputFile "$3")" "${join(dir, "input")}"; printf '%s' "$FAKE_ANSWER"; else rec "node $*"; fi; }`,
      ...START_FNS,
      'rc=0; implement_lane_start || rc=$?; echo "rc=$rc"',
    ].join("\n");
    const r = spawnSync("bash", ["-c", snippet], {
      encoding: "utf8",
      env: { ...process.env, FAKE_ANSWER: answer },
    });
    assert.equal(r.status, 0, r.stderr);
    return {
      out: r.stdout.trim(),
      calls: read(calls),
      log: read(join(dir, "log")),
      spec: existsSync(join(dir, "spec.json")) ? JSON.parse(read(join(dir, "spec.json"))) : null,
      input: read(join(dir, "input")),
    };
  }

  it("hands implement-lane.mjs the run's spec and the claude input byte for byte", () => {
    const r = runStart({
      answer: '{"started":true,"runId":"R1","pid":4242,"deadlineAt":"2026-11-17T10:45:00Z"}',
    });
    assert.equal(r.out, "rc=0");
    const { ctx, inputFile, ...spec } = r.spec;
    assert.deepEqual(spec, {
      issue: "7",
      slot: 1,
      worktree: "/wt/7",
      effort: "ultracode",
      mode: "fresh",
      sessionId: SID,
      timeoutSec: "2700",
      termGraceSec: "30",
      killGraceSec: "300",
      maxRunning: "1",
    });
    assert.ok(inputFile);
    assert.equal(ctx.itemId, "item-7");
    assert.match(ctx.claudeStartIso, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(r.input, "the prompt\n\n## Context\n\n");
    assert.match(
      r.log,
      /^Issue #7: started detached implement run R1 \(pid 4242, slot 1, cap 2700s until 2026-11-17T10:45:00Z, effort=ultracode, --session-id /m,
    );
    assert.equal(r.calls, "");
  });

  it("a resume starts in resume mode", () => {
    const r = runStart({ answer: '{"started":true,"runId":"R1","pid":1}', resumed: 1 });
    assert.equal(r.spec.mode, "resume");
  });

  for (const reason of ["max-running", "running", "slot-not-held", "factory-paused", "abandoned"]) {
    it(`a refused start (${reason}) spends no attempt and keeps the slot`, () => {
      const r = runStart({ answer: `{"started":false,"reason":"${reason}"}` });
      assert.equal(r.out, "rc=1");
      assert.ok(
        r.log.includes(`didn't start (${reason}); no attempt spent, keeping slot 1 + worktree`),
        r.log,
      );
      assert.doesNotMatch(r.calls, /bump-attempts|slot-release|mark-resumable/);
    });
  }

  it("a start that fails with an error spends the attempt (bounded), still keeping the slot", () => {
    const r = runStart({ answer: '{"started":false,"reason":"start-failed","error":"EACCES"}' });
    assert.equal(r.out, "rc=1");
    assert.match(r.log, /failed to start \(start-failed: EACCES\); spending the attempt/);
    assert.match(r.calls, /^node factory:bump-attempts 7 /m);
    assert.doesNotMatch(r.calls, /slot-release/);
  });

  it("a resume that couldn't start is recorded again, so the next tick still resumes", () => {
    const r = runStart({ answer: "", resumed: 1 });
    assert.equal(r.out, "rc=1");
    assert.match(r.calls, new RegExp(`^mark-resumable 7 ${SID} c0 1 detached start failed$`, "m"));
  });
});

describe("guards in the other modes", () => {
  const WATCH = between("# ── --watch mode", "# ── --browser mode");
  const RELEASE = script.slice(script.indexOf("# ── --release mode"));

  it("the --watch sweep stops a run before it frees the slot, and keeps both if it's still alive", () => {
    const sweep = WATCH.slice(WATCH.indexOf("# ── 1. Cleanup sweep ──"), WATCH.indexOf("# ── 1b."));
    const stop = sweep.indexOf('implement_lane_stop "$SLOT_ISSUE"');
    const release = sweep.indexOf('factory:slot-release "$SLOT"');
    assert.ok(stop !== -1 && release !== -1 && stop < release);
    assert.match(
      sweep,
      /if ! implement_lane_stop "\$SLOT_ISSUE" [^\n]*; then\n\s*log [^\n]*keeping slot \+ worktree[^\n]*\n\s*continue\n\s*fi/,
    );
  });

  it("--watch skips a held card, and every In Review card when the runs can't be read", () => {
    assert.match(
      WATCH,
      /if \[\[ "\$REVIEW_COUNT" -gt 0 \]\]; then implement_lane_held_issues \|\| true; fi/,
    );
    const loop = WATCH.slice(WATCH.indexOf("for ((IDX=0; IDX<REVIEW_COUNT; IDX++)); do"));
    const holds = loop.indexOf('if implement_lane_holds "$ISSUE_NUM"; then');
    const known = loop.indexOf('if [[ "$IMPLEMENT_LIVE_KNOWN" -eq 0 ]]; then');
    // Before anything that can write to the PR branch or worktree.
    const writes = [
      "PR_OBJ=$(find_prior_pr",
      "migration_renumber_gate",
      'worktree-cli.mjs" add',
      "update_pr_branch",
      "intest_handoff",
    ].map((w) => loop.indexOf(w));
    assert.ok(holds !== -1 && known !== -1 && holds < known);
    for (const w of writes) assert.ok(w > known, "every branch write comes after the guard");
    assert.match(
      loop.slice(known, known + 300),
      /then\n\s*log "[^\n]*couldn't be read; leaving the card for the next tick"; continue\n/,
    );
  });

  it("--release skips a held card, and every card when the runs can't be read", () => {
    assert.match(
      RELEASE,
      /if \[\[ "\$APPROVED_COUNT" -gt 0 \]\]; then implement_lane_held_issues \|\| true; fi/,
    );
    const loop = RELEASE.slice(RELEASE.indexOf("for ((IDX=0; IDX<APPROVED_COUNT; IDX++)); do"));
    const known = loop.indexOf('if [[ "$IMPLEMENT_LIVE_KNOWN" -eq 0 ]]; then');
    const holds = loop.indexOf('if implement_lane_holds "$ISSUE_NUM"; then');
    const pr = loop.indexOf("PR_OBJ=$(find_prior_pr");
    assert.ok(known !== -1 && holds !== -1 && known < pr && holds < pr);
  });

  function teardown(fn, stopRc) {
    const dir = tempDir();
    const calls = join(dir, "calls");
    const snippet = [
      "set -euo pipefail",
      `CALLS="${calls}"; LOG_FILE="${join(dir, "log")}"; SCRIPT_DIR=/stub; STATE_FILE=/s; REPO_ROOT=/r`,
      'rec() { printf "%s\\n" "$*" >>"$CALLS"; }',
      'log() { printf "%s\\n" "$*" >>"$LOG_FILE"; }',
      `implement_lane_stop() { rec "stop $1 ($2)"; return ${stopRc}; }`,
      "slot_held_by_issue() { echo 1; }",
      'branch_keep_reason() { echo ""; }',
      "log_removed_worktree_leftovers() { :; }",
      "scenario_diff_prune() { :; }",
      'node() { rec "node $*"; echo "{}"; }',
      ...["release_slot_and_worktree", "remove_worktree_for"].map(fnText),
      `${fn} 7`,
    ].join("\n");
    const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return { calls: read(calls), log: read(join(dir, "log")) };
  }

  it("release_slot_and_worktree stops the run first; a live run keeps the slot and worktree", () => {
    const ok = teardown("release_slot_and_worktree", 0);
    assert.match(
      ok.calls,
      /^stop 7 \(slot release\)\nnode \/stub\/lib\/state-cli\.mjs factory:slot-release 1/m,
    );
    assert.match(ok.calls, /worktree-cli\.mjs remove --issue 7/);
    const alive = teardown("release_slot_and_worktree", 1);
    assert.equal(alive.calls, "stop 7 (slot release)\n");
    assert.match(alive.log, /keeping its slot and worktree/);
  });

  it("remove_worktree_for stops the run first; a live run keeps the worktree", () => {
    const ok = teardown("remove_worktree_for", 0);
    assert.match(
      ok.calls,
      /^stop 7 \(worktree teardown\)\nnode \/stub\/lib\/worktree-cli\.mjs remove/m,
    );
    const alive = teardown("remove_worktree_for", 1);
    assert.equal(alive.calls, "stop 7 (worktree teardown)\n");
    assert.match(alive.log, /not removing it this tick/);
  });

  it("implement_lane_stop: none and gone are fine, anything else keeps the worktree", () => {
    const stop = fnText("implement_lane_stop");
    const runStop = (answer, rc = 0) => {
      const dir = tempDir();
      const snippet = [
        "set -euo pipefail",
        `LOG_FILE="${join(dir, "log")}"; SCRIPT_DIR=/stub; STATE_FILE=/s; REPO_ROOT=/r`,
        'log() { printf "%s\\n" "$*" >>"$LOG_FILE"; }',
        `node() { echo "$*" >"${join(dir, "args")}"; printf '%s' '${answer}'; return ${rc}; }`,
        stop,
        'r=0; implement_lane_stop 7 why || r=$?; echo "r=$r"',
      ].join("\n");
      const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return { out: r.stdout.trim(), log: read(join(dir, "log")), args: read(join(dir, "args")) };
    };
    const none = runStop('{"ok":true,"state":"none"}');
    assert.equal(none.out, "r=0");
    assert.match(
      none.args,
      /implement-lane\.mjs kill --issue 7 --finish 1 --outcome stopped --repo-root \/r --state-file \/s/,
    );
    assert.equal(runStop('{"ok":true,"state":"gone","runId":"R1"}').out, "r=0");
    assert.match(
      runStop('{"ok":true,"state":"gone","runId":"R1"}').log,
      /stopped detached implement run R1 \(why\)/,
    );
    assert.equal(runStop('{"ok":false,"state":"alive"}').out, "r=1");
    // The processes are gone but the finish was refused (another run, or an
    // attach since): not stopped, the worktree stays.
    assert.equal(runStop('{"ok":false,"state":"gone","reason":"pid-changed"}').out, "r=1");
    assert.match(
      runStop('{"ok":false,"state":"gone","reason":"pid-changed"}').log,
      /couldn't stop and drop[^\n]*pid-changed/,
    );
    assert.equal(runStop('{"ok":false,"state":"unknown"}').out, "r=1");
    assert.equal(runStop("", 1).out, "r=1");
  });
});
