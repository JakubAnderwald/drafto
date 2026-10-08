import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Guards the fix for the recurring "card blocked because CodeRabbit couldn't
// review" failure: --watch and --release must gate on branch-protection
// *required* contexts only, so an advisory bot's red (or its "Review rate
// limited" status) can never trigger the fix loop, block the In Test advance,
// or block the merge. See docs/operations/factory-runbook.md.

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "factory-agent.sh");
const script = readFileSync(scriptPath, "utf8");

describe("factory-agent required-context gating: static wiring", () => {
  it("defines the required-context helpers", () => {
    assert.match(script, /^fetch_required_contexts\(\) \{/m);
    assert.match(script, /^pr_failing_required\(\) \{/m);
    assert.match(script, /^pr_pending_required\(\) \{/m);
    assert.match(script, /^pr_failing_advisory\(\) \{/m);
    assert.match(script, /^pr_failing_required_checks\(\) \{/m);
    assert.match(script, /^pr_failing_required_summary\(\) \{/m);
    assert.match(script, /^classify_failing_required\(\) \{/m);
    assert.match(script, /^pr_infra_rerun_ids\(\) \{/m);
    assert.match(script, /^rerun_infra_failures\(\) \{/m);
    assert.match(script, /^comment_ci_infra_hold\(\) \{/m);
    assert.match(script, /^recover_cancelled_ci\(\) \{/m);
  });

  it("fetches the required contexts in BOTH --watch and --release", () => {
    const calls = script.match(/^ {2}fetch_required_contexts$/gm) || [];
    assert.ok(calls.length >= 2, "fetch_required_contexts must run in watch and release");
  });

  it("--watch gates FAILING/PENDING on the required-only helpers", () => {
    assert.match(script, /FAILING=\$\(pr_failing_required "\$PR_VIEW"\)/);
    assert.match(script, /PENDING=\$\(pr_pending_required "\$PR_VIEW"\)/);
  });

  it("--watch advance verifies required-green (not just no-failures) before In Test", () => {
    // Scope to the advance block: from the required-only FAILING assignment to
    // the "→ In Test" log. ci_required_green must gate the advance so a missing
    // required context can't slip through, while advisory reds are ignored.
    const block = script.match(
      /FAILING=\$\(pr_failing_required "\$PR_VIEW"\)[\s\S]*?required CI green \(platforms/,
    );
    assert.ok(block, "watch advance block not found");
    assert.match(block[0], /if ! ci_required_green "\$PR_VIEW"; then/);
  });

  // The #654 failure: three required checks GitHub cancelled (no runner) parked
  // the card in Approved for ~2.5 days with nothing but a log line every tick.
  describe("--release CI gate never parks silently (#654)", () => {
    const block = script.match(
      /A failing \*required\* check never parks the card silently[\s\S]*?transition_status "\$ITEM_ID" "\$ISSUE_NUM" "In Review" \|\| true\n {6}continue\n {4}fi/,
    );

    it("finds the gate, gating on the required-only failing count", () => {
      assert.ok(block, "release CI gate block not found");
      assert.match(block[0], /FAILING=\$\(pr_failing_required "\$PR_VIEW"\)/);
    });

    it("an unknown required set keeps the old wait-in-Approved (advisory reds can't regress a card)", () => {
      const unknownAt = block[0].search(/"\$\{REQUIRED_CONTEXTS_JSON:-\[\]\}" == "\[\]"/);
      const classifyAt = block[0].search(/classify_failing_required/);
      assert.ok(
        unknownAt > 0 && unknownAt < classifyAt,
        "required-set guard must precede classification",
      );
    });

    it("never classifies without a head SHA (the markers key on it)", () => {
      const guardAt = block[0].search(
        /if \[\[ -z "\$HEAD_SHA" \]\]; then\n[^\n]*; continue\n\s*fi/,
      );
      assert.ok(guardAt > 0, "empty-head-SHA guard not found");
      assert.ok(
        guardAt < block[0].search(/classify_failing_required/),
        "guard must precede classification",
      );
    });

    it("cancelled-before-a-runner: re-runs or holds in Approved, never hands back", () => {
      assert.match(
        block[0],
        /infra\)\n\s*recover_cancelled_ci "\$ISSUE_NUM" "\$PR_NUM" "\$HEAD_SHA" "\$PR_VIEW" "Approved"\n\s*continue ;;/,
      );
      assert.match(block[0], /unknown\)\n\s*log "WARNING: couldn't look up[^\n]*\n\s*continue ;;/);
    });

    it("genuine red: comments once per head SHA and hands back to In Review", () => {
      assert.match(block[0], /issue_has_marker "\$ISSUE_NUM" "drafto-factory-ci-red:\$SHA12"/);
      assert.match(block[0], /<!-- drafto-factory-ci-red:\$SHA12 -->/);
      assert.match(block[0], /RED_LIST=\$\(pr_failing_required_summary "\$PR_VIEW"/);
      assert.match(block[0], /if \[\[ "\$DRY_RUN" -eq 1 \]\]; then[\s\S]*?continue/);
    });

    it("fetches headRefOid so the markers can key on the head SHA", () => {
      assert.match(
        script,
        /--json state,mergeable,mergeStateStatus,isDraft,baseRefName,statusCheckRollup,labels,headRefOid/,
      );
    });
  });

  it("--watch re-runs cancelled-before-a-runner checks instead of starting the fix loop", () => {
    const infraAt = script.search(
      /if \[\[ "\$FAILING" -gt 0 && "\$\{REQUIRED_CONTEXTS_JSON:-\[\]\}" != "\[\]" \]\]; then/,
    );
    const fixLoopAt = script.search(
      /failing check\(s\), \$THREAD_COUNT open thread\(s\) → fix loop/,
    );
    assert.ok(infraAt > 0 && fixLoopAt > 0, "watch infra check or fix-loop log not found");
    assert.ok(infraAt < fixLoopAt, "the infra re-run must come before the fix loop");
    const block = script.slice(infraAt, fixLoopAt);
    assert.match(block, /case "\$\(classify_failing_required "\$PR_VIEW"\)" in/);
    assert.match(
      block,
      /recover_cancelled_ci "\$ISSUE_NUM" "\$PR_NUM" "\$WATCH_HEAD_SHA" "\$PR_VIEW" "In Review"/,
    );
  });

  it("--watch spends an attempt on a no-op pass over red CI (no endless fix loop)", () => {
    const noop = script.match(/ {8}noop\)\n[\s\S]*?\n {10};;/);
    assert.ok(noop, "noop arm not found");
    assert.match(
      noop[0],
      /if \[\[ "\$FAILING" -gt 0 \]\]; then[\s\S]*?factory:bump-attempts "\$ISSUE_NUM"/,
    );
  });

  it("surfaces advisory (non-required) reds in the In Test hand-off comment", () => {
    // The advisory list is computed at the advance and threaded into the
    // hand-off, which passes it to the scenario writer (bundle.advisory) and
    // renders it in the deterministic fallback comment.
    assert.match(script, /ADVISORY=\$\(pr_failing_advisory "\$PR_VIEW"\)/);
    assert.match(script, /Advisory \(non-required\) checks are not green: \$advisory/);
  });

  it("hands the fix agent only required failures (CI_SUMMARY filtered by \\$req)", () => {
    assert.match(script, /CI_SUMMARY=\$\(pr_failing_required_summary "\$PR_VIEW"\)/);
    const summary = script.match(/\npr_failing_required_summary\(\) \{[\s\S]*?\n\}/);
    assert.ok(summary, "pr_failing_required_summary not found");
    assert.match(summary[0], /pr_failing_required_checks "\$1"/);
    const base = script.match(/\npr_failing_required_checks\(\) \{[\s\S]*?\n\}/);
    assert.ok(base, "pr_failing_required_checks not found");
    assert.match(base[0], /\$req \| index\(\$n\)/);
  });
});

describe("pr_failing_required / pr_pending_required (real helpers, jq)", () => {
  function extract(name) {
    const fn = script.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(fn, `could not extract ${name}`);
    return fn[0];
  }

  function runCounter(fnName, prView, requiredJson) {
    const harness = [
      "set -uo pipefail",
      "LOG_FILE=/dev/null",
      `REQUIRED_CONTEXTS_JSON='${requiredJson}'`,
      extract(fnName),
      `${fnName} '${JSON.stringify(prView)}'`,
    ].join("\n");
    const res = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
  }

  // A required check failing, an advisory bot (CodeRabbit) failing, and a
  // required check still running.
  const MIXED = {
    statusCheckRollup: [
      { name: "Scripts Tests", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "E2E Tests", status: "COMPLETED", conclusion: "FAILURE" },
      { context: "CodeRabbit", state: "FAILURE" },
      { name: "Unit & Integration Tests", status: "IN_PROGRESS" },
    ],
  };
  const REQUIRED = '["Scripts Tests","E2E Tests","Unit & Integration Tests"]';

  it("counts only required failures (ignores the advisory CodeRabbit red)", () => {
    assert.equal(runCounter("pr_failing_required", MIXED, REQUIRED), "1");
  });

  it("counts only required pendings", () => {
    assert.equal(runCounter("pr_pending_required", MIXED, REQUIRED), "1");
  });

  it("falls back to counting ALL checks when the required set is empty", () => {
    assert.equal(runCounter("pr_failing_required", MIXED, "[]"), "2"); // E2E + CodeRabbit
    assert.equal(runCounter("pr_pending_required", MIXED, "[]"), "1");
  });

  it("the #463 scenario: only CodeRabbit red, required all green → 0 failing", () => {
    const onlyBot = {
      statusCheckRollup: [
        { name: "Scripts Tests", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "E2E Tests", status: "COMPLETED", conclusion: "SUCCESS" },
        { context: "CodeRabbit", state: "FAILURE" },
      ],
    };
    assert.equal(runCounter("pr_failing_required", onlyBot, '["Scripts Tests","E2E Tests"]'), "0");
  });

  it("pr_failing_advisory names the non-required reds", () => {
    const harness = [
      "set -uo pipefail",
      "LOG_FILE=/dev/null",
      `REQUIRED_CONTEXTS_JSON='${REQUIRED}'`,
      extract("pr_failing_advisory"),
      `pr_failing_advisory '${JSON.stringify(MIXED)}'`,
    ].join("\n");
    const res = spawnSync("bash", ["-c", harness], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "CodeRabbit");
  });
});

describe("cancelled-check recovery helpers (real helpers, jq) — #654", () => {
  function extract(name) {
    const fn = script.match(new RegExp(`\\n${name}\\(\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(fn, `could not extract ${name}`);
    return fn[0];
  }

  // Bash with the named helpers loaded, the required set in place and echoing
  // stubs for everything that would touch GitHub or the state file. The helpers
  // send gh/node output to $LOG_FILE, so it points at stdout to capture those
  // calls. `pre` overrides a stub (later definitions win). The environment is
  // built from scratch so a knob exported by the caller (the factory's plist
  // sets FACTORY_* vars) can't change the results.
  function runBash(fns, body, { required = REQUIRED_654, pre = "", env = {} } = {}) {
    const harness = [
      "set -uo pipefail",
      "LOG_FILE=/dev/stdout",
      "SCRIPT_DIR=/nonexistent",
      "STATE_FILE=/nonexistent",
      `REQUIRED_CONTEXTS_JSON='${required}'`,
      'log() { echo "LOG $*"; }',
      'gh() { echo "GH $*"; }',
      'node() { echo "NODE $*" >&2; echo "{}"; }',
      ...fns.map(extract),
      pre,
      body,
    ].join("\n");
    return spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, DRY_RUN: "0", FACTORY_CI_RERUN_MAX: "2", ...env },
    });
  }

  const RUN = "https://github.com/JakubAnderwald/drafto/actions/runs/37371041547/job";
  const SHA = "5a5201f119ea5c7020b17bc5f098ceed4841c80f";
  const REQUIRED_654 =
    '["Lint & Typecheck","Unit & Integration Tests","E2E Tests","SonarCloud","Scripts Tests"]';
  // PR #657's rollup on 2026-10-05: three required jobs of one CI run cancelled
  // ("The job was not acquired by Runner of type hosted"), everything else green.
  const PR_657 = {
    headRefOid: SHA,
    statusCheckRollup: [
      { name: "Lint & Typecheck", conclusion: "SUCCESS", detailsUrl: `${RUN}/1` },
      { name: "Unit & Integration Tests", conclusion: "SUCCESS", detailsUrl: `${RUN}/2` },
      { name: "E2E Tests", conclusion: "CANCELLED", detailsUrl: `${RUN}/111967959901` },
      { name: "Scripts Tests", conclusion: "CANCELLED", detailsUrl: `${RUN}/111967959971` },
      { name: "SonarCloud", conclusion: "CANCELLED", detailsUrl: `${RUN}/111970417220` },
      { context: "CodeRabbit", state: "SUCCESS" },
    ],
  };
  const withCheck = (name, patch) => ({
    ...PR_657,
    statusCheckRollup: PR_657.statusCheckRollup.map((c) =>
      c.name === name ? { ...c, ...patch } : c,
    ),
  });
  const q = (obj) => `'${JSON.stringify(obj)}'`;

  it("pr_failing_required_summary lists required reds only, with links", () => {
    const view = withCheck("Lint & Typecheck", { conclusion: "FAILURE" });
    view.statusCheckRollup.push({ context: "CodeRabbit", state: "FAILURE" });
    const out = runBash(
      ["pr_failing_required_checks", "pr_failing_required_summary"],
      `pr_failing_required_summary ${q(view)}`,
    ).stdout.trim();
    assert.equal(
      out,
      [
        `Lint & Typecheck — FAILURE (${RUN}/1)`,
        `E2E Tests — CANCELLED (${RUN}/111967959901)`,
        `Scripts Tests — CANCELLED (${RUN}/111967959971)`,
        `SonarCloud — CANCELLED (${RUN}/111970417220)`,
      ].join("\n"),
    );
  });

  describe("classify_failing_required", () => {
    // gh stub for the job lookup: <started> maps job id → "true"/"false"; an id
    // missing from the map makes the lookup fail. Calls are logged on fd 3 (a
    // dup of stderr): the helper sends gh's stderr to $LOG_FILE, which here is
    // stdout, i.e. inside the $(...) capture.
    const classify = (view, started) => {
      const res = runBash(
        ["pr_failing_required_checks", "classify_failing_required"],
        `classify_failing_required ${q(view)}`,
        {
          pre: `exec 3>&2\ngh() { echo "GH $*" >&3; case "$2" in ${Object.entries(started)
            .map(([id, v]) => `*/jobs/${id}) echo ${v} ;;`)
            .join(" ")} *) return 1 ;; esac; }`,
        },
      );
      return { verdict: res.stdout.trim(), calls: res.stderr };
    };
    const NEVER_STARTED = { 111967959901: "false", 111967959971: "false", 111970417220: "false" };

    it("#657: every cancelled job never got a runner → infra", () => {
      assert.equal(classify(PR_657, NEVER_STARTED).verdict, "infra");
    });

    it("a cancelled job that had started (job timeout, manual cancel) → red", () => {
      assert.equal(classify(PR_657, { ...NEVER_STARTED, 111967959971: "true" }).verdict, "red");
    });

    it("a failed job lookup → unknown (retry next tick, don't guess)", () => {
      const partial = { 111967959901: "false", 111967959971: "false" }; // no 111970417220
      assert.equal(classify(PR_657, partial).verdict, "unknown");
    });

    it("any real red among them → red, without looking jobs up", () => {
      for (const c of ["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ERROR", "ACTION_REQUIRED"]) {
        const { verdict, calls } = classify(
          withCheck("E2E Tests", { conclusion: c }),
          NEVER_STARTED,
        );
        assert.equal(verdict, "red", c);
        assert.equal(calls, "", `${c} must not trigger job lookups`);
      }
    });

    it("a cancelled check that isn't an Actions job → red", () => {
      const view = withCheck("SonarCloud", { detailsUrl: "https://sonarcloud.io/x" });
      assert.equal(classify(view, NEVER_STARTED).verdict, "red");
    });

    it("only an advisory check cancelled → nothing required failing → red (caller never asks)", () => {
      const view = {
        statusCheckRollup: [
          { name: "E2E Tests", conclusion: "SUCCESS", detailsUrl: `${RUN}/1` },
          { context: "CodeRabbit", state: "CANCELLED" },
        ],
      };
      assert.equal(classify(view, {}).verdict, "red");
    });
  });

  describe("pr_infra_rerun_ids", () => {
    const ids = (view) =>
      runBash(
        ["pr_failing_required_checks", "pr_infra_rerun_ids"],
        `pr_infra_rerun_ids ${q(view)}`,
      ).stdout.trim();

    it("dedupes the run behind #657's three cancelled jobs", () => {
      assert.equal(ids(PR_657), "37371041547");
    });

    it("lists every distinct run", () => {
      const other = "https://github.com/JakubAnderwald/drafto/actions/runs/42/job/7";
      assert.equal(ids(withCheck("SonarCloud", { detailsUrl: other })), "37371041547\n42");
    });
  });

  describe("rerun_infra_failures", () => {
    const FNS = ["pr_failing_required_checks", "pr_infra_rerun_ids", "rerun_infra_failures"];
    // node stub: factory:get-issue answers with <record>; set-issue-field is echoed.
    // gh stub: `run view` answers <runStatus>; everything else is echoed.
    const stubs = (record, runStatus) =>
      [
        `node() { if [[ "$2" == "factory:get-issue" ]]; then echo '{"ciRerun":${JSON.stringify(record)}}'; else echo "NODE $*"; fi; }`,
        `gh() { if [[ "$1 $2" == "run view" ]]; then echo ${runStatus}; else echo "GH $*"; fi; }`,
      ].join("\n");
    const rerun = (view, { record = null, runStatus = "completed", env = {}, pre = "" } = {}) => {
      const res = runBash(FNS, `rerun_infra_failures 654 657 "${SHA}" ${q(view)}; echo "RC=$?"`, {
        pre: `${stubs(record, runStatus)}\n${pre}`,
        env,
      });
      assert.equal(res.stderr, "");
      return res.stdout;
    };

    it("first time on a head: records the attempt, then re-runs the failed jobs", () => {
      const out = rerun(PR_657);
      assert.match(out, new RegExp(`NODE .*factory:set-issue-field 654 ciRerun ${SHA}:1`));
      assert.match(out, /GH run rerun 37371041547 --failed --repo JakubAnderwald\/drafto/);
      assert.ok(
        out.indexOf("ciRerun") < out.indexOf("GH run rerun"),
        "budget must be spent before gh",
      );
      assert.match(out, /RC=0/);
    });

    it("second attempt on the same head counts up", () => {
      assert.match(rerun(PR_657, { record: `${SHA}:1` }), new RegExp(`ciRerun ${SHA}:2`));
    });

    it("budget spent on this head → returns 1 without re-running", () => {
      const out = rerun(PR_657, { record: `${SHA}:2` });
      assert.doesNotMatch(out, /GH run rerun/);
      assert.match(out, /RC=1/);
    });

    it("a budget spent on an older head doesn't carry over to a new push", () => {
      assert.match(rerun(PR_657, { record: "0123456789ab:2" }), new RegExp(`ciRerun ${SHA}:1`));
    });

    it("FACTORY_CI_RERUN_MAX=0 disables re-runs", () => {
      assert.match(rerun(PR_657, { env: { FACTORY_CI_RERUN_MAX: "0" } }), /RC=1/);
    });

    it("waits (no re-run, no budget) while the run still has jobs going — gh would refuse", () => {
      const out = rerun(PR_657, { runStatus: "in_progress" });
      assert.doesNotMatch(out, /GH run rerun|set-issue-field/);
      assert.match(out, /run 37371041547 is still in_progress/);
      assert.match(out, /RC=0/);
    });

    it("dry run touches neither GitHub nor the state file", () => {
      const out = rerun(PR_657, { env: { DRY_RUN: "1" } });
      assert.doesNotMatch(out, /GH run rerun|set-issue-field/);
      assert.match(out, /DRY-RUN: would re-run .*37371041547/);
      assert.match(out, /RC=0/);
    });

    it("a refused re-run is logged and still counted (no infinite retry)", () => {
      const out = rerun(PR_657, {
        pre: 'gh() { if [[ "$1 $2" == "run view" ]]; then echo completed; else return 1; fi; }',
      });
      assert.match(out, new RegExp(`ciRerun ${SHA}:1`));
      assert.match(out, /WARNING: gh run rerun 37371041547 --failed refused/);
      assert.match(out, /RC=0/);
    });
  });

  describe("comment_ci_infra_hold", () => {
    const FNS = [
      "pr_failing_required_checks",
      "pr_failing_required_summary",
      "pr_infra_rerun_ids",
      "comment_ci_infra_hold",
    ];
    const hold = ({ marked = false, env = {} } = {}) =>
      runBash(FNS, `comment_ci_infra_hold 654 657 "${SHA}" ${q(PR_657)} "Approved"`, {
        pre: `issue_has_marker() { echo "MARKER? $2" >&2; return ${marked ? 0 : 1}; }`,
        env,
      });

    it("posts once per head SHA, with the checks and the exact re-run command", () => {
      const res = hold();
      assert.match(res.stderr, /MARKER\? drafto-factory-ci-infra:5a5201f119ea$/m);
      assert.match(res.stdout, /^GH issue comment 654 --repo JakubAnderwald\/drafto --body/);
      assert.match(res.stdout, /CI couldn't run on `5a5201f119ea`/);
      assert.match(res.stdout, /- E2E Tests — CANCELLED/);
      assert.match(
        res.stdout,
        /^gh run rerun 37371041547 --failed --repo JakubAnderwald\/drafto$/m,
      );
      assert.match(res.stdout, /tried to re-run them 2 time\(s\)/);
      assert.match(res.stdout, /stays in \*\*Approved\*\*/);
      assert.match(res.stdout, /<!-- drafto-factory-ci-infra:5a5201f119ea -->/);
    });

    it("stays quiet once the marker for this head exists", () => {
      assert.equal(hold({ marked: true }).stdout, "");
    });

    it("dry run posts nothing", () => {
      assert.equal(hold({ env: { DRY_RUN: "1" } }).stdout, "");
    });
  });

  describe("recover_cancelled_ci", () => {
    const run = (rerunRc) =>
      runBash(
        ["recover_cancelled_ci"],
        `recover_cancelled_ci 654 657 "${SHA}" '{}' "In Review"; echo "RC=$?"`,
        {
          pre: [
            `rerun_infra_failures() { echo "RERUN $1 $2 $3"; return ${rerunRc}; }`,
            'comment_ci_infra_hold() { echo "HOLD $1 $2 $3 $5"; }',
          ].join("\n"),
        },
      ).stdout;

    it("re-run acted → no hold comment", () => {
      const out = run(0);
      assert.match(out, new RegExp(`RERUN 654 657 ${SHA}`));
      assert.doesNotMatch(out, /HOLD/);
    });

    it("budget spent → logs and posts the hold for <where>", () => {
      const out = run(1);
      assert.match(out, /holding in In Review/);
      assert.match(out, new RegExp(`HOLD 654 657 ${SHA} In Review`));
    });
  });
});
