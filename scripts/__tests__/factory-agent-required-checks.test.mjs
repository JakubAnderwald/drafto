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
    assert.match(script, /^is_ci_infra_step\(\) \{/m);
    assert.match(script, /^classify_failing_required\(\) \{/m);
    assert.match(script, /^pr_infra_rerun_ids\(\) \{/m);
    assert.match(script, /^ci_rerun_count\(\) \{/m);
    assert.match(script, /^rerun_infra_failures\(\) \{/m);
    assert.match(script, /^comment_ci_infra_hold\(\) \{/m);
    assert.match(script, /^recover_cancelled_ci\(\) \{/m);
    assert.match(script, /^pr_ci_noop_key\(\) \{/m);
    assert.match(script, /^record_ci_noop\(\) \{/m);
    assert.match(script, /^ci_noop_repeat\(\) \{/m);
    assert.match(script, /^comment_ci_noop_hold\(\) \{/m);
    assert.match(script, /^recover_noop_red_ci\(\) \{/m);
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
      /if \[\[ "\$CONFLICTING" -eq 0 && "\$FAILING" -gt 0 && "\$\{REQUIRED_CONTEXTS_JSON:-\[\]\}" != "\[\]" \]\]; then/,
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

  // #899 / PR #915: ten Claude passes ended `noop` on the same red checks of
  // the same head. ADR-0100 records the first and re-runs the checks in bash.
  it("--watch records a no-op pass over red CI (ciNoop) along with the attempt", () => {
    const noop = script.match(/ {8}noop\)\n[\s\S]*?\n {10};;/);
    assert.ok(noop, "noop arm not found");
    assert.match(
      noop[0],
      /if \[\[ "\$FAILING" -gt 0 \]\]; then[\s\S]*?factory:bump-attempts "\$ISSUE_NUM"[^\n]*\n\s*record_ci_noop "\$ISSUE_NUM" "\$PR_VIEW"\n\s*fi/,
    );
  });

  it("--watch re-runs red CI a no-op pass already saw before any fix pass, after classifying it", () => {
    const infraAt = script.search(
      /if \[\[ "\$CONFLICTING" -eq 0 && "\$FAILING" -gt 0 && "\$\{REQUIRED_CONTEXTS_JSON:-\[\]\}" != "\[\]" \]\]; then/,
    );
    const fixLoopAt = script.search(
      /failing check\(s\), \$THREAD_COUNT open thread\(s\) → fix loop/,
    );
    const block = script.slice(infraAt, fixLoopAt);
    const classifyAt = block.search(/classify_failing_required/);
    const repeatAt = block.search(
      /if ci_noop_repeat "\$ISSUE_NUM" "\$PR_VIEW"; then\n\s*recover_noop_red_ci "\$ISSUE_NUM" "\$ITEM_ID" "\$PR_NUM" "\$WATCH_HEAD_SHA" "\$PR_VIEW"\n\s*continue\n/,
    );
    assert.ok(repeatAt > 0, "the ciNoop repeat check is not in the watch CI block");
    assert.ok(classifyAt < repeatAt, "cancelled-before-a-runner checks keep their own path");
    // Nothing between the check and the fix loop's Claude call can be reached
    // on a repeat: the block ends in `continue`.
    assert.doesNotMatch(block.slice(repeatAt), /run-claude\.mjs/);
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
  // send gh/node output to $LOG_FILE, so the log (log() included, keeping the
  // order) goes to a temp file that is printed to stdout on exit. Not
  // /dev/stdout: on Linux spawnSync's stdout is a socket, which can't be opened.
  // `pre` overrides a stub (later definitions win). The environment is built
  // from scratch so a knob exported by the caller (the factory's plist sets
  // FACTORY_* vars) can't change the results.
  function runBash(fns, body, { required = REQUIRED_654, pre = "", env = {} } = {}) {
    const harness = [
      "set -uo pipefail",
      "LOG_FILE=$(mktemp)",
      `trap 'cat "$LOG_FILE"; rm -f "$LOG_FILE"' EXIT`,
      "SCRIPT_DIR=/nonexistent",
      "STATE_FILE=/nonexistent",
      `REQUIRED_CONTEXTS_JSON='${required}'`,
      'log() { echo "LOG $*" >>"$LOG_FILE"; }',
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
    // gh stub for the two lookups, fed real-shaped API responses and run through
    // the script's own --jq filter with real jq: <jobs> maps job id → the jobs
    // API body, <notes> maps job id → its check-run annotations. An id missing
    // from a map makes that lookup fail. Calls are logged on fd 3 (a dup of
    // stderr), apart from the log file the harness prints on stdout.
    const classify = (view, jobs, notes = {}) => {
      const cases = [
        ...Object.entries(jobs).map(
          ([id, j]) => `*/actions/jobs/${id}) json='${JSON.stringify(j)}' ;;`,
        ),
        ...Object.entries(notes).map(
          ([id, a]) => `*/check-runs/${id}/annotations) json='${JSON.stringify(a)}' ;;`,
        ),
      ].join("\n    ");
      const res = runBash(
        ["pr_failing_required_checks", "is_ci_infra_step", "classify_failing_required"],
        `classify_failing_required ${q(view)}`,
        {
          pre: `exec 3>&2
gh() {
  echo "GH $*" >&3
  local json
  case "$2" in
    ${cases}
    *) return 1 ;;
  esac
  printf '%s' "$json" | jq -r "$4"
}`,
        },
      );
      return { verdict: res.stdout.trim(), calls: res.stderr };
    };
    // The jobs API for a job no runner picked up (#654's three) …
    const NEVER = { runner_name: null, steps: [] };
    // … and for one stopped in <step>, shaped like the E2E job cancelled on
    // PR #760: the steps before it succeeded, the ones after were skipped.
    const stoppedIn = (step, conclusion = "cancelled") => ({
      runner_name: "GitHub Actions 1000011044",
      steps: [
        { number: 1, name: "Set up job", status: "completed", conclusion: "success" },
        { number: 3, name: "Run actions/checkout@v4", status: "completed", conclusion: "success" },
        {
          number: 6,
          name: "Run pnpm install --frozen-lockfile",
          status: "completed",
          conclusion: "success",
        },
        ...(step ? [{ number: 7, name: step, status: "completed", conclusion }] : []),
        {
          number: 8,
          name: "Run cd apps/web && pnpm build",
          status: "completed",
          conclusion: "skipped",
        },
        {
          number: 22,
          name: "Post Run actions/checkout@v4",
          status: "completed",
          conclusion: "success",
        },
        { number: 23, name: "Complete job", status: "completed", conclusion: "success" },
      ],
    });
    const TIMED_OUT = [
      {
        annotation_level: "failure",
        message: "The job has exceeded the maximum execution time of 15m0s",
      },
    ];
    const BY_HAND = [
      { annotation_level: "failure", message: "The run was canceled by @JakubAnderwald." },
      { annotation_level: "failure", message: "The operation was canceled." },
    ];
    const E2E = 111967959901;
    const NEVER_STARTED = { 111967959901: NEVER, 111967959971: NEVER, 111970417220: NEVER };
    const INSTALL = "Run cd apps/web && pnpm exec playwright install --with-deps chromium webkit";

    it("#657: every cancelled job never got a runner → infra", () => {
      const { verdict, calls } = classify(PR_657, NEVER_STARTED);
      assert.equal(verdict, "infra");
      assert.doesNotMatch(calls, /annotations/, "a job that never ran has no timeout to check");
    });

    it("a job that timed out in the browser install → infra", () => {
      const jobs = { ...NEVER_STARTED, [E2E]: stoppedIn(INSTALL) };
      assert.equal(classify(PR_657, jobs, { [E2E]: TIMED_OUT }).verdict, "infra");
    });

    it("finds the step it stopped in even when GitHub left no conclusion on it", () => {
      const jobs = { ...NEVER_STARTED, [E2E]: stoppedIn(INSTALL, null) };
      assert.equal(classify(PR_657, jobs, { [E2E]: TIMED_OUT }).verdict, "infra");
    });

    it("a timeout reported as TIMED_OUT gets the same check", () => {
      const view = withCheck("E2E Tests", { conclusion: "TIMED_OUT" });
      const jobs = { ...NEVER_STARTED, [E2E]: stoppedIn(INSTALL) };
      assert.equal(classify(view, jobs, { [E2E]: TIMED_OUT }).verdict, "infra");
      assert.equal(
        classify(view, { ...jobs, [E2E]: stoppedIn("Run cd apps/web && pnpm test:e2e") }).verdict,
        "red",
      );
    });

    it("a job that timed out in the install, build or tests → red (likely a hang in the code)", () => {
      for (const step of [
        "Run pnpm install --frozen-lockfile",
        "Run cd apps/web && pnpm build",
        "Run cd apps/web && pnpm test:e2e",
      ]) {
        const jobs = { ...NEVER_STARTED, [E2E]: stoppedIn(step) };
        assert.equal(classify(PR_657, jobs, { [E2E]: TIMED_OUT }).verdict, "red", step);
      }
    });

    it("a job that timed out in an action's cleanup or its container start or stop → infra", () => {
      for (const step of [
        "Post Run actions/checkout@v4",
        "Post Run pnpm/action-setup@v4",
        "Complete job",
        "Initialize containers",
        "Stop containers",
      ]) {
        const jobs = { ...NEVER_STARTED, [E2E]: stoppedIn(step) };
        assert.equal(classify(PR_657, jobs, { [E2E]: TIMED_OUT }).verdict, "infra", step);
      }
    });

    it("a job someone cancelled by hand stays red, even in a setup step (ADR-0041)", () => {
      const jobs = { ...NEVER_STARTED, [E2E]: stoppedIn(INSTALL) };
      assert.equal(classify(PR_657, jobs, { [E2E]: BY_HAND }).verdict, "red");
    });

    it("a started job with no step left unfinished → red", () => {
      const jobs = { ...NEVER_STARTED, [E2E]: stoppedIn(null) };
      assert.equal(classify(PR_657, jobs).verdict, "red");
    });

    it("a failed lookup → unknown (retry next tick, don't guess)", () => {
      const { 111970417220: _, ...partial } = NEVER_STARTED;
      assert.equal(classify(PR_657, partial).verdict, "unknown");
      const jobs = { ...NEVER_STARTED, [E2E]: stoppedIn(INSTALL) };
      assert.equal(classify(PR_657, jobs, {}).verdict, "unknown", "no annotations");
    });

    it("any real red among them → red, without looking jobs up", () => {
      for (const c of ["FAILURE", "STARTUP_FAILURE", "ERROR", "ACTION_REQUIRED"]) {
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

  describe("is_ci_infra_step, against .github/workflows/ci.yml", () => {
    const ci = readFileSync(
      resolve(dirname(scriptPath), "..", ".github", "workflows", "ci.yml"),
      "utf8",
    );
    // Every step of every job, with the name the jobs API reports for it: its
    // `name:`, else "Run <uses>" or "Run <first line of run>".
    const steps = (() => {
      const out = [];
      const lines = ci.slice(ci.indexOf("\njobs:\n")).split("\n");
      let step = null;
      const set = (key, value, i) => {
        if (!step || !["name", "uses", "run"].includes(key)) return;
        let v = value.trim().replace(/^["']|["']$/g, "");
        if (key === "run" && /^[|>]-?$/.test(v)) {
          v = lines
            .slice(i + 1)
            .find((l) => l.trim() !== "")
            .trim();
        }
        step[key] = v;
      };
      lines.forEach((line, i) => {
        let m;
        if ((m = line.match(/^ {6}- ([\w-]+):(.*)$/))) {
          step = {};
          out.push(step);
          set(m[1], m[2], i);
        } else if ((m = line.match(/^ {8}([\w-]+):(.*)$/))) {
          set(m[1], m[2], i);
        } else if (/^ {0,4}\S/.test(line)) {
          step = null;
        }
      });
      return out.map((s) => ({
        ...s,
        shown: s.name ?? (s.uses ? `Run ${s.uses}` : `Run ${s.run}`),
      }));
    })();
    // A step's hang can't be the code's fault when it sets the job up or talks
    // to an outside service — never when it runs the repo's install, build,
    // lint, tests or scripts.
    const infra = (s) =>
      /^(actions\/(checkout|setup-[\w-]+|cache|download-artifact|upload-artifact)|pnpm\/action-setup|SonarSource\/)/.test(
        s.uses ?? "",
      ) ||
      /playwright install/.test(s.run ?? "") ||
      s.shown === "Check for required secrets";
    const verdicts = () => {
      const res = runBash(
        ["is_ci_infra_step"],
        `while IFS= read -r n; do is_ci_infra_step "$n" && echo yes || echo no; done <<'EOF'
${steps.map((s) => s.shown).join("\n")}
EOF`,
      );
      return res.stdout.trim().split("\n");
    };

    it("finds the workflow's steps", () => {
      assert.ok(steps.length >= 30, `expected the CI steps, found ${steps.length}`);
      assert.ok(steps.some((s) => s.shown === "Run pnpm install --frozen-lockfile"));
    });

    it("counts exactly the set-up and outside-service steps, by the names GitHub gives them", () => {
      const got = verdicts();
      steps.forEach((s, i) => {
        assert.equal(got[i], infra(s) ? "yes" : "no", `${s.shown}`);
      });
      assert.ok(got.includes("yes") && got.includes("no"));
    });

    it("counts an action's cleanup step as the action itself, never a command's", () => {
      const res = runBash(
        ["is_ci_infra_step"],
        `for n in "Post Run actions/setup-node@v4" "Post Run actions/upload-artifact@v4" "Complete job" "Post Run pnpm install --frozen-lockfile"; do is_ci_infra_step "$n" && echo yes || echo no; done`,
      );
      assert.deepEqual(res.stdout.trim().split("\n"), ["yes", "yes", "yes", "no"]);
    });

    it("leaves pnpm install out: a dependency or lockfile change in the PR can hang it", () => {
      const got = verdicts();
      const i = steps.findIndex((s) => s.shown === "Run pnpm install --frozen-lockfile");
      assert.equal(got[i], "no");
    });
  });

  describe(".github/workflows/ci.yml", () => {
    // The E2E job runs in Playwright's image, which carries one Playwright
    // version's browsers: a @playwright/test bump must bump the tag with it, or
    // the tests look for browsers the image doesn't have.
    it("runs E2E in the Playwright image of the locked @playwright/test version", () => {
      const root = resolve(dirname(scriptPath), "..");
      const ci = readFileSync(resolve(root, ".github", "workflows", "ci.yml"), "utf8");
      const lock = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
      const locked = [
        ...new Set([...lock.matchAll(/@playwright\/test@(\d+\.\d+\.\d+)/g)].map((m) => m[1])),
      ];
      assert.equal(locked.length, 1, `one locked @playwright/test version, found ${locked}`);
      const e2e = ci.slice(ci.indexOf("\n  e2e-tests:\n"), ci.indexOf("\n  mobile-checks:\n"));
      assert.match(
        e2e,
        new RegExp(
          `image: mcr\\.microsoft\\.com/playwright:v${locked[0].replace(/\./g, "\\.")}-noble\\n`,
        ),
      );
      assert.doesNotMatch(e2e, /run: .*playwright install/, "the image already has the browsers");
    });

    // Without a timeout GitHub waits 6 hours, so a hung job holds the PR's
    // checks (and the factory's card) that long.
    it("gives every job a timeout", () => {
      const ci = readFileSync(
        resolve(dirname(scriptPath), "..", ".github", "workflows", "ci.yml"),
        "utf8",
      );
      const jobs = ci
        .slice(ci.indexOf("\njobs:\n"))
        .split(/\n(?= {2}[a-z0-9-]+:\n)/)
        .slice(1);
      assert.ok(jobs.length >= 7, `expected the CI jobs, found ${jobs.length}`);
      for (const job of jobs) {
        assert.match(job, /^ {4}timeout-minutes: \d+$/m, job.split("\n")[0]);
      }
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

    it("skips a red check that isn't an Actions job (a no-op pass's red may hold one)", () => {
      const view = withCheck("SonarCloud", { detailsUrl: "https://sonarcloud.io/dashboard?id=x" });
      assert.equal(ids(view), "37371041547");
      const none = {
        headRefOid: SHA,
        statusCheckRollup: [{ context: "SonarCloud", state: "FAILURE" }],
      };
      assert.equal(ids(none), "");
    });
  });

  describe("rerun_infra_failures", () => {
    const FNS = [
      "pr_failing_required_checks",
      "pr_infra_rerun_ids",
      "ci_rerun_count",
      "rerun_infra_failures",
    ];
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

    it("an unreadable run status waits too — it never spends the budget on a guess", () => {
      const out = rerun(PR_657, {
        pre: 'gh() { if [[ "$1 $2" == "run view" ]]; then return 1; else echo "GH $*"; fi; }',
      });
      assert.doesNotMatch(out, /GH run rerun|set-issue-field/);
      assert.match(out, /WARNING: couldn't read the status of run 37371041547/);
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
      "ci_rerun_count",
      "comment_ci_infra_hold",
    ];
    // <record> is the issue's ciRerun state ("<sha>:<count>"), read via node.
    const hold = ({ marked = false, env = {}, record = `${SHA}:2` } = {}) =>
      runBash(FNS, `comment_ci_infra_hold 654 657 "${SHA}" ${q(PR_657)} "Approved"`, {
        pre: [
          `issue_has_marker() { echo "MARKER? $2" >&2; return ${marked ? 0 : 1}; }`,
          `node() { echo '{"ciRerun":${JSON.stringify(record)}}'; }`,
        ].join("\n"),
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
      assert.match(res.stdout, /re-ran them 2 time\(s\) without getting a result/);
      assert.match(res.stdout, /stays in \*\*Approved\*\*/);
      assert.match(res.stdout, /<!-- drafto-factory-ci-infra:5a5201f119ea -->/);
    });

    it("reports the re-runs actually spent, not the knob", () => {
      const lowered = hold({ record: `${SHA}:1`, env: { FACTORY_CI_RERUN_MAX: "1" } }).stdout;
      assert.match(lowered, /re-ran them 1 time\(s\)/);
      // Disabled (or nothing spent on this head): never claim a re-run happened.
      for (const out of [
        hold({ record: null, env: { FACTORY_CI_RERUN_MAX: "0" } }).stdout,
        hold({ record: "0123456789ab:2" }).stdout,
      ]) {
        assert.doesNotMatch(out, /re-ran them/);
        assert.match(out, /didn't re-run them \(`FACTORY_CI_RERUN_MAX` is [0-9]+\)/);
      }
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
            "ci_rerun_count() { echo 2; }",
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
      assert.match(out, /still couldn't run after 2 re-run\(s\); holding in In Review/);
      assert.match(out, new RegExp(`HOLD 654 657 ${SHA} In Review`));
    });
  });
  // ADR-0100 — #899 / PR #915: ten Claude passes ended `noop` on the same red
  // checks of the same head. The first one is recorded (ciNoop); a repeat
  // re-runs the checks in bash under the ciRerun budget, then parks the card
  // in Blocked with one comment. A new head SHA re-arms the card.
  describe("red CI a no-op fix pass left (ADR-0100)", () => {
    const SHA_915 = "9b9d1c2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c";
    const PR_915 = {
      headRefOid: SHA_915,
      statusCheckRollup: [
        { name: "Unit & Integration Tests", conclusion: "FAILURE", detailsUrl: `${RUN}/3` },
        { name: "Lint & Typecheck", conclusion: "SUCCESS", detailsUrl: `${RUN}/1` },
        { name: "E2E Tests", conclusion: "FAILURE", detailsUrl: `${RUN}/4` },
        { context: "CodeRabbit", state: "FAILURE" },
      ],
    };
    const KEY_915 = `${SHA_915}:E2E Tests,Unit & Integration Tests`;
    const ALL = [
      "pr_failing_required_checks",
      "pr_failing_required_summary",
      "pr_infra_rerun_ids",
      "ci_rerun_count",
      "rerun_infra_failures",
      "pr_ci_noop_key",
      "record_ci_noop",
      "ci_noop_repeat",
      "comment_ci_noop_hold",
      "recover_noop_red_ci",
    ];

    it("pr_ci_noop_key: head SHA plus the required red check names, sorted", () => {
      const key = (view) =>
        runBash(
          ["pr_failing_required_checks", "pr_ci_noop_key"],
          `pr_ci_noop_key ${q(view)}`,
        ).stdout.trim();
      assert.equal(key(PR_915), KEY_915);
      // No head SHA, or nothing failing: no key, so nothing is ever matched.
      assert.equal(key({ ...PR_915, headRefOid: "" }), "");
      assert.equal(key({ headRefOid: SHA_915, statusCheckRollup: [] }), "");
    });

    it("record_ci_noop stores the key in ciNoop", () => {
      const out = runBash(
        ["pr_failing_required_checks", "pr_ci_noop_key", "record_ci_noop"],
        `record_ci_noop 899 ${q(PR_915)}`,
        {
          pre: 'node() { echo "NODE $*"; }',
        },
      ).stdout;
      assert.ok(
        out.includes(
          `NODE /nonexistent/lib/state-cli.mjs factory:set-issue-field 899 ciNoop ${KEY_915}`,
        ),
        out,
      );
    });

    it("record_ci_noop writes nothing on a dry run", () => {
      const out = runBash(
        ["pr_failing_required_checks", "pr_ci_noop_key", "record_ci_noop"],
        `record_ci_noop 899 ${q(PR_915)}`,
        {
          pre: 'node() { echo "NODE $*"; }',
          env: { DRY_RUN: "1" },
        },
      ).stdout;
      assert.doesNotMatch(out, /NODE/);
      assert.match(out, /DRY-RUN: would record ciNoop for #899/);
    });

    describe("ci_noop_repeat", () => {
      const repeat = (view, record, pre = "") =>
        runBash(
          ["pr_failing_required_checks", "pr_ci_noop_key", "ci_noop_repeat"],
          `ci_noop_repeat 899 ${q(view)}; echo "RC=$?"`,
          { pre: `node() { echo '{"ciNoop":${JSON.stringify(record)}}'; }\n${pre}` },
        ).stdout;

      it("matches the same head with the same red checks", () => {
        assert.match(repeat(PR_915, KEY_915), /RC=0/);
      });

      it("a new push (new head SHA) re-arms the card", () => {
        assert.match(repeat({ ...PR_915, headRefOid: "f".repeat(40) }, KEY_915), /RC=1/);
      });

      it("a different set of red checks is new to the fix agent", () => {
        const view = {
          ...PR_915,
          statusCheckRollup: PR_915.statusCheckRollup.filter((c) => c.name !== "E2E Tests"),
        };
        assert.match(repeat(view, KEY_915), /RC=1/);
      });

      it("no record, or an unreadable one, is no match: the fix loop runs as before", () => {
        assert.match(repeat(PR_915, null), /RC=1/);
        assert.match(repeat(PR_915, KEY_915, "node() { return 1; }"), /RC=1/);
      });
    });

    // Two ticks of --watch and more, against a state file: the noop arm
    // records, each repeat re-runs under the budget with no Claude run, the
    // spent budget parks the card in Blocked with one comment, and a new push
    // re-arms it.
    it("end to end: recorded, re-run twice with no Claude, then Blocked once; a new head re-arms", () => {
      // Every stub and tick marker writes to $LOG_FILE, where the helpers send
      // gh and node output too, so the printed log keeps the order.
      const state = [
        'say() { echo "$*" >>"$LOG_FILE"; }',
        'STATE=$(mktemp); echo "{}" >"$STATE"',
        'node() { case "$2" in',
        '  factory:get-issue) cat "$STATE" ;;',
        '  factory:set-issue-field) jq --arg f "$4" --arg v "$5" \'.[$f] = $v\' "$STATE" >"$STATE.new" && mv "$STATE.new" "$STATE"; say "SET $4 $5" ;;',
        '  *) say "NODE $*" ;;',
        "esac; }",
        'gh() { if [[ "$1 $2" == "run view" ]]; then echo completed; else say "GH $*"; fi; }',
        'issue_marker_check() { grep -q "COMMENTED" "$STATE.marks" 2>/dev/null && return 0; return 1; }',
        'transition_status() { say "TRANSITION $1 $2 $3"; }',
        'release_slot_and_worktree() { say "RELEASE $1"; }',
      ].join("\n");
      const view = q(PR_915);
      const tick = `if ci_noop_repeat 899 ${view}; then recover_noop_red_ci 899 ITEM_899 915 "${SHA_915}" ${view}; else say "FIX PASS"; fi`;
      const body = [
        "say '--- tick 1 (fix pass ended noop)'",
        `record_ci_noop 899 ${view}`,
        "say '--- tick 2'",
        tick,
        "say '--- tick 3'",
        tick,
        "say '--- tick 4'",
        tick,
        'echo COMMENTED >"$STATE.marks"',
        "say '--- tick 5 (operator dragged it back unchanged)'",
        tick,
        "say '--- tick 6 (new push)'",
        `if ci_noop_repeat 899 ${q({ ...PR_915, headRefOid: "f".repeat(40) })}; then say REPEAT; else say "FIX PASS"; fi`,
        'rm -f "$STATE" "$STATE.marks"',
      ].join("\n");
      const res = runBash(ALL, body, { pre: state });
      assert.equal(res.stderr, "");
      const ticks = res.stdout.split(/^--- /m);
      const [t1, t2, t3, t4, t5, t6] = ticks.slice(1);
      assert.ok(t1.includes(`SET ciNoop ${KEY_915}`), t1);
      for (const [t, n] of [
        [t2, 1],
        [t3, 2],
      ]) {
        assert.ok(t.includes(`SET ciRerun ${SHA_915}:${n}`), t);
        assert.match(t, /GH run rerun 37371041547 --failed --repo JakubAnderwald\/drafto/);
        assert.doesNotMatch(t, /FIX PASS|run-claude|NODE|TRANSITION|GH issue comment/);
      }
      assert.match(t4, /^GH issue comment 899 --repo JakubAnderwald\/drafto --body/m);
      assert.match(
        t4,
        /CI is still red on `9b9d1c2e3f4a`, and the fix agent found nothing to change/,
      );
      assert.match(t4, /re-ran them 2 time\(s\), and they stayed red/);
      assert.match(t4, /^gh run rerun 37371041547 --failed --repo JakubAnderwald\/drafto$/m);
      assert.match(
        t4,
        /factory:set-issue-field 899 ciNoop "" --state-file logs\/factory-state\.json/,
      );
      assert.match(t4, /<!-- drafto-factory-ci-noop-hold:9b9d1c2e3f4a -->/);
      assert.match(t4, /TRANSITION ITEM_899 899 Blocked/);
      assert.match(t4, /SET lastError red CI on 9b9d1c2e3f4a/);
      assert.match(t4, /RELEASE 899/);
      assert.doesNotMatch(t4, /GH run rerun|FIX PASS/);
      // The comment goes out once per head; the card still goes back to Blocked.
      assert.doesNotMatch(t5, /GH issue comment/);
      assert.match(t5, /TRANSITION ITEM_899 899 Blocked/);
      assert.match(t6, /FIX PASS/);
    });

    describe("comment_ci_noop_hold", () => {
      const hold = ({ marker = 1, ghComment = 0, env = {} } = {}) =>
        runBash(
          [
            "pr_failing_required_checks",
            "pr_failing_required_summary",
            "pr_infra_rerun_ids",
            "ci_rerun_count",
            "comment_ci_noop_hold",
          ],
          `comment_ci_noop_hold 899 ITEM_899 915 "${SHA_915}" ${q(PR_915)}; echo "RC=$?"`,
          {
            pre: [
              `issue_marker_check() { return ${marker}; }`,
              `gh() { if [[ "$1 $2" == "issue comment" ]]; then echo "GH $*"; return ${ghComment}; fi; echo "GH $*"; }`,
              `node() { if [[ "$2" == "factory:get-issue" ]]; then echo '{"ciRerun":"${SHA_915}:0"}'; else echo "NODE $*"; fi; }`,
              'transition_status() { echo "TRANSITION $1 $2 $3"; }',
              'release_slot_and_worktree() { echo "RELEASE $1"; }',
            ].join("\n"),
            env,
          },
        ).stdout;

      it("says so when nothing was re-run, and still lists the commands", () => {
        const out = hold({ env: { FACTORY_CI_RERUN_MAX: "0" } });
        assert.doesNotMatch(out, /re-ran them/);
        assert.match(out, /didn't re-run them \(`FACTORY_CI_RERUN_MAX` is 0/);
        assert.match(out, /- E2E Tests — FAILURE/);
        assert.doesNotMatch(out, /CodeRabbit/);
        assert.match(out, /TRANSITION ITEM_899 899 Blocked/);
        assert.match(out, /RC=0/);
      });

      it("comments unreadable: no comment, no move; the next tick tries again", () => {
        const out = hold({ marker: 2 });
        assert.doesNotMatch(out, /GH issue comment|TRANSITION|RELEASE/);
        assert.match(out, /RC=1/);
      });

      it("a comment GitHub refused: no move without the notice", () => {
        const out = hold({ ghComment: 1 });
        assert.match(out, /GH issue comment/);
        assert.doesNotMatch(out, /TRANSITION|RELEASE/);
        assert.match(out, /couldn't post the red-CI hold notice/);
        assert.match(out, /RC=1/);
      });

      it("dry run neither comments nor moves the card", () => {
        const out = hold({ env: { DRY_RUN: "1" } });
        assert.doesNotMatch(out, /GH issue comment|TRANSITION|RELEASE/);
        assert.match(out, /DRY-RUN: would comment on #899 and move it to Blocked/);
      });
    });

    it("rerun_infra_failures words the noop re-run as such", () => {
      const out = runBash(
        [
          "pr_failing_required_checks",
          "pr_infra_rerun_ids",
          "ci_rerun_count",
          "rerun_infra_failures",
        ],
        `rerun_infra_failures 899 915 "${SHA_915}" ${q(PR_915)} noop; echo "RC=$?"`,
        {
          pre: [
            'node() { if [[ "$2" == "factory:get-issue" ]]; then echo "{}"; else echo "NODE $*"; fi; }',
            'gh() { if [[ "$1 $2" == "run view" ]]; then echo completed; else echo "GH $*"; fi; }',
          ].join("\n"),
        },
      ).stdout;
      assert.match(
        out,
        /required check\(s\) are still red on the head a no-op fix pass left unchanged/,
      );
      assert.doesNotMatch(out, /were cancelled/);
      assert.match(out, /RC=0/);
    });
  });
});
