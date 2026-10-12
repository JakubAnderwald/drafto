import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

// The Greptile review hold's bash wiring (ADR-0047). The decisions live in
// scripts/lib/greptile-review.mjs and the GitHub reads in greptile-gate.mjs;
// what factory-agent.sh must guarantee is narrower and is what these tests lock in:
//   1. the hold is off by default and its knobs are validated before export;
//   2. the gate sits after the CodeRabbit lane and before the In Test promotion,
//      runs only with the switch on, holds only on an explicit "hold", fails
//      OPEN with a "status unknown" note, and never holds a dry run;
//   3. the Greptile helpers never pause the factory and never touch state;
//   4. the Greptile note travels to the In Test hand-off as its own last
//      argument (never joined into the advisory checks or the CodeRabbit note),
//      at both promotion sites and when the In Test sweep re-writes a scenario,
//      and is rendered on its own line.
//
// Two layers, matching factory-agent-cr-cli.test.mjs: static lock-ins over the
// script source, and the real helpers run in bash with node / gh stubbed.

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

const sweepBlock = (() => {
  const start = script.indexOf("# ── In Test feedback sweep");
  assert.ok(start !== -1, "could not locate the In Test sweep");
  const end = script.indexOf("# ── --release mode", start);
  assert.ok(end !== -1, "could not locate the end of the In Test sweep");
  return script.slice(start, end);
})();

function extract(name) {
  const fn = script.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "m"));
  assert.ok(fn, `could not extract ${name}`);
  return fn[0];
}

function readOr(file, fallback = "") {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const GATE_ERROR_NOTE = "Greptile review status of PR #70 unknown (gate error)";
const EXPIRED_NOTE = "Greptile did not review PR #70 (no review within 30 min of the PR opening)";

describe("factory-agent.sh Greptile hold: static wiring", () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  it("is off by default and declares the hold knob with its default", () => {
    assert.match(script, /FACTORY_GREPTILE_GATE="\$\{FACTORY_GREPTILE_GATE:-0\}"/);
    assert.match(script, /FACTORY_GREPTILE_HOLD_MAX_MIN="\$\{FACTORY_GREPTILE_HOLD_MAX_MIN:-30\}"/);
    assert.match(script, /^export FACTORY_GREPTILE_GATE FACTORY_GREPTILE_HOLD_MAX_MIN$/m);
  });

  describe("validates the knobs under the Mac mini's bash 3.2 before exporting them", () => {
    const block = script.match(
      /FACTORY_GREPTILE_GATE="\$\{FACTORY_GREPTILE_GATE:-0\}"[\s\S]*?\nexport FACTORY_GREPTILE_GATE FACTORY_GREPTILE_HOLD_MAX_MIN\n/,
    );

    function runKnobs(knobs) {
      assert.ok(block, "knob block not found");
      return spawnSync(
        "/bin/bash",
        ["-c", `set -euo pipefail\n${block[0]}\nenv | grep '^FACTORY_GREPTILE_' | sort`],
        { encoding: "utf8", env: { PATH: process.env.PATH, ...knobs } },
      );
    }

    it("exports both defaults, silently, when nothing is set", () => {
      const r = runKnobs({});
      assert.equal(r.status, 0, r.stderr);
      // `env` is a child process, so this also proves both are exported:
      // greptile-gate.mjs reads the hold knob from its environment.
      assert.equal(r.stdout, "FACTORY_GREPTILE_GATE=0\nFACTORY_GREPTILE_HOLD_MAX_MIN=30\n");
      assert.equal(r.stderr, "");
    });

    it("falls back to off on a non-0/1 switch, with a WARNING", () => {
      for (const value of ["yes", "true", "2", " 1"]) {
        const r = runKnobs({ FACTORY_GREPTILE_GATE: value });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /^FACTORY_GREPTILE_GATE=0$/m, `switch '${value}'`);
        assert.ok(
          r.stderr.includes(`WARNING: invalid FACTORY_GREPTILE_GATE='${value}'; defaulting to 0`),
          r.stderr,
        );
      }
    });

    it("keeps an explicit on", () => {
      const r = runKnobs({ FACTORY_GREPTILE_GATE: "1" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^FACTORY_GREPTILE_GATE=1$/m);
      assert.equal(r.stderr, "");
    });

    it("falls back to 30 on a hold that is garbage, zero, over a day, or overflows", () => {
      // 0 would disable the hold and a huge number would make it unbounded; the
      // last one would overflow bash arithmetic if it ever reached `(( ))`.
      for (const value of ["abc", "0", "1441", "99999999999999999999", "-5", "30m"]) {
        const r = runKnobs({ FACTORY_GREPTILE_HOLD_MAX_MIN: value });
        assert.equal(r.status, 0, `${value}: ${r.stderr}`);
        assert.match(r.stdout, /^FACTORY_GREPTILE_HOLD_MAX_MIN=30$/m, `hold '${value}'`);
        assert.ok(
          r.stderr.includes(
            `WARNING: invalid FACTORY_GREPTILE_HOLD_MAX_MIN='${value}'; defaulting to 30`,
          ),
          r.stderr,
        );
      }
    });

    it("keeps a valid hold override, up to the one-day cap", () => {
      for (const value of ["1", "45", "1440"]) {
        const r = runKnobs({ FACTORY_GREPTILE_HOLD_MAX_MIN: value });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, new RegExp(`^FACTORY_GREPTILE_HOLD_MAX_MIN=${value}$`, "m"));
        assert.equal(r.stderr, "", `hold '${value}' must not warn`);
      }
    });
  });

  it("holds after the CodeRabbit lane and before the In Test promotion", () => {
    const crGateIdx = watchBlock.indexOf('cr_lane_gate "$ISSUE_NUM" "$PR_NUM" "$HEAD_SHA"');
    const gateIdx = watchBlock.indexOf('greptile_gate "$ISSUE_NUM" "$PR_NUM"');
    const promoteIdx = watchBlock.indexOf(') → In Test"');
    assert.ok(crGateIdx !== -1 && gateIdx !== -1 && promoteIdx !== -1);
    assert.ok(crGateIdx < gateIdx && gateIdx < promoteIdx, "CodeRabbit lane → Greptile → In Test");
    // The note is reset before the switch is read, so a switched-off gate hands
    // off an empty note rather than one left over from another card.
    assert.match(
      watchBlock,
      /GREPTILE_NOTE=""\n\s*if \[\[ "\$\{FACTORY_GREPTILE_GATE:-0\}" == "1" \]\]; then\n\s*if ! greptile_gate "\$ISSUE_NUM" "\$PR_NUM"; then\n\s*continue\n\s*fi\n\s*fi\n/,
      "a hold must `continue` and the gate must only run with the switch on",
    );
  });

  it("never calls the Greptile helpers outside their switch", () => {
    // One call site each, both inside the FACTORY_GREPTILE_GATE == "1" blocks
    // pinned here and in the sweep test below: with the switch off, nothing
    // reaches GitHub on Greptile's behalf.
    assert.equal((script.match(/\bgreptile_gate "/g) || []).length, 1);
    assert.equal((script.match(/\bgreptile_note_for_pr "/g) || []).length, 1);
  });

  it("passes GREPTILE_NOTE as the last intest_handoff argument at both promotion sites", () => {
    const promotion = watchBlock.slice(watchBlock.indexOf(') → In Test"'));
    const handoffs = promotion.match(/intest_handoff [^\n]*/g) || [];
    assert.equal(handoffs.length, 2, "dry-run and live promotion must both hand off");
    for (const call of handoffs) {
      assert.match(
        call,
        /"\$INTEST_BETA" "\$CR_NOTE" "\$GREPTILE_NOTE" \|\| true$/,
        "the note must be the eleventh argument, after the CodeRabbit note",
      );
      assert.doesNotMatch(call, /"\$ADVISORY[^"]*\$GREPTILE_NOTE/);
      assert.doesNotMatch(call, /"\$CR_NOTE[^"]*\$GREPTILE_NOTE/);
    }
    // Never folded into the advisory check list or the CodeRabbit note anywhere:
    // Greptile is neither a failing check nor CodeRabbit coverage.
    assert.doesNotMatch(script, /ADVISORY=[^\n]*GREPTILE_NOTE/);
    assert.doesNotMatch(script, /CR_NOTE=[^\n]*GREPTILE_NOTE/);
    assert.doesNotMatch(script, /\badvisory="[^"\n]*greptile/);
  });

  it("re-asks GitHub for the note, only with the switch on, when the sweep re-writes a scenario", () => {
    const staleIdx = sweepBlock.indexOf('"$INTEST_HEAD_SHA" != "$SCENARIO_SHA"');
    const noteIdx = sweepBlock.indexOf(
      'INTEST_GREPTILE_NOTE=$(greptile_note_for_pr "$INTEST_PR_NUM")',
    );
    const handoffIdx = sweepBlock.indexOf("intest_handoff ");
    assert.ok(staleIdx !== -1 && noteIdx !== -1 && handoffIdx !== -1);
    assert.ok(staleIdx < noteIdx && noteIdx < handoffIdx, "note is looked up only for a re-write");
    assert.match(
      sweepBlock,
      /INTEST_GREPTILE_NOTE=""\n\s*if \[\[ "\$\{FACTORY_GREPTILE_GATE:-0\}" == "1" \]\]; then\n\s*INTEST_GREPTILE_NOTE=\$\(greptile_note_for_pr "\$INTEST_PR_NUM"\)\n\s*fi\n/,
      "the lookup must only run with the switch on, and default to no note",
    );
    assert.match(
      sweepBlock.slice(handoffIdx),
      /^intest_handoff [\s\S]*?"\$INTEST_BETA" "\$INTEST_CR_NOTE" "\$INTEST_GREPTILE_NOTE" \|\| true/,
    );
  });

  it("never pauses the factory or touches state from the Greptile helpers", () => {
    // The hold is stateless by design (greptile-gate.mjs reads only GitHub and
    // the clock), and an optional second reviewer is never worth a factory pause.
    const names = [...script.matchAll(/^(greptile_[a-z_]+)\(\) \{/gm)].map((m) => m[1]);
    assert.deepEqual(names.slice().sort(), ["greptile_gate", "greptile_note_for_pr"]);
    for (const name of names) {
      const fn = extract(name);
      assert.doesNotMatch(fn, /factory:pause|pause_for_session_limit/, `${name} must not pause`);
      assert.doesNotMatch(fn, /state-cli|--state-file|STATE_FILE/, `${name} must not touch state`);
    }
  });
});

describe("greptile_gate (real helper, stubbed node)", () => {
  // `gateStub` is the body of the stubbed `node greptile-gate.mjs gate` call;
  // `threadsStub` the body of the stubbed fetch_review_threads re-read.
  function runGate(gateStub, { dryRun = 0, threadsStub = "echo '[]'" } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "factory-greptile-gate-"));
    const argsLog = join(dir, "args.log");
    const threadsLog = join(dir, "threads.log");
    try {
      const harness = [
        "set -euo pipefail",
        'SCRIPT_DIR="/stub"',
        "LOG_FILE=/dev/null",
        `DRY_RUN=${dryRun}`,
        `ARGS_LOG="${argsLog}"`,
        'log() { echo "LOG: $*" >&2; }',
        "node() {",
        '  echo "$*" >> "$ARGS_LOG"',
        `  ${gateStub}`,
        "}",
        "fetch_review_threads() {",
        `  echo "$*" >> "${threadsLog}"`,
        `  ${threadsStub}`,
        "}",
        extract("greptile_gate"),
        // A note left over from another card must never survive into this one.
        'GREPTILE_NOTE="stale note from another card"',
        "if greptile_gate 7 70; then rc=0; else rc=$?; fi",
        'echo "RC=$rc NOTE=$GREPTILE_NOTE"',
      ].join("\n");
      const res = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
      return {
        status: res.status,
        stdout: res.stdout,
        stderr: res.stderr,
        args: readOr(argsLog),
        threadReads: readOr(threadsLog),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("returns 1 (hold) on an explicit hold, with no note", () => {
    const r = runGate(
      `echo '{"action":"hold","reason":"greptile-wait","activity":"absent","note":""}'`,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^RC=1 NOTE=$/m);
    assert.match(r.stderr, /Issue #7: Greptile gate → hold \(greptile-wait\)/);
    // Only the PR: one review per PR, so no head SHA and no state file.
    assert.equal(r.args, "/stub/lib/greptile-gate.mjs gate --pr 70\n");
  });

  it("returns 0 (promote) and exposes the module's note", () => {
    const r = runGate(
      `echo '{"action":"promote","reason":"greptile-hold-expired","activity":"absent","note":"${EXPIRED_NOTE}"}'`,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `RC=0 NOTE=${EXPIRED_NOTE}\n`);
    assert.match(r.stderr, /Greptile gate → promote \(greptile-hold-expired\)/);
  });

  it("promotes a reviewed PR with no note", () => {
    const r = runGate(
      `echo '{"action":"promote","reason":"greptile-reviewed","activity":"reviewed","note":""}'`,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^RC=0 NOTE=$/m, "only an unreviewed promotion carries a note");
  });

  // The review can land between this tick's thread read and the gate's own read.
  // Promoting then would send the card to In Test with threads the fix loop never
  // saw, and --release would bounce it back after the tester approved it.
  describe("re-reads the threads when it promotes on a fresh review", () => {
    const REVIEWED = `echo '{"action":"promote","reason":"greptile-reviewed","activity":"reviewed","note":""}'`;

    it("holds for the fix loop when the review left open threads", () => {
      const r = runGate(REVIEWED, { threadsStub: `echo '[{"id":"T1"},{"id":"T2"}]'` });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^RC=1 /m);
      assert.equal(r.threadReads, "70\n", "re-reads this PR's threads exactly once");
      assert.match(r.stderr, /left 2 open thread\(s\) after this tick read them; holding/);
    });

    it("promotes when no thread is open", () => {
      const r = runGate(REVIEWED);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^RC=0 NOTE=$/m);
      assert.equal(r.threadReads, "70\n");
    });

    it("promotes when the re-read fails or prints garbage (fail open)", () => {
      for (const threadsStub of ["return 1", "echo 'not json'", ":"]) {
        const r = runGate(REVIEWED, { threadsStub });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /^RC=0 NOTE=$/m, threadsStub);
      }
    });

    it("does not re-read for any other promotion, or in a dry run", () => {
      const expired = runGate(
        `echo '{"action":"promote","reason":"greptile-hold-expired","note":"${EXPIRED_NOTE}"}'`,
        { threadsStub: `echo '[{"id":"T1"}]'` },
      );
      assert.equal(expired.stdout, `RC=0 NOTE=${EXPIRED_NOTE}\n`);
      assert.equal(expired.threadReads, "", "only a fresh review can have brought new threads");
      const dry = runGate(REVIEWED, { dryRun: 1, threadsStub: `echo '[{"id":"T1"}]'` });
      assert.match(dry.stdout, /^RC=0 /m, "a dry run never holds");
      assert.equal(dry.threadReads, "");
    });
  });

  it("uses the last line when the module prints more than one", () => {
    const r = runGate(`echo 'noise'; echo '{"action":"hold","reason":"greptile-unreadable"}'`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^RC=1 /m);
  });

  // A fail-open promotion is a PR nobody knows Greptile looked at, so it carries
  // the same note greptile-gate.mjs returns when its own gate throws.
  it("fails open on unusable output, with a status-unknown note", () => {
    for (const stub of [`echo 'not json at all'`, ":", `echo 'null'`, `echo '[]'`]) {
      const r = runGate(stub);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `RC=0 NOTE=${GATE_ERROR_NOTE}\n`, stub);
      assert.match(r.stderr, /no usable decision; promoting \(fail open\)/);
    }
  });

  it("fails open on an unknown action, with a status-unknown note", () => {
    const r = runGate(`echo '{"action":"wait","reason":"greptile-wait","note":"x"}'`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `RC=0 NOTE=${GATE_ERROR_NOTE}\n`);
  });

  it("fails open when the module crashes, with a status-unknown note", () => {
    const r = runGate("return 1");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `RC=0 NOTE=${GATE_ERROR_NOTE}\n`);
    assert.match(r.stderr, /Greptile gate failed; promoting without it \(fail open\)/);
  });

  it("never holds a dry run", () => {
    const r = runGate(`echo '{"action":"hold","reason":"greptile-wait","note":""}'`, {
      dryRun: 1,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^RC=0 NOTE=$/m);
    assert.match(r.stderr, /DRY-RUN: Greptile gate would hold #7 \(greptile-wait\); promoting/);
  });

  it("drops a note that is not a string", () => {
    for (const note of ["42", "null", '["x"]', '{"text":"x"}']) {
      const r = runGate(
        `echo '{"action":"promote","reason":"greptile-hold-expired","note":${note}}'`,
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "RC=0 NOTE=\n", `note ${note}`);
    }
  });
});

describe("greptile_note_for_pr (real helper, stubbed node)", () => {
  function runNote(stub, pr = "70") {
    const dir = mkdtempSync(join(tmpdir(), "factory-greptile-note-"));
    const argsLog = join(dir, "args.log");
    const errLog = join(dir, "err.log");
    writeFileSync(argsLog, "");
    const harness = [
      "set -euo pipefail",
      'SCRIPT_DIR="/stub"',
      `LOG_FILE="${errLog}"`,
      // log() writes to stdout, which is this helper's value; it must use logerr.
      'log() { echo "STDOUT-LOG: $*"; }',
      `logerr() { echo "$*" >> "${errLog}"; }`,
      `node() { echo "$*" >> "${argsLog}"; ${stub}; }`,
      extract("greptile_note_for_pr"),
      `NOTE=$(greptile_note_for_pr "${pr}")`,
      'printf "NOTE=[%s]\\n" "$NOTE"',
    ].join("\n");
    try {
      const res = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
      return {
        status: res.status,
        stdout: res.stdout,
        stderr: res.stderr,
        args: readOr(argsLog),
        err: readOr(errLog),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("prints the module's note and asks only about the PR", () => {
    const r = runNote(`echo '{"note":"${EXPIRED_NOTE}"}'`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `NOTE=[${EXPIRED_NOTE}]\n`);
    assert.equal(r.args, "/stub/lib/greptile-gate.mjs note --pr 70\n");
  });

  it("prints nothing for an empty note", () => {
    const r = runNote(`echo '{"note":""}'`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "NOTE=[]\n");
  });

  it("uses the module's last output line", () => {
    const r = runNote(`echo 'noise'; echo '{"note":"Greptile has not reviewed PR #70 yet"}'`);
    assert.equal(r.stdout, "NOTE=[Greptile has not reviewed PR #70 yet]\n");
  });

  it("never fails the caller: a crash is no note plus a log line, never stdout", () => {
    const r = runNote("return 3");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "NOTE=[]\n");
    assert.match(r.err, /WARNING: PR #70: Greptile note lookup failed/);
  });

  it("prints nothing for garbage or a non-string note", () => {
    for (const stub of [
      `echo 'garbage'`,
      `echo '{"note":42}'`,
      `echo '{"note":null}'`,
      `echo '["x"]'`,
      `echo 'null'`,
      ":",
    ]) {
      const r = runNote(stub);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "NOTE=[]\n", stub);
    }
  });

  it("does not ask the module about an empty PR number", () => {
    const r = runNote(`echo '{"note":"x"}'`, "");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "NOTE=[]\n");
    assert.equal(r.args, "");
  });
});

describe("greptile_gate and greptile_note_for_pr against the real greptile-gate.mjs", () => {
  // Pins the wrappers to the module's actual output contract rather than to a
  // stub of it. `gh` is a PATH shim answering the three REST reads, so nothing
  // reaches GitHub; the module reads the hold knob from the exported env.
  const GREPTILE_REVIEW = [
    {
      user: { login: "greptile-apps[bot]", type: "Bot" },
      state: "COMMENTED",
      body: "<h3>Greptile Summary</h3>\n2 files reviewed, 1 comment",
    },
  ];

  function runReal({ fn, createdMinAgo, reviews = [], ghFails = false, holdMaxMin }) {
    const dir = mkdtempSync(join(tmpdir(), "factory-greptile-real-"));
    const ghShim = join(dir, "gh");
    writeFileSync(
      ghShim,
      [
        "#!/bin/bash",
        '[[ "${GH_FAIL:-0}" == "1" ]] && exit 1',
        'case "$*" in',
        '  *"/pulls/70/reviews"*) printf "%s" "$GH_REVIEWS" ;;',
        '  *"/issues/70/comments"*) printf "%s" "[[]]" ;;',
        '  *"/pulls/70") printf "%s" "$GH_PR" ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const call =
      fn === "gate"
        ? 'if greptile_gate 7 70; then rc=0; else rc=$?; fi; echo "RC=$rc NOTE=$GREPTILE_NOTE"'
        : 'printf "NOTE=[%s]\\n" "$(greptile_note_for_pr 70)"';
    const harness = [
      "set -euo pipefail",
      `SCRIPT_DIR="${scriptsDir}"`,
      "LOG_FILE=/dev/null",
      "DRY_RUN=0",
      'log() { echo "LOG: $*" >&2; }',
      "logerr() { :; }",
      // The post-review thread re-read is GraphQL, not one of the REST reads the
      // shim answers; covered by the stubbed-node tests above.
      "fetch_review_threads() { echo '[]'; }",
      extract("greptile_gate"),
      extract("greptile_note_for_pr"),
      call,
    ].join("\n");
    const createdAt = new Date(Date.now() - createdMinAgo * 60_000).toISOString();
    try {
      return spawnSync("bash", ["-c", harness], {
        encoding: "utf8",
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          HOME: process.env.HOME,
          GH_FAIL: ghFails ? "1" : "0",
          GH_PR: JSON.stringify({ number: 70, created_at: createdAt }),
          GH_REVIEWS: JSON.stringify([reviews]),
          ...(holdMaxMin ? { FACTORY_GREPTILE_HOLD_MAX_MIN: holdMaxMin } : {}),
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("holds a fresh PR Greptile has not reviewed yet", () => {
    const r = runReal({ fn: "gate", createdMinAgo: 2 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^RC=1 NOTE=$/m);
    assert.match(r.stderr, /Greptile gate → hold \(greptile-wait\)/);
  });

  it("promotes a reviewed PR with no note", () => {
    const r = runReal({ fn: "gate", createdMinAgo: 2, reviews: GREPTILE_REVIEW });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^RC=0 NOTE=$/m);
    assert.match(r.stderr, /Greptile gate → promote \(greptile-reviewed\)/);
  });

  it("promotes with the did-not-review note once the hold has run out", () => {
    const r = runReal({ fn: "gate", createdMinAgo: 180 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `RC=0 NOTE=${EXPIRED_NOTE}\n`);
  });

  it("reads the exported hold knob", () => {
    const r = runReal({ fn: "gate", createdMinAgo: 180, holdMaxMin: "240" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^RC=1 NOTE=$/m, "a 4-hour hold must still hold a 3-hour-old PR");
  });

  it("promotes with a status-unknown note when GitHub cannot be read", () => {
    const r = runReal({ fn: "gate", createdMinAgo: 2, ghFails: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      "RC=0 NOTE=Greptile review status of PR #70 unknown (its reviews could not be read)\n",
    );
  });

  it("gives the In Test note: pending, cleared by a review, or expired", () => {
    const pending = runReal({ fn: "note", createdMinAgo: 2 });
    assert.equal(pending.status, 0, pending.stderr);
    assert.equal(pending.stdout, "NOTE=[Greptile has not reviewed PR #70 yet]\n");
    const reviewed = runReal({ fn: "note", createdMinAgo: 180, reviews: GREPTILE_REVIEW });
    assert.equal(reviewed.stdout, "NOTE=[]\n", "a review that landed since clears the note");
    const expired = runReal({ fn: "note", createdMinAgo: 180 });
    assert.equal(expired.stdout, `NOTE=[${EXPIRED_NOTE}]\n`);
  });
});

describe("intest_fallback_comment Greptile note (real helper, stubbed gh)", () => {
  // The Greptile note is the ninth argument; $advisory is only ever the red-check
  // list and $8 the CodeRabbit note. `withGreptileArg: false` calls with eight.
  function fallbackBody({ advisory = "", crNote = "", greptileNote = "" } = {}, opts = {}) {
    const { withGreptileArg = true } = opts;
    const dir = mkdtempSync(join(tmpdir(), "factory-greptile-fallback-"));
    const bodyFile = join(dir, "body.md");
    const call =
      `intest_fallback_comment 7 70 "" "$ADVISORY" ${SHA} '{"web":false,"mobile":false,"desktop":false}' "" "$CR_NOTE"` +
      (withGreptileArg ? ' "$GREPTILE_NOTE"' : "");
    const harness = [
      "set -euo pipefail",
      "LOG_FILE=/dev/null",
      `BODY_FILE="${bodyFile}"`,
      // Capture the --body value: the last argument.
      'gh() { local last=""; for last in "$@"; do :; done; printf "%s" "$last" > "$BODY_FILE"; }',
      extract("intest_fallback_comment"),
      call,
    ].join("\n");
    try {
      const r = spawnSync("bash", ["-c", harness], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          ADVISORY: advisory,
          CR_NOTE: crNote,
          GREPTILE_NOTE: greptileNote,
        },
      });
      assert.equal(r.status, 0, r.stderr);
      return readFileSync(bodyFile, "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const CR_NOTE = "CodeRabbit did not review 0123456789ab (the CodeRabbit CLI review failed)";
  const esc = (s) => s.replace(/[()]/g, "\\$&");
  const redLine = (body) => body.split("\n").find((l) => l.includes("not green")) ?? "";
  const noteLines = (body) => body.split("\n").filter((l) => l.startsWith("ℹ️ "));
  const greptileLine = (note) =>
    `ℹ️ ${note} — not a failing check: Greptile is an optional second reviewer, so this only means one fewer automated look at the PR.`;

  it("renders the note on its own line, as a note rather than a failing check", () => {
    const body = fallbackBody({ greptileNote: EXPIRED_NOTE });
    assert.doesNotMatch(body, /not green/);
    assert.deepEqual(noteLines(body), [greptileLine(EXPIRED_NOTE)]);
  });

  it("puts it after the CodeRabbit line, each on its own line, and never in the red-check line", () => {
    const body = fallbackBody({
      advisory: "CodeRabbit, SonarCloud",
      crNote: CR_NOTE,
      greptileNote: EXPIRED_NOTE,
    });
    assert.equal(
      redLine(body),
      "⚠️ Advisory (non-required) checks are not green: CodeRabbit, SonarCloud. They don't block the merge, but are worth a glance before Approving.",
    );
    const lines = noteLines(body);
    assert.equal(lines.length, 2);
    assert.match(lines[0], new RegExp(`^ℹ️ ${esc(CR_NOTE)} — not a failing check: this commit`));
    assert.equal(lines[1], greptileLine(EXPIRED_NOTE));
    assert.ok(body.indexOf("not green") < body.indexOf(lines[0]));
    assert.ok(body.indexOf(lines[0]) < body.indexOf(lines[1]));
  });

  it("renders the status-unknown note the same way, apart from the reds", () => {
    const body = fallbackBody({ advisory: "SonarCloud", greptileNote: GATE_ERROR_NOTE });
    assert.match(redLine(body), /not green: SonarCloud\. They/);
    assert.doesNotMatch(redLine(body), /Greptile/);
    assert.deepEqual(noteLines(body), [greptileLine(GATE_ERROR_NOTE)]);
  });

  it("adds no Greptile line when the ninth argument is empty", () => {
    const body = fallbackBody({ advisory: "SonarCloud", crNote: CR_NOTE });
    assert.doesNotMatch(body, /Greptile/);
    assert.equal(noteLines(body).length, 1, "the CodeRabbit line stays");
  });

  it("tolerates a missing ninth argument (an eight-argument caller)", () => {
    const body = fallbackBody(
      { crNote: CR_NOTE, greptileNote: EXPIRED_NOTE },
      { withGreptileArg: false },
    );
    assert.doesNotMatch(body, /Greptile/);
    assert.equal(noteLines(body).length, 1);
  });
});

describe("intest_handoff carries the Greptile note apart from advisory (real helpers)", () => {
  const CR_NOTE = "CodeRabbit did not review 0123456789ab (the CodeRabbit CLI review failed)";

  // Real intest_handoff + build_intest_bundle + factory-bundle.mjs; GitHub reads
  // and the fallback poster are stubbed. A missing prompt is the first fallback
  // path.
  function runHandoff({ dryRun, promptExists, crNote, greptileNote }) {
    const dir = mkdtempSync(join(tmpdir(), "factory-greptile-handoff-"));
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
      `intest_handoff 7 70 '{"number":70,"url":"u","headRef":"h","state":"OPEN"}' "" "SonarCloud" ${SHA} "apps/web/a.ts" '{"web":true}' "" "$CR_NOTE" "$GREPTILE_NOTE"`,
    ].join("\n");
    try {
      const r = spawnSync("bash", ["-c", harness], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CR_NOTE: crNote,
          GREPTILE_NOTE: greptileNote,
        },
      });
      const raw = readOr(argsFile, null);
      return { ...r, fallbackArgs: raw === null ? null : raw.split("\n") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("puts the note in bundle.greptileNote, apart from advisory and crCoverageNote", () => {
    const r = runHandoff({
      dryRun: 1,
      promptExists: true,
      crNote: CR_NOTE,
      greptileNote: EXPIRED_NOTE,
    });
    assert.equal(r.status, 0, r.stderr);
    const bundle = JSON.parse(r.stdout);
    assert.equal(bundle.kind, "factory_intest");
    assert.equal(bundle.greptileNote, EXPIRED_NOTE);
    assert.equal(bundle.advisory, "SonarCloud", "advisory stays the check list");
    assert.equal(bundle.crCoverageNote, CR_NOTE, "crCoverageNote stays the CodeRabbit note");
  });

  it("sends an empty greptileNote when there is no note", () => {
    const r = runHandoff({ dryRun: 1, promptExists: true, crNote: CR_NOTE, greptileNote: "" });
    assert.equal(r.status, 0, r.stderr);
    const bundle = JSON.parse(r.stdout);
    assert.equal(bundle.greptileNote, "");
    assert.equal(bundle.crCoverageNote, CR_NOTE);
  });

  it("hands the note to the fallback comment as its ninth argument", () => {
    const r = runHandoff({
      dryRun: 0,
      promptExists: false,
      crNote: CR_NOTE,
      greptileNote: EXPIRED_NOTE,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.fallbackArgs, "the missing-prompt path must post the fallback");
    const [argc, ...args] = r.fallbackArgs;
    assert.equal(argc, "9");
    assert.equal(args[3], "SonarCloud", "$4 stays the advisory check list");
    assert.equal(args[7], CR_NOTE, "$8 stays the CodeRabbit note");
    assert.equal(args[8], EXPIRED_NOTE);
  });
});
