import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The oversize hold (ADR-0103): --implement never starts an unsplit oversize
// card. An unstarted card whose approved plan estimates at least
// FACTORY_PLAN_OVERSIZE_LINES, and that has no oversize-approved label, goes
// back to Plan Review with one 🏭 comment. `gh` and transition_status are HARD
// STUBS here: without them a unit test would comment on and move a live card.
// plan-size.mjs and state-cli.mjs run for real, on a temp state file.

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentPath = join(scriptsDir, "factory-agent.sh");
const script = readFileSync(agentPath, "utf8");

const extract = (name) =>
  `eval "$(awk '/^${name}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"`;

const PLAN_ID = 4242;
const planJson = (marker) =>
  JSON.stringify({
    id: PLAN_ID,
    authorAssociation: "OWNER",
    createdAt: "2026-11-25T10:00:00Z",
    body: `<!-- drafto-factory-plan -->\n## Plan\n…\n${marker}`,
  });
const XL = "<!-- drafto-factory-plan-size:XL:1800 -->";
const M = "<!-- drafto-factory-plan-size:M:400 -->";

// opts: marker, labels, priorPr, comments, state (object | string),
// knobs ({FACTORY_OVERSIZE_HOLD, FACTORY_PLAN_OVERSIZE_LINES}), dryRun,
// commentFails, transitionFails. Returns {status, held, log, calls}.
function runHold(opts = {}) {
  const {
    marker = XL,
    labels = "status:in-progress,factory-oversize",
    priorPr = "null",
    comments = [],
    state = {},
    knobs = {},
    dryRun = 0,
    commentFails = false,
    transitionFails = false,
  } = opts;
  const dir = mkdtempSync(join(tmpdir(), "oversize-hold-"));
  const calls = join(dir, "calls");
  const stateFile = join(dir, "factory-state.json");
  writeFileSync(stateFile, typeof state === "string" ? state : JSON.stringify(state));
  const knobLines = Object.entries(knobs)
    .map(([k, v]) => `${k}=${JSON.stringify(String(v))}`)
    .join("\n");
  try {
    const snippet = `
set -euo pipefail
${extract("comments_have_marker")}
${extract("oversize_hold")}
log() { echo "[log] $*"; }
gh() {
  echo "[gh] $*" >>${JSON.stringify(calls)}
  ${commentFails ? 'case "${1:-} ${2:-}" in "issue comment") return 1 ;; esac' : ""}
  return 0
}
transition_status() {
  echo "[transition] $1 $2 $3" >>${JSON.stringify(calls)}
  ${transitionFails ? "return 1" : "return 0"}
}
SCRIPT_DIR=${JSON.stringify(scriptsDir)}
STATE_FILE=${JSON.stringify(stateFile)}
LOG_FILE=${JSON.stringify(join(dir, "agent.log"))}
DRY_RUN=${dryRun}
${knobLines}
if oversize_hold 900 ITEM_900 ${JSON.stringify(labels)} ${JSON.stringify(planJson(marker))} \\
    ${JSON.stringify(priorPr)} ${JSON.stringify(JSON.stringify(comments))}; then
  echo "HELD"
else
  echo "RUN"
fi
`;
    // Only PATH: the factory's own FACTORY_* knobs must not leak in from the
    // shell running the tests. The snippet sets the ones a test wants.
    const r = spawnSync("/bin/bash", ["-c", snippet], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
    return {
      held: /HELD\s*$/.test(r.stdout),
      log: r.stdout,
      calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const holdMarker = `<!-- drafto-factory-oversize-hold:${PLAN_ID}:1800 -->`;

describe("oversize_hold (extracted, real bash 3.2, gh + transition stubbed)", () => {
  it("holds an unstarted XL card: one comment, then back to Plan Review", () => {
    const out = runHold();
    assert.ok(out.held, out.log);
    assert.match(out.calls, /\[gh\] issue comment 900 --repo JakubAnderwald\/drafto --body /);
    assert.ok(out.calls.includes(holdMarker), "marker carries the plan id and the estimate");
    assert.match(out.calls, /\[transition\] ITEM_900 900 Plan Review\n/);
    assert.ok(
      out.calls.indexOf("issue comment") < out.calls.indexOf("[transition]"),
      "comment first, then the move",
    );
    assert.match(out.log, /estimates ~1800 added lines \(XL\), at least 1500/);
  });

  it("tells the operator how to release it, and that a plain approval replans", () => {
    const { calls } = runHold();
    assert.match(calls, /comment `\/split`/);
    assert.match(
      calls,
      /A replan never moves the card either: once one brings the estimate under 1500 lines, drag the card back to \*\*In Progress\*\* to run it\./,
    );
    assert.match(calls, /\*\*Proposed split\*\*/);
    assert.match(
      calls,
      /add the \*\*`oversize-approved`\*\* label, then drag the card back to \*\*In Progress\*\*/,
    );
    assert.match(
      calls,
      /A plain "approved" comment doesn't release the hold: it starts a replan, which is a paid planner run/,
    );
  });

  it("does not hold a card with oversize-approved", () => {
    const out = runHold({ labels: "status:in-progress,factory-oversize,oversize-approved" });
    assert.equal(out.held, false);
    assert.equal(out.calls, "");
  });

  it("does not hold a plan below the threshold, or one with no size marker", () => {
    assert.equal(runHold({ marker: M }).held, false);
    assert.equal(runHold({ marker: "" }).held, false);
    assert.equal(runHold({ marker: M }).calls, "");
  });

  it("uses the threshold knob: at the threshold holds, one below does not", () => {
    assert.equal(runHold({ knobs: { FACTORY_PLAN_OVERSIZE_LINES: 1800 } }).held, true);
    assert.equal(runHold({ knobs: { FACTORY_PLAN_OVERSIZE_LINES: 1801 } }).held, false);
    assert.equal(runHold({ marker: M, knobs: { FACTORY_PLAN_OVERSIZE_LINES: 300 } }).held, true);
  });

  it("does not hold a card that has a PR (open, or closed and reopened by a push)", () => {
    for (const state of ["OPEN", "CLOSED"]) {
      const pr = JSON.stringify({ number: 77, url: "u", headRef: "factory/issue-900", state });
      const out = runHold({ priorPr: pr });
      assert.equal(out.held, false, state);
      assert.equal(out.calls, "", state);
    }
  });

  it("does not hold a card with an implement run on record (a retry after a timeout)", () => {
    for (const rec of [
      { implementSessionId: "0b8f2a1e-1111-4222-8333-444455556666" },
      { lastImplementAt: "2026-11-25T09:00:00.000Z" },
    ]) {
      const out = runHold({ state: { issues: { 900: { attempts: 1, ...rec } } } });
      assert.equal(out.held, false, JSON.stringify(rec));
      assert.equal(out.calls, "", JSON.stringify(rec));
    }
  });

  it("holds a card whose attempts come from the plan stage only", () => {
    // --plan and --implement share issues[n].attempts. A replan that fails
    // bumps it, and a noop replan after it doesn't reset it, so a card that
    // has never been implemented can reach In Progress with attempts 1. With
    // no implement session, no lastImplementAt, no PR, slot or resume record,
    // it hasn't started and is held.
    const state = {
      issues: {
        900: {
          attempts: 2,
          lastPlanAt: "2026-11-25T08:00:00.000Z",
          implementSessionId: null,
          lastImplementAt: null,
          implementResumeSession: null,
        },
      },
    };
    const out = runHold({ state });
    assert.equal(out.held, true, out.log);
    assert.ok(out.calls.includes(holdMarker));
    assert.match(out.calls, /\[transition\] ITEM_900 900 Plan Review/);
  });

  it("does not hold a card that already holds a worktree slot", () => {
    const state = {
      slots: {
        0: { pid: null, issueNumber: null, acquiredAt: null },
        1: { pid: 123, issueNumber: "900", acquiredAt: "2026-11-25T10:00:00Z" },
      },
    };
    const out = runHold({ state });
    assert.equal(out.held, false);
    assert.equal(out.calls, "");
    // Another card's slot doesn't count.
    const other = { slots: { 0: { pid: 123, issueNumber: "901", acquiredAt: "x" } } };
    assert.equal(runHold({ state: other }).held, true);
  });

  it("does not hold a card with an implement resume record", () => {
    const state = {
      issues: { 900: { implementResumeSession: "0b8f2a1e-1111-4222-8333-444455556666" } },
    };
    const out = runHold({ state });
    assert.equal(out.held, false);
    assert.equal(out.calls, "");
  });

  it("defers, without a comment or a move, when the state can't be read", () => {
    const out = runHold({ state: "{not json" });
    assert.equal(out.held, true, "skipped this tick");
    assert.equal(out.calls, "");
    assert.match(out.log, /deferring the card to the next tick/);
  });

  it("posts the marker once per estimate, but moves the card every time", () => {
    const already = [{ id: 1, authorAssociation: "OWNER", body: `🏭 Hold\n\n${holdMarker}` }];
    const out = runHold({ comments: already });
    assert.equal(out.held, true);
    assert.doesNotMatch(out.calls, /issue comment/);
    assert.match(out.calls, /\[transition\] ITEM_900 900 Plan Review/);

    // A replan edits the plan in place: a new estimate gets a new comment.
    const newer = runHold({
      comments: already,
      marker: "<!-- drafto-factory-plan-size:XL:2100 -->",
    });
    assert.match(newer.calls, /issue comment/);
    assert.ok(newer.calls.includes(`drafto-factory-oversize-hold:${PLAN_ID}:2100 -->`));

    // 1800 must not match a marker for 18000, nor one posted by someone else.
    const longer = [
      {
        id: 2,
        authorAssociation: "OWNER",
        body: `<!-- drafto-factory-oversize-hold:${PLAN_ID}:18000 -->`,
      },
      { id: 3, authorAssociation: "NONE", body: holdMarker },
    ];
    assert.match(runHold({ comments: longer }).calls, /issue comment/);
  });

  it("keeps the card where it is when the comment fails, and still skips it", () => {
    const out = runHold({ commentFails: true });
    assert.equal(out.held, true);
    assert.doesNotMatch(out.calls, /\[transition\]/);
    assert.match(out.log, /couldn't post the oversize-hold comment/);
  });

  it("skips the card when the move fails; the next tick finds the marker and retries the move", () => {
    const out = runHold({ transitionFails: true });
    assert.equal(out.held, true);
    assert.match(out.log, /the next tick tries again/);
  });

  it("only logs in a dry run, and lets the dry run print the bundle", () => {
    const out = runHold({ dryRun: 1 });
    assert.equal(out.held, false);
    assert.equal(out.calls, "");
    assert.match(out.log, /DRY-RUN: would hold #900 in Plan Review/);
  });

  it("is off with FACTORY_OVERSIZE_HOLD=0 or FACTORY_PLAN_OVERSIZE_LINES=0", () => {
    for (const knobs of [{ FACTORY_OVERSIZE_HOLD: 0 }, { FACTORY_PLAN_OVERSIZE_LINES: 0 }]) {
      const out = runHold({ knobs });
      assert.equal(out.held, false, JSON.stringify(knobs));
      assert.equal(out.calls, "", JSON.stringify(knobs));
    }
  });
});

describe("factory-agent.sh oversize hold: the knob", () => {
  const block = script.match(
    /FACTORY_OVERSIZE_HOLD="\$\{FACTORY_OVERSIZE_HOLD:-1\}"[\s\S]*?OVERSIZE_APPROVED_LABEL="oversize-approved"\n/,
  );
  const run = (env) => {
    assert.ok(block, "knob block");
    const r = spawnSync(
      "/bin/bash",
      ["-c", `set -euo pipefail\n${block[0]}\necho "H=$FACTORY_OVERSIZE_HOLD"`],
      { encoding: "utf8", env: { PATH: process.env.PATH, ...env } },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };

  it("defaults to 1; 0 turns it off; a bad value warns and means 1", () => {
    assert.equal(run({}), "H=1");
    assert.equal(run({ FACTORY_OVERSIZE_HOLD: "0" }), "H=0");
    for (const bad of ["yes", "2", "true", ""]) {
      assert.equal(run({ FACTORY_OVERSIZE_HOLD: bad }), "H=1", bad);
    }
  });
});

describe("factory-agent.sh oversize hold: --implement wiring", () => {
  const IMPLEMENT = (() => {
    const a = script.indexOf("# ── --implement mode");
    assert.ok(a !== -1);
    return script.slice(a);
  })();

  it("runs right after find_prior_pr, before any slot, worktree or bundle is spent", () => {
    const prior = IMPLEMENT.indexOf('PRIOR_PR=$(find_prior_pr "$ISSUE_NUM")');
    const hold = IMPLEMENT.indexOf('if oversize_hold "$ISSUE_NUM" "$ITEM_ID"');
    const slot = IMPLEMENT.indexOf('SLOT=$(slot_for_issue "$ISSUE_NUM")');
    const bundle = IMPLEMENT.indexOf("BUNDLE=$(build_implement_bundle");
    assert.ok(prior !== -1 && hold !== -1 && slot !== -1 && bundle !== -1);
    assert.ok(prior < hold && hold < slot && slot < bundle);
    // It reads the plan it was given, after it is known. Not the attempts
    // counter: --plan shares it, so it can't tell whether implementing began.
    assert.ok(IMPLEMENT.indexOf("PLAN_COMMENT_JSON=$(extract_plan_comment") < hold);
    const call = IMPLEMENT.slice(hold, IMPLEMENT.indexOf("fi\n", hold));
    assert.match(call, /"\$PLAN_COMMENT_JSON" "\$PRIOR_PR" "\$COMMENTS_JSON"; then\n\s+continue/);
    assert.doesNotMatch(call, /ATTEMPTS/);
    assert.match(call, /\$ITEM_LABELS,/, "board labels");
    assert.match(call, /ISSUE_RECORD/, "and the issue's own labels");
  });

  it("never touches transition_status's label swap", () => {
    const ts = script.match(/^transition_status\(\) \{[\s\S]*?\n\}/m);
    assert.ok(ts);
    assert.doesNotMatch(ts[0], /oversize/i);
  });
});

describe("setup-factory-labels.sh: oversize-approved", () => {
  const labelsPath = join(scriptsDir, "setup-factory-labels.sh");
  it("creates the operator's override label", () => {
    const labels = readFileSync(labelsPath, "utf8");
    assert.match(labels, /^ {2}"oversize-approved\|[0-9A-F]{6}\|[^"]+"$/m);
  });

  it("--help prints the whole header comment, through its last line", () => {
    // --help exits before any gh call. PATH has no gh on purpose.
    const r = spawnSync("/bin/bash", [labelsPath, "--help"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    assert.equal(r.status, 0, r.stderr);
    const header = readFileSync(labelsPath, "utf8").split("\n");
    const end = header.indexOf("", 1);
    assert.equal(r.stdout, header.slice(1, end).join("\n") + "\n");
    assert.match(
      r.stdout,
      /oversize-approved lets such a card be implemented as-is \(ADR-0103\)\.\n$/,
    );
  });
});
