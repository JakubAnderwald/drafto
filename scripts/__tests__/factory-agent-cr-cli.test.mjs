import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSummary } from "../lib/coderabbit-review.mjs";

// The CodeRabbit CLI gap-fill lane's bash wiring (ADR-0036). The decisions live
// in scripts/lib/coderabbit-cli.mjs; what factory-agent.sh must guarantee is
// narrower and is what these tests lock in:
//   1. the lane is off by default and its knobs are validated before export;
//   2. housekeeping runs every --watch tick, before threads are read, can never
//      take the tick down, reads the module's real {state} output, and stays
//      quiet only when there is nothing to report;
//   3. the gate sits at the converged point (after the Claude review, before the
//      In Test promotion), holds only on an explicit "hold", and fails OPEN with
//      a "coverage unknown" note;
//   4. the lane never pauses the whole factory, and never spends paid credits;
//   5. the thread-loop bound only waives an attempt on an explicit exemption;
//   6. the CLI summary comment never reaches the fixer as feedback;
//   7. the coverage note travels to the In Test hand-off as its own argument
//      (never joined into the advisory checks), at both promotion sites and when
//      the In Test sweep re-writes a scenario, and is rendered apart from the reds;
//   8. run-dir retention has exactly one owner (coderabbit-cli.mjs reap).
//
// Two layers, matching factory-agent-session-limit.test.mjs: static lock-ins
// over the script source, and the real helpers run in bash with node stubbed.

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(scriptsDir, "factory-agent.sh");
const script = readFileSync(scriptPath, "utf8");

const watchBlock = (() => {
  const start = script.indexOf("# ── --watch mode");
  assert.ok(start !== -1, "could not locate the --watch block");
  const end = script.indexOf("# ── In Test feedback sweep", start);
  assert.ok(end !== -1, "could not locate the end of the In Review loop");
  return script.slice(start, end);
})();

function extract(name) {
  const fn = script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m"));
  assert.ok(fn, `could not extract ${name}`);
  return fn[0];
}

describe("factory-agent.sh CodeRabbit lane: static wiring", () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  it("is off by default and declares every knob with its default", () => {
    assert.match(script, /FACTORY_CR_CLI="\$\{FACTORY_CR_CLI:-0\}"/);
    for (const [knob, def] of [
      ["FACTORY_CR_CLI_MAX_PER_HOUR", "3"],
      ["FACTORY_CR_CLI_MAX_RUNS_PER_CARD", "2"],
      ["FACTORY_CR_CLI_TIMEOUT_MIN", "45"],
      ["FACTORY_CR_BOT_GRACE_MIN", "15"],
      ["FACTORY_CR_HOLD_MAX_MIN", "60"],
    ]) {
      assert.match(script, new RegExp(`${knob}="\\$\\{${knob}:-${def}\\}"`), `${knob} default`);
      assert.match(script, new RegExp(`${knob}:${def}\\b`), `${knob} validation fallback`);
    }
    assert.match(script, /^export FACTORY_CR_CLI FACTORY_CR_CLI_MAX_PER_HOUR/m);
  });

  it("validates the knobs under the Mac mini's bash 3.2 before exporting them", () => {
    const block = script.match(
      /FACTORY_CR_CLI="\$\{FACTORY_CR_CLI:-0\}"[\s\S]*?FACTORY_CR_BOT_GRACE_MIN FACTORY_CR_HOLD_MAX_MIN\n/,
    );
    assert.ok(block, "knob block not found");
    const r = spawnSync(
      "/bin/bash",
      ["-c", `set -euo pipefail\n${block[0]}\nenv | grep '^FACTORY_CR_' | sort`],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          FACTORY_CR_CLI: "yes",
          FACTORY_CR_HOLD_MAX_MIN: "abc",
          FACTORY_CR_BOT_GRACE_MIN: "0",
          FACTORY_CR_CLI_MAX_PER_HOUR: "2",
        },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    // `env` is a child process, so this also proves the VALIDATED switch is
    // exported: coderabbit-cli.mjs housekeeping reads it as the lane's kill switch.
    assert.match(r.stdout, /^FACTORY_CR_CLI=0$/m, "a non-0/1 switch must fall back to off");
    assert.match(r.stdout, /^FACTORY_CR_HOLD_MAX_MIN=60$/m);
    assert.match(r.stdout, /^FACTORY_CR_BOT_GRACE_MIN=15$/m);
    assert.match(r.stdout, /^FACTORY_CR_CLI_MAX_PER_HOUR=2$/m, "a valid override survives");
    assert.match(r.stdout, /^FACTORY_CR_CLI_TIMEOUT_MIN=45$/m, "unset knobs export their default");
    assert.match(r.stderr, /invalid FACTORY_CR_HOLD_MAX_MIN='abc'/);
  });

  it("leaves run-dir retention to coderabbit-cli.mjs alone (no second bash reaper)", () => {
    // Two retention rules for one directory drift apart, and only the module
    // knows which dir still belongs to the in-flight run. Its reap runs every
    // --watch tick because housekeeping is unconditional (pinned below).
    assert.match(script, /^CR_CLI_RUN_ROOT="\$LOG_DIR\/cr-cli"$/m);
    assert.doesNotMatch(script, /find "\$CR_CLI_RUN_ROOT"/);
    assert.doesNotMatch(script, /find "\$LOG_DIR[^"\n]*cr-cli/);
  });

  it("runs housekeeping after the cleanup sweep and before the In Review query", () => {
    const sweepIdx = watchBlock.indexOf('remove_worktree_for "$SLOT_ISSUE"');
    const callIdx = watchBlock.indexOf("\n  cr_cli_housekeeping\n");
    const queryIdx = watchBlock.indexOf('--status "In Review"');
    assert.ok(sweepIdx !== -1 && callIdx !== -1 && queryIdx !== -1);
    assert.ok(sweepIdx < callIdx && callIdx < queryIdx, "housekeeping must sit between the two");
    // Not behind the knob: a run started before the lane was switched off still
    // owns a worktree and the in-flight slot.
    assert.doesNotMatch(extract("cr_cli_housekeeping"), /FACTORY_CR_CLI\b/);
  });

  it("documents that switching the lane off terminates and discards, never posts", () => {
    const fnIdx = script.indexOf("\ncr_cli_housekeeping() {");
    const commentStart = script.lastIndexOf("\n\n", fnIdx);
    const comment = script.slice(commentStart, fnIdx).replace(/\s*#\s*/g, " ");
    assert.match(comment, /kill switch, not a drain/);
    assert.match(comment, /terminates a still-running run/);
    assert.match(comment, /nothing is posted, no coverage is recorded/);
  });

  it("keeps the CodeRabbit CLI summary comment out of the watch bundle's unresolvedComments", () => {
    assert.match(
      watchBlock,
      /select\(\(\(\.author\.login \/\/ ""\) == "JakubAnderwald"\s+and \(\(\.body \/\/ ""\) \| contains\("<!-- drafto-factory-cr-cli sha="\)\)\) \| not\)/,
      "the drop must stay tied to the owner identity",
    );
  });

  it("gates after the Claude review stage and before the In Test promotion", () => {
    const reviewIdx = watchBlock.indexOf('review_stage "$ISSUE_NUM"');
    const gateIdx = watchBlock.indexOf('cr_lane_gate "$ISSUE_NUM" "$PR_NUM" "$HEAD_SHA"');
    const promoteIdx = watchBlock.indexOf(') → In Test"');
    assert.ok(reviewIdx !== -1 && gateIdx !== -1 && promoteIdx !== -1);
    assert.ok(reviewIdx < gateIdx && gateIdx < promoteIdx);
    assert.match(
      watchBlock,
      /CR_NOTE=""\n\s*if \[\[ "\$\{FACTORY_CR_CLI:-0\}" == "1" && -n "\$HEAD_SHA" \]\]; then\n\s*if ! cr_lane_gate "\$ISSUE_NUM" "\$PR_NUM" "\$HEAD_SHA"; then\n\s*continue/,
      "a hold must `continue` and the gate must only run with the knob on",
    );
  });

  it("never pauses the whole factory from the lane", () => {
    const names = [...script.matchAll(/^(cr_[a-z_]+)\(\) \{/gm)].map((m) => m[1]);
    assert.ok(names.length >= 2, "expected cr_cli_housekeeping and cr_lane_gate");
    for (const name of names) {
      assert.doesNotMatch(
        extract(name),
        /factory:pause-until/,
        `${name} must not pause the factory`,
      );
    }
  });

  it("passes CR_NOTE as its own trailing intest_handoff argument at both promotion sites", () => {
    const start = watchBlock.indexOf(') → In Test"');
    const promotion = watchBlock.slice(start);
    const handoffs = promotion.match(/intest_handoff [^\n]*/g) || [];
    assert.equal(handoffs.length, 2, "dry-run and live promotion must both hand off");
    for (const call of handoffs) {
      assert.match(
        call,
        /"\$INTEST_BETA" "\$CR_NOTE" \|\| true$/,
        "the note must be the tenth argument, after the beta JSON",
      );
      assert.doesNotMatch(call, /"\$ADVISORY[^"]*\$CR_NOTE/);
    }
    // The note is never folded into the advisory check list anywhere: a joined
    // string could only be split back apart by guessing at the note's wording.
    assert.doesNotMatch(script, /ADVISORY="[^"\n]*\$CR_NOTE/);
    assert.doesNotMatch(script, /note_start/);
  });

  it("rebuilds the note from state when the In Test sweep re-writes a scenario", () => {
    const sweepStart = script.indexOf("# ── In Test feedback sweep");
    const sweepEnd = script.indexOf("# ── --release mode", sweepStart);
    assert.ok(sweepStart !== -1 && sweepEnd !== -1, "could not locate the In Test sweep");
    const sweep = script.slice(sweepStart, sweepEnd);
    const staleIdx = sweep.indexOf('"$INTEST_HEAD_SHA" != "$SCENARIO_SHA"');
    const noteIdx = sweep.indexOf(
      'INTEST_CR_NOTE=$(cr_coverage_note "$ISSUE_NUM" "$INTEST_HEAD_SHA")',
    );
    const handoffIdx = sweep.indexOf("intest_handoff ");
    assert.ok(staleIdx !== -1 && noteIdx !== -1 && handoffIdx !== -1);
    assert.ok(staleIdx < noteIdx && noteIdx < handoffIdx, "note is looked up only for a re-write");
    assert.match(
      sweep,
      /INTEST_CR_NOTE=""\n\s*if \[\[ "\$\{FACTORY_CR_CLI:-0\}" == "1" \]\]; then\n\s*INTEST_CR_NOTE=\$\(cr_coverage_note/,
      "the lookup must only run with the lane on, and default to no note",
    );
    assert.match(
      sweep.slice(handoffIdx),
      /^intest_handoff [\s\S]*?"\$INTEST_BETA" "\$INTEST_CR_NOTE" \|\| true/,
    );
  });

  it("resets the per-card CLI run cap on the live In Test promotion", () => {
    const transitionIdx = watchBlock.indexOf('transition_status "$ITEM_ID" "$ISSUE_NUM" "In Test"');
    assert.ok(transitionIdx !== -1);
    assert.match(
      watchBlock.slice(transitionIdx),
      /factory:set-issue-field "\$ISSUE_NUM" crCliRuns "" --state-file "\$STATE_FILE"[^\n]*\|\| true/,
    );
  });

  it("never passes the paid-overage flag", () => {
    assert.ok(!script.includes("--use-" + "credits"), "the factory must never spend CLI credits");
  });
});

describe("cr_lane_gate (real helper, stubbed node)", () => {
  // `gateStub` is the body of the stubbed `node coderabbit-cli.mjs gate` call.
  function runGate(gateStub) {
    const dir = mkdtempSync(join(tmpdir(), "factory-cr-gate-"));
    const argsLog = join(dir, "args.log");
    try {
      const harness = [
        "set -euo pipefail",
        'SCRIPT_DIR="/stub"',
        "LOG_FILE=/dev/null",
        `STATE_FILE="${join(dir, "state.json")}"`,
        'REPO_ROOT="/repo"',
        'CR_CLI_RUN_ROOT="/repo/logs/factory/cr-cli"',
        "DRY_RUN=0",
        `ARGS_LOG="${argsLog}"`,
        'log() { echo "LOG: $*" >&2; }',
        "node() {",
        '  echo "$*" >> "$ARGS_LOG"',
        `  ${gateStub}`,
        "}",
        extract("cr_lane_gate"),
        "if cr_lane_gate 7 70 0123456789abcdef0123456789abcdef01234567; then rc=0; else rc=$?; fi",
        'echo "RC=$rc NOTE=$CR_NOTE"',
      ].join("\n");
      const res = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
      let args = "";
      try {
        args = readFileSync(argsLog, "utf8");
      } catch {
        args = "";
      }
      return { status: res.status, stdout: res.stdout, stderr: res.stderr, args };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("returns 1 (hold) on an explicit hold", () => {
    const r = runGate(
      `echo '{"action":"hold","reason":"cli-in-flight","coverage":null,"note":""}'`,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RC=1 NOTE=$/m);
    assert.match(r.stderr, /CodeRabbit lane → hold \(cli-in-flight\)/);
    assert.match(
      r.args,
      /coderabbit-cli\.mjs gate --issue 7 --pr 70 --sha 0123456789abcdef0123456789abcdef01234567 --state-file \S+ --repo-root \/repo --run-root \/repo\/logs\/factory\/cr-cli --dry-run 0/,
    );
  });

  it("returns 0 (promote) and exposes the coverage note", () => {
    const r = runGate(
      `echo '{"action":"promote","reason":"budget","coverage":"budget","note":"CodeRabbit did not review 0123456789ab (hourly CLI budget exhausted)"}'`,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /RC=0 NOTE=CodeRabbit did not review 0123456789ab \(hourly CLI budget exhausted\)$/m,
    );
  });

  it("promotes a covered SHA with no note", () => {
    const r = runGate(`echo '{"action":"promote","reason":"covered","coverage":"bot","note":""}'`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RC=0 NOTE=$/m, "only a fail-open promotion invents a note");
  });

  it("uses the last line when the module prints more than one", () => {
    const r = runGate(`echo 'noise'; echo '{"action":"hold","reason":"bot-grace"}'`);
    assert.match(r.stdout, /RC=1 /);
  });

  // A fail-open promotion is a commit nobody knows was reviewed, so it carries
  // the same note coderabbit-cli.mjs returns when its own gate throws.
  const LANE_ERROR_NOTE = /RC=0 NOTE=CodeRabbit coverage of 0123456789ab unknown \(lane error\)$/m;

  it("fails open on unparseable output, with a coverage-unknown note", () => {
    const r = runGate(`echo 'not json at all'`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, LANE_ERROR_NOTE);
    assert.match(r.stderr, /no usable decision; promoting \(fail open\)/);
  });

  it("fails open on an unknown action, with a coverage-unknown note", () => {
    const r = runGate(`echo '{"action":"start","reason":"gap"}'`);
    assert.match(r.stdout, LANE_ERROR_NOTE);
  });

  it("fails open when the module crashes, with a coverage-unknown note", () => {
    const r = runGate(`return 1`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, LANE_ERROR_NOTE);
    assert.match(r.stderr, /gate failed; promoting without it \(fail open\)/);
  });
});

describe("cr_cli_housekeeping (real helper, stubbed node)", () => {
  function runHousekeeping(stub) {
    const dir = mkdtempSync(join(tmpdir(), "factory-cr-housekeeping-"));
    const argsLog = join(dir, "args.log");
    const harness = [
      "set -euo pipefail",
      'SCRIPT_DIR="/stub"',
      "LOG_FILE=/dev/null",
      'STATE_FILE="/state.json"',
      'REPO_ROOT="/repo"',
      'CR_CLI_RUN_ROOT="/repo/logs/factory/cr-cli"',
      "DRY_RUN=1",
      'log() { echo "LOG: $*"; }',
      // The helper sends the module's stderr to $LOG_FILE, so record argv in a
      // file rather than on stderr.
      `node() { echo "$*" >> "${argsLog}"; ${stub}; }`,
      extract("cr_cli_housekeeping"),
      // Called bare, exactly like the script, so `set -e` would kill the harness
      // if the helper ever returned non-zero.
      "cr_cli_housekeeping",
      'echo "AFTER"',
    ].join("\n");
    try {
      const res = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
      let args = "";
      try {
        args = readFileSync(argsLog, "utf8");
      } catch {
        args = "";
      }
      return { status: res.status, stdout: res.stdout, stderr: res.stderr, args };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("a failing module never fails the tick", () => {
    const r = runHousekeeping("return 3");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /WARNING: CodeRabbit CLI housekeeping failed/);
    assert.match(r.stdout, /AFTER/);
  });

  // The stubs below use the shapes runHousekeeping really emits ({state, …});
  // the wrapper once keyed on an `action` field the module never printed, so
  // every idle tick was logged and a caught error never read as a WARNING.
  it("stays quiet when nothing is in flight and nothing was reaped", () => {
    const r = runHousekeeping(`echo '{"state":"idle","reaped":{"worktrees":[],"runDirs":[]}}'`);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /LOG:/);
    assert.match(r.stdout, /AFTER/);
  });

  it("stays quiet while a run is starting or still running", () => {
    for (const state of ["starting", "running"]) {
      const r = runHousekeeping(`echo '{"runId":"r1","issue":"7","sha":"abc","state":"${state}"}'`);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /LOG:/, `${state} must be quiet`);
    }
  });

  it("logs a running run the kill switch just terminated", () => {
    // runHousekeeping keeps poll.state ("running") on a lane-off discard; only
    // the discarded key tells this tick apart from an ordinary still-running one.
    const r = runHousekeeping(
      `echo '{"runId":"r1","issue":"7","sha":"abc","state":"running","discarded":"lane-off","signal":"SIGTERM","refund":"none","reaped":{"worktrees":[],"runDirs":[]}}'`,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /LOG: CodeRabbit CLI housekeeping: .*"discarded":"lane-off"/);
  });

  it("logs an idle tick that reaped something", () => {
    const r = runHousekeeping(
      `echo '{"state":"idle","reaped":{"worktrees":["/repo/worktrees/cr-cli-7-abc"],"runDirs":[]}}'`,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /LOG: CodeRabbit CLI housekeeping: \{"state":"idle"/);
  });

  it("flags a caught module error as a WARNING without failing the tick", () => {
    const r = runHousekeeping(`echo '{"state":"error","error":"boom"}'`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.stdout,
      /LOG: WARNING: CodeRabbit CLI housekeeping error \(non-fatal; retried next tick\): \{"state":"error","error":"boom"\}/,
    );
    assert.match(r.stdout, /AFTER/);
  });

  it("logs a collected run and passes the run root and dry-run flag", () => {
    const r = runHousekeeping(
      `echo '{"runId":"r1","issue":"7","sha":"abc","state":"done","outcome":"ok","refund":"none","reaped":{"worktrees":[],"runDirs":[]}}'`,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /LOG: CodeRabbit CLI housekeeping: \{"runId":"r1".*"state":"done"/);
    assert.doesNotMatch(r.stdout, /WARNING/);
    assert.match(
      r.args,
      /coderabbit-cli\.mjs housekeeping --state-file \/state\.json --repo-root \/repo --run-root \/repo\/logs\/factory\/cr-cli --dry-run 1/,
    );
  });

  it("logs an overdue or lost run", () => {
    for (const state of ["overdue", "lost"]) {
      const r = runHousekeeping(`echo '{"runId":"r1","state":"${state}"}'`);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`LOG: CodeRabbit CLI housekeeping: .*"state":"${state}"`));
    }
  });

  it("tolerates garbage output", () => {
    const r = runHousekeeping(`echo 'garbage'`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /AFTER/);
  });
});

describe("cr_cli_housekeeping against the real coderabbit-cli.mjs (dry run)", () => {
  // Pins the wrapper to the module's actual output contract rather than to a
  // stub of it. Dry run with nothing in flight touches no worktree, run dir,
  // GitHub or vendor CLI: it only reads the state file.
  function runReal(stateContents) {
    const dir = mkdtempSync(join(tmpdir(), "factory-cr-housekeeping-real-"));
    const stateFile = join(dir, "factory-state.json");
    if (stateContents != null) writeFileSync(stateFile, stateContents);
    const harness = [
      "set -euo pipefail",
      `SCRIPT_DIR="${scriptsDir}"`,
      "LOG_FILE=/dev/null",
      `STATE_FILE="${stateFile}"`,
      `REPO_ROOT="${dir}"`,
      `CR_CLI_RUN_ROOT="${join(dir, "cr-cli")}"`,
      "DRY_RUN=1",
      'log() { echo "LOG: $*"; }',
      extract("cr_cli_housekeeping"),
      "cr_cli_housekeeping",
      'echo "AFTER"',
    ].join("\n");
    try {
      return spawnSync("bash", ["-c", harness], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, FACTORY_CR_CLI: "0" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("is quiet on a real idle tick", () => {
    const r = runReal(null);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /LOG:/);
    assert.match(r.stdout, /AFTER/);
  });

  it("warns on a real caught error (corrupt state file)", () => {
    const r = runReal("{ not json");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /LOG: WARNING: CodeRabbit CLI housekeeping error/);
    assert.match(r.stdout, /AFTER/);
  });
});

describe("--watch unresolvedComments filter (real jq program)", () => {
  const program = (() => {
    const m = watchBlock.match(/UNRESOLVED=\$\(echo "\$PR_VIEW" \| jq -c '([\s\S]*?)'\)/);
    assert.ok(m, "could not extract the UNRESOLVED jq program");
    return m[1];
  })();
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  function filter(comments) {
    const r = spawnSync("jq", ["-c", program], {
      encoding: "utf8",
      input: JSON.stringify({ comments }),
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  }

  it("drops the owner's CodeRabbit CLI summary but keeps everything a fixer should see", () => {
    const summary = renderSummary({
      sha: SHA,
      mode: "incremental",
      baseSha: "fedcba9876543210fedcba9876543210fedcba98",
      inline: 1,
      summary: [
        { severity: "minor", fileName: "a.ts", text: "Consolidate the handlers.", why: "severity" },
      ],
    });
    assert.ok(summary.includes(`<!-- drafto-factory-cr-cli sha=${SHA} -->`), "fixture drift");
    const kept = filter([
      { id: "c1", author: { login: "JakubAnderwald" }, body: summary },
      {
        id: "c2",
        author: { login: "someone-else" },
        body: `please look\n<!-- drafto-factory-cr-cli sha=${SHA} -->`,
      },
      {
        id: "c3",
        author: { login: "JakubAnderwald" },
        body: "### Code review\n<!-- drafto-factory-code-review -->",
      },
      { id: "c4", author: { login: "JakubAnderwald" }, body: "Also rename the helper." },
      { id: "c5", author: { login: "vercel" }, body: "Preview ready" },
    ]).map((c) => c.id);
    assert.deepEqual(kept, ["c2", "c3", "c4"]);
  });
});

describe("intest_fallback_comment coverage note (real helper, stubbed gh)", () => {
  // The note is the eighth argument; $advisory is only ever the red-check list.
  function fallbackBody(advisory, note) {
    const dir = mkdtempSync(join(tmpdir(), "factory-cr-fallback-"));
    const bodyFile = join(dir, "body.md");
    const harness = [
      "set -euo pipefail",
      "LOG_FILE=/dev/null",
      `BODY_FILE="${bodyFile}"`,
      // Capture the --body value: the last argument.
      'gh() { local last=""; for last in "$@"; do :; done; printf "%s" "$last" > "$BODY_FILE"; }',
      extract("intest_fallback_comment"),
      `intest_fallback_comment 7 70 "" "$ADVISORY" 0123456789abcdef0123456789abcdef01234567 '{"web":false,"mobile":false,"desktop":false}' "" "$NOTE"`,
    ].join("\n");
    try {
      const r = spawnSync("bash", ["-c", harness], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, ADVISORY: advisory, NOTE: note },
      });
      assert.equal(r.status, 0, r.stderr);
      return readFileSync(bodyFile, "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const NOTE =
    "CodeRabbit did not review 0123456789ab (the CodeRabbit CLI hourly review allowance was used up)";
  const esc = (s) => s.replace(/[()]/g, "\\$&");
  const redLine = (body) => body.split("\n").find((l) => l.includes("not green")) ?? "";

  it("renders a note with no red checks as a note, not as a failing check", () => {
    const body = fallbackBody("", NOTE);
    assert.doesNotMatch(body, /not green/);
    assert.match(body, new RegExp(`^ℹ️ ${esc(NOTE)} — not a failing check`, "m"));
  });

  it("renders red checks and the note on separate lines, checks first", () => {
    const body = fallbackBody("CodeRabbit, SonarCloud", NOTE);
    assert.equal(
      redLine(body),
      "⚠️ Advisory (non-required) checks are not green: CodeRabbit, SonarCloud. They don't block the merge, but are worth a glance before Approving.",
    );
    assert.ok(body.indexOf("not green") < body.indexOf("ℹ️ CodeRabbit did not review"));
  });

  it("renders the lane-error note the same way", () => {
    const note = "CodeRabbit coverage of 0123456789ab unknown (lane error)";
    const body = fallbackBody("CodeRabbit", note);
    assert.match(redLine(body), /not green: CodeRabbit\. They/);
    assert.match(
      body,
      /^ℹ️ CodeRabbit coverage of 0123456789ab unknown \(lane error\) — not a failing check/m,
    );
  });

  it("never guesses a note out of the advisory text", () => {
    // Regression for the old prefix split: any wording that merely looks like a
    // note (a reason containing "; ", a future note prefix) stays exactly what
    // the caller passed — here, part of the red-check list.
    const advisory = `CodeRabbit; ${NOTE}`;
    const body = fallbackBody(advisory, "");
    assert.equal(
      redLine(body),
      `⚠️ Advisory (non-required) checks are not green: ${advisory}. They don't block the merge, but are worth a glance before Approving.`,
    );
    assert.doesNotMatch(body, /ℹ️/);
  });

  it('keeps a note whose reason contains "; " whole', () => {
    const note = "CodeRabbit did not review 0123456789ab (a; b)";
    const body = fallbackBody("SonarCloud", note);
    assert.match(redLine(body), /not green: SonarCloud\. They/);
    assert.match(
      body,
      /^ℹ️ CodeRabbit did not review 0123456789ab \(a; b\) — not a failing check/m,
    );
  });

  it("leaves a plain red-check advisory unchanged and adds no note", () => {
    const body = fallbackBody("CodeRabbit", "");
    assert.match(redLine(body), /not green: CodeRabbit\. They/);
    assert.doesNotMatch(body, /ℹ️/);
  });

  it("adds neither line when both are empty, and tolerates a missing eighth argument", () => {
    assert.doesNotMatch(fallbackBody("", ""), /not green|ℹ️/);
    const dir = mkdtempSync(join(tmpdir(), "factory-cr-fallback-7-"));
    const bodyFile = join(dir, "body.md");
    try {
      const r = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -euo pipefail",
            "LOG_FILE=/dev/null",
            `gh() { local last=""; for last in "$@"; do :; done; printf "%s" "$last" > "${bodyFile}"; }`,
            extract("intest_fallback_comment"),
            `intest_fallback_comment 7 70 "" "" abc '{}'`,
          ].join("\n"),
        ],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(readFileSync(bodyFile, "utf8"), /ℹ️/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("intest_handoff carries the coverage note apart from advisory (real helpers)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const NOTE = "CodeRabbit did not review 0123456789ab (the CodeRabbit CLI review failed)";

  // Real intest_handoff + build_intest_bundle + factory-bundle.mjs; GitHub reads
  // and the fallback poster are stubbed. `promptFile` "" means the prompt is
  // missing, which is the first fallback path.
  function runHandoff({ dryRun, promptExists, note }) {
    const dir = mkdtempSync(join(tmpdir(), "factory-cr-handoff-"));
    const promptFile = join(dir, "prompt.md");
    if (promptExists) writeFileSync(promptFile, "prompt");
    const argsFile = join(dir, "fallback.args");
    const harness = [
      "set -euo pipefail",
      `SCRIPT_DIR="${scriptsDir}"`,
      "LOG_FILE=/dev/null",
      `REPO_ROOT="${dir}"`,
      `DRY_RUN=${dryRun}`,
      `INTEST_PROMPT_FILE="${promptFile}"`,
      'SUPPORT_ALLOWLIST="a@example.com"',
      'OAUTH_USER_EMAIL="support@example.com"',
      'PHASE="C"',
      'log() { echo "LOG: $*" >&2; }',
      `fetch_issue_record() { echo '{"number":7,"title":"t","body":"","labels":[]}'; }`,
      "fetch_issue_comments() { echo '[]'; }",
      "extract_plan_comment() { echo null; }",
      "gh() { :; }",
      "intest_record_comment_sha() { :; }",
      // One line per argument, so an empty or space-carrying argument is visible.
      `intest_fallback_comment() { printf '%s\\n' "$#" "$@" > "${argsFile}"; }`,
      extract("build_intest_bundle"),
      extract("intest_handoff"),
      `intest_handoff 7 70 '{"number":70,"url":"u","headRef":"h","state":"OPEN"}' "" "SonarCloud" ${SHA} "apps/web/a.ts" '{"web":true}' "" "$NOTE"`,
    ].join("\n");
    try {
      const r = spawnSync("bash", ["-c", harness], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NOTE: note },
      });
      let fallbackArgs = null;
      try {
        fallbackArgs = readFileSync(argsFile, "utf8").split("\n");
      } catch {
        fallbackArgs = null;
      }
      return { ...r, fallbackArgs };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("puts the note in bundle.crCoverageNote and leaves bundle.advisory as the checks", () => {
    const r = runHandoff({ dryRun: 1, promptExists: true, note: NOTE });
    assert.equal(r.status, 0, r.stderr);
    const bundle = JSON.parse(r.stdout);
    assert.equal(bundle.kind, "factory_intest");
    assert.equal(bundle.advisory, "SonarCloud");
    assert.equal(bundle.crCoverageNote, NOTE);
  });

  it("sends an empty crCoverageNote when there is no note", () => {
    const r = runHandoff({ dryRun: 1, promptExists: true, note: "" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).crCoverageNote, "");
  });

  it("hands the note to the fallback comment as its eighth argument", () => {
    const r = runHandoff({ dryRun: 0, promptExists: false, note: NOTE });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.fallbackArgs, "the missing-prompt path must post the fallback");
    const [argc, ...args] = r.fallbackArgs;
    assert.equal(argc, "8");
    assert.equal(args[3], "SonarCloud", "$4 stays the advisory check list");
    assert.equal(args[7], NOTE);
  });
});

describe("cr_coverage_note (real helper, stubbed node)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  function runNote(stub, sha = SHA) {
    const dir = mkdtempSync(join(tmpdir(), "factory-cr-note-"));
    const argsLog = join(dir, "args.log");
    const errLog = join(dir, "err.log");
    writeFileSync(argsLog, "");
    const harness = [
      "set -euo pipefail",
      'SCRIPT_DIR="/stub"',
      `LOG_FILE="${errLog}"`,
      'STATE_FILE="/state.json"',
      // log() writes to stdout, which is this helper's value; it must use logerr.
      'log() { echo "STDOUT-LOG: $*"; }',
      `logerr() { echo "$*" >> "${errLog}"; }`,
      `node() { echo "$*" >> "${argsLog}"; ${stub}; }`,
      extract("cr_coverage_note"),
      `NOTE=$(cr_coverage_note 7 "${sha}")`,
      'printf "NOTE=[%s]\\n" "$NOTE"',
    ].join("\n");
    try {
      const res = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
      const read = (f) => {
        try {
          return readFileSync(f, "utf8");
        } catch {
          return "";
        }
      };
      return {
        status: res.status,
        stdout: res.stdout,
        stderr: res.stderr,
        args: read(argsLog),
        err: read(errLog),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("prints the module's note and passes issue, sha and state file", () => {
    const r = runNote(`echo '{"note":"CodeRabbit did not review 0123456789ab (x)"}'`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "NOTE=[CodeRabbit did not review 0123456789ab (x)]\n");
    assert.match(
      r.args,
      new RegExp(`coderabbit-cli\\.mjs note --issue 7 --sha ${SHA} --state-file /state\\.json`),
    );
  });

  it("prints nothing for an empty note", () => {
    const r = runNote(`echo '{"note":""}'`);
    assert.equal(r.stdout, "NOTE=[]\n");
  });

  it("uses the module's last output line", () => {
    const r = runNote(`echo 'noise'; echo '{"note":"CodeRabbit did not review 0123456789ab (y)"}'`);
    assert.equal(r.stdout, "NOTE=[CodeRabbit did not review 0123456789ab (y)]\n");
  });

  it("never fails the caller: a crash is no note plus a log line, never stdout", () => {
    const r = runNote("return 3");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "NOTE=[]\n");
    assert.match(r.err, /WARNING: issue #7: CodeRabbit coverage note lookup failed/);
  });

  it("prints nothing for garbage or a non-string note", () => {
    for (const stub of [`echo 'garbage'`, `echo '{"note":42}'`, `echo '["x"]'`, `echo 'null'`]) {
      const r = runNote(stub);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "NOTE=[]\n", stub);
    }
  });

  it("does not ask the module about an empty head SHA", () => {
    const r = runNote(`echo '{"note":"x"}'`, "");
    assert.equal(r.stdout, "NOTE=[]\n");
    assert.equal(r.args, "");
  });
});

describe("cr_coverage_note against the real coderabbit-cli.mjs", () => {
  // Pins the wrapper to the module's actual `note` contract: a note only for the
  // recorded SHA and an uncovered kind, and never a state write.
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  function runReal(issues, sha = SHA) {
    const dir = mkdtempSync(join(tmpdir(), "factory-cr-note-real-"));
    const stateFile = join(dir, "factory-state.json");
    const contents = JSON.stringify({ issues });
    writeFileSync(stateFile, contents);
    const harness = [
      "set -euo pipefail",
      `SCRIPT_DIR="${scriptsDir}"`,
      "LOG_FILE=/dev/null",
      `STATE_FILE="${stateFile}"`,
      "logerr() { :; }",
      extract("cr_coverage_note"),
      `printf "NOTE=[%s]\\n" "$(cr_coverage_note 7 ${sha})"`,
    ].join("\n");
    try {
      const r = spawnSync("bash", ["-c", harness], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
      return { ...r, unchanged: readFileSync(stateFile, "utf8") === contents };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("rebuilds an uncovered SHA's note without touching state", () => {
    const r = runReal({ 7: { crCoverage: "budget", crCoverageSha: SHA } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^NOTE=\[CodeRabbit did not review 0123456789ab \(.+\)\]$/m);
    assert.ok(r.unchanged, "the note lookup must never write state");
  });

  it("gives no note for a covered SHA, another SHA, or an unknown card", () => {
    for (const [issues, sha] of [
      [{ 7: { crCoverage: "bot", crCoverageSha: SHA } }, SHA],
      [{ 7: { crCoverage: "budget", crCoverageSha: SHA } }, "f".repeat(40)],
      [{}, SHA],
    ]) {
      const r = runReal(issues, sha);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^NOTE=\[\]$/m, JSON.stringify(issues));
    }
  });
});

describe("watch_bound_thread_loop free pass (real helper, stubbed node)", () => {
  // `freePassStub` is the body of the stubbed `node coderabbit-cli.mjs free-pass`
  // call; stdin (the threads JSON) is captured to prove it was piped through.
  function runBound({ freePassStub, threadCount = 2, failing = 0 }) {
    const dir = mkdtempSync(join(tmpdir(), "factory-cr-bound-"));
    const callsLog = join(dir, "calls.log");
    const stdinLog = join(dir, "stdin.log");
    writeFileSync(callsLog, "");
    try {
      const harness = [
        "set -euo pipefail",
        'SCRIPT_DIR="/stub"',
        "LOG_FILE=/dev/null",
        'STATE_FILE="/state.json"',
        "ISSUE_NUM=7",
        `THREAD_COUNT=${threadCount}`,
        `FAILING=${failing}`,
        `REVIEW_THREADS='[{"id":"T1"},{"id":"T2"}]'`,
        `CALLS_LOG="${callsLog}"`,
        `STDIN_LOG="${stdinLog}"`,
        'log() { echo "LOG: $*"; }',
        "node() {",
        '  echo "$*" >> "$CALLS_LOG"',
        '  case "$*" in',
        `    *coderabbit-cli.mjs\\ free-pass*) cat > "$STDIN_LOG"; ${freePassStub} ;;`,
        "    *state-cli.mjs*) : ;;",
        "  esac",
        "}",
        extract("watch_bound_thread_loop"),
        "watch_bound_thread_loop",
        'echo "AFTER"',
      ].join("\n");
      const res = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
      const calls = readFileSync(callsLog, "utf8");
      let stdin = "";
      try {
        stdin = readFileSync(stdinLog, "utf8");
      } catch {
        stdin = "";
      }
      return { status: res.status, stdout: res.stdout, stderr: res.stderr, calls, stdin };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const bumps = (calls) => (calls.match(/factory:bump-attempts 7/g) || []).length;

  it("an exempt pass spends no attempt", () => {
    const r = runBound({ freePassStub: `echo '{"exempt":true}'` });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(bumps(r.calls), 0);
    assert.match(r.stdout, /free pass, no attempt spent/);
    assert.match(r.calls, /coderabbit-cli\.mjs free-pass --issue 7 --state-file \/state\.json/);
    assert.equal(r.stdin.trim(), '[{"id":"T1"},{"id":"T2"}]', "threads must be piped on stdin");
  });

  it("a non-exempt pass spends exactly one attempt", () => {
    const r = runBound({ freePassStub: `echo '{"exempt":false}'` });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(bumps(r.calls), 1);
    assert.match(r.stdout, /AFTER/);
  });

  it("a failing free-pass check spends the attempt (fails closed on the budget)", () => {
    const r = runBound({ freePassStub: `echo '{"exempt":true}'; return 1` });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(bumps(r.calls), 1);
  });

  it("does nothing at all when CI is failing or no threads are open", () => {
    for (const opts of [{ failing: 1 }, { threadCount: 0 }]) {
      const r = runBound({ freePassStub: `echo '{"exempt":true}'`, ...opts });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.calls, "", `no node call expected for ${JSON.stringify(opts)}`);
    }
  });
});
