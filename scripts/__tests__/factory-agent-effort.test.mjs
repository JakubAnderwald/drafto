import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The dark factory must invoke `claude` at an explicit effort on every call:
// ultracode on --implement, xhigh on --watch fix passes (ADR-0076) and xhigh on
// the read-only stages (--plan/replan, review, scenario writer, browser runner).
// See ADR-0029. Locking the flag —
// and its validation guards — in against a refactor that drops it: a silent
// regression would send the factory back to whatever ambient effort the host
// happens to default to, which is exactly the drift this change removed.
//
// The model is pinned the same way (ADR-0101): every call passes --model,
// FACTORY_MODEL (opus[1m]) unless a stage knob (ADR-0080) names another one,
// so no call falls back to ~/.claude/settings.json or the CLI's default.

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "factory-agent.sh");
const script = readFileSync(scriptPath, "utf8");

describe("factory-agent Claude effort", () => {
  it("passes --effort at all seven Claude call sites", () => {
    // Five read-only sites (plan + replan + /split + In Test scenario + code
    // review) use the plan effort; the implement site uses this run's
    // implement effort (IMPL_EFFORT: the coding effort, or the revision
    // effort, ADR-0101) and the watch fix site its own (ADR-0076).
    const planFlags =
      script.match(/--dangerously-skip-permissions --effort "\$FACTORY_PLAN_EFFORT"/g) || [];
    const codeFlags =
      script.match(/--dangerously-skip-permissions --effort "\$IMPL_EFFORT"/g) || [];
    const watchFlags =
      script.match(/--dangerously-skip-permissions --effort "\$FACTORY_WATCH_EFFORT"/g) || [];
    assert.equal(
      planFlags.length,
      5,
      'expected --effort "$FACTORY_PLAN_EFFORT" at the plan + replan + split + In Test + review sites',
    );
    assert.equal(codeFlags.length, 1, 'expected --effort "$IMPL_EFFORT" at the implement site');
    assert.doesNotMatch(
      script,
      /--effort "\$FACTORY_EFFORT"/,
      "the implement call takes IMPL_EFFORT, never FACTORY_EFFORT directly",
    );
    assert.equal(
      watchFlags.length,
      1,
      'expected --effort "$FACTORY_WATCH_EFFORT" at the watch fix site',
    );
    assert.equal(
      planFlags.length + codeFlags.length + watchFlags.length,
      7,
      "every factory Claude call must carry an effort flag",
    );
  });

  it("runs --implement at this run's implement effort and --watch fix passes at the watch effort", () => {
    // ADR-0076: at ultracode a watch fix pass finished its fix, then started a
    // review workflow and waited on it until the 1800s cap killed it with
    // nothing committed (#797). The log line and the flag must agree.
    const implement = script.match(/Invoking claude for #\$ISSUE_NUM \(--implement[\s\S]{0,600}/);
    assert.ok(implement, "implement claude invocation not found");
    assert.match(implement[0], /effort=\$IMPL_EFFORT, model=\$FACTORY_MODEL\)/);
    assert.match(implement[0], /--effort "\$IMPL_EFFORT"/);
    const watch = script.match(/Invoking claude for #\$ISSUE_NUM \(--watch fix[\s\S]{0,600}/);
    assert.ok(watch, "watch fix claude invocation not found");
    assert.match(watch[0], /effort=\$FACTORY_WATCH_EFFORT, model=\$FACTORY_MODEL\)/);
    assert.match(watch[0], /--effort "\$FACTORY_WATCH_EFFORT"/);
    assert.doesNotMatch(watch[0], /--effort "\$FACTORY_EFFORT"/);
  });

  it("runs the browser runner (the eighth call) at the read-only (plan) effort", () => {
    // ADR-0051: the locked-down Chrome runner has no --dangerously-skip-
    // permissions, so the counts above don't see it. It reads pages and prints
    // a report — plan-tier effort, like the scenario writer.
    const calls = script.match(/run-claude\.mjs" -p\b/g) || [];
    assert.equal(calls.length, 8, "seven stage calls plus the browser runner");
    assert.match(
      script,
      /run-claude\.mjs" -p --chrome(?:[^\n]*\\\n){1,3}[^\n]*--effort "\$FACTORY_PLAN_EFFORT" \)/,
    );
  });

  it("runs the /split splitter at the read-only (plan) effort, with no tools, on a pinned model", () => {
    // ADR-0104: the splitter only prints text; bash files what it checked.
    const block = script.match(/Invoking claude for #\$issue_num \(split[\s\S]{0,800}/);
    assert.ok(block, "split claude invocation not found");
    assert.match(block[0], /effort=\$FACTORY_PLAN_EFFORT, model=\$\{FACTORY_MODEL:-opus\[1m\]\}/);
    assert.match(
      block[0],
      /--effort "\$FACTORY_PLAN_EFFORT" --no-chrome --strict-mcp-config \\\n\s+--tools "" --model "\$\{FACTORY_MODEL:-opus\[1m\]\}" >/,
    );
  });

  it("runs the In Test scenario writer at the read-only (plan) effort", () => {
    // It reads a diff and posts a comment — no code is written, so it must not
    // burn the coding-tier effort budget.
    const block = script.match(/Invoking claude for #\$issue_num \(In Test scenario[\s\S]{0,800}/);
    assert.ok(block, "In Test claude invocation not found");
    assert.match(block[0], /--effort "\$FACTORY_PLAN_EFFORT"/);
  });

  it("defaults FACTORY_EFFORT to ultracode, the watch, plan and revision efforts to xhigh", () => {
    assert.match(script, /FACTORY_EFFORT="\$\{FACTORY_EFFORT:-ultracode\}"/);
    assert.match(script, /FACTORY_WATCH_EFFORT="\$\{FACTORY_WATCH_EFFORT:-xhigh\}"/);
    assert.match(script, /FACTORY_PLAN_EFFORT="\$\{FACTORY_PLAN_EFFORT:-xhigh\}"/);
    assert.match(script, /FACTORY_REVISION_EFFORT="\$\{FACTORY_REVISION_EFFORT:-xhigh\}"/);
  });

  it("validates every effort knob against a known allowlist with a fallback", () => {
    // A case allowlist guards word-splitting / empty values (bash 3.2 safe) and
    // falls back to a safe default on an unknown level.
    for (const knob of [
      "FACTORY_EFFORT",
      "FACTORY_WATCH_EFFORT",
      "FACTORY_PLAN_EFFORT",
      "FACTORY_REVISION_EFFORT",
    ]) {
      assert.match(
        script,
        new RegExp(`case "\\$${knob}" in\\n\\s*ultracode\\|max\\|xhigh\\|high\\|medium\\|low\\)`),
        `${knob} must be checked against the allowlist`,
      );
    }
    assert.match(script, /invalid FACTORY_EFFORT='\$FACTORY_EFFORT'; defaulting to ultracode/);
    assert.match(
      script,
      /invalid FACTORY_WATCH_EFFORT='\$FACTORY_WATCH_EFFORT'; defaulting to xhigh/,
    );
    assert.match(
      script,
      /invalid FACTORY_PLAN_EFFORT='\$FACTORY_PLAN_EFFORT'; defaulting to xhigh/,
    );
    assert.match(
      script,
      /invalid FACTORY_REVISION_EFFORT='\$FACTORY_REVISION_EFFORT'; defaulting to xhigh/,
    );
  });

  it("raises the plan/replan timeout to a knob (FACTORY_PLAN_TIMEOUT_SEC)", () => {
    assert.match(script, /FACTORY_PLAN_TIMEOUT_SEC:-\$\{CLAUDE_CALL_TIMEOUT_SEC:-360\}/);
  });

  it("lets background workflows finish instead of the 600s print-mode ceiling", () => {
    // At ultracode the implementer delegates to background workflows; claude -p
    // kills them after 600s by default and exits without a summary line (#623).
    // The export must be unconditional (not per call site) and default to 0,
    // with the run-with-timeout wall caps still bounding every call.
    assert.match(
      script,
      /^export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS="\$\{FACTORY_BG_WAIT_CEILING_MS:-0\}"$/m,
    );
    assert.match(script, /defaulting to 0/);
    const exportAt = script.search(/^export CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=/m);
    const firstCall = script.indexOf('node "$SCRIPT_DIR/lib/run-claude.mjs"');
    assert.ok(
      exportAt > 0 && exportAt < firstCall,
      "ceiling must be exported before any claude call",
    );
  });
});

describe("factory-agent revision effort (ADR-0101)", () => {
  // The real implement_effort, extracted, with only the given env.
  const fn = script.match(/^implement_effort\(\) \{[\s\S]*?^\}\n/m);

  function effortFor(isRevision, env = {}) {
    assert.ok(fn, "implement_effort not found");
    const r = spawnSync(
      "/bin/bash",
      ["-c", `set -euo pipefail\n${fn[0]}\nimplement_effort ${JSON.stringify(isRevision)}`],
      { encoding: "utf8", env: { PATH: process.env.PATH, ...env } },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    return r.stdout;
  }

  it("gives a revision run the revision effort and anything else the coding effort", () => {
    const env = { FACTORY_EFFORT: "ultracode", FACTORY_REVISION_EFFORT: "xhigh" };
    assert.equal(effortFor("1", env), "xhigh\n");
    assert.equal(effortFor("0", env), "ultracode\n");
    assert.equal(effortFor("", env), "ultracode\n");
    // The knob is the operator's: ultracode revisions are one setting away.
    assert.equal(effortFor("1", { ...env, FACTORY_REVISION_EFFORT: "ultracode" }), "ultracode\n");
  });

  it("copes under set -u without the knob block (harness extracts)", () => {
    assert.equal(effortFor("1"), "xhigh\n");
    assert.equal(effortFor("0"), "ultracode\n");
  });

  it("is decided once, after the revision block, and used by both implement paths", () => {
    const loop = script.slice(script.indexOf('    REVISION_COMMENTS="[]"'));
    const decided = loop.indexOf('IMPL_EFFORT=$(implement_effort "$IS_REVISION")');
    assert.ok(decided !== -1, "IMPL_EFFORT is not set from implement_effort");
    assert.ok(loop.indexOf("IS_REVISION=1") < decided, "after the revision block");
    assert.ok(decided < loop.indexOf("    # Acquire a slot"), "before the slot and the runs");
    assert.equal(script.split("IMPL_EFFORT=$(").length - 1, 1, "set in one place");
    // The detached start's spec and log line take the same value.
    const start = script.match(/\nimplement_lane_start\(\) \{[\s\S]*?\n\}\n/)[0];
    assert.match(start, /--arg effort "\$\{IMPL_EFFORT:-\$\{FACTORY_EFFORT:-ultracode\}\}"/);
    assert.match(start, /effort=\$\{IMPL_EFFORT:-\$\{FACTORY_EFFORT:-ultracode\}\}, model=/);
  });

  it("tells the agent its effort through the run-time facts, which both paths send", () => {
    // The prompt's "Revision runs" rule keys off the `effort` fact, so
    // FACTORY_REVISION_EFFORT=ultracode alone restores Workflows on revisions.
    const loop = script.slice(script.indexOf('    REVISION_COMMENTS="[]"'));
    const facts = loop.indexOf(
      'IMPL_FACTS=$(implement_runtime_facts "$IMPL_START_EPOCH" "$IMPL_RESUMED" "$WT_JSON" "$WT_PATH" "$IMPL_EFFORT")',
    );
    assert.ok(facts !== -1, "the run-time facts don't carry IMPL_EFFORT");
    assert.ok(loop.indexOf('IMPL_EFFORT=$(implement_effort "$IS_REVISION")') < facts);
    // CLAUDE_INPUT (with the facts) is built before the sync/detached split.
    assert.ok(facts < loop.indexOf("implement_lane_start"), "before the detached start");
    assert.ok(facts < loop.indexOf('node "$SCRIPT_DIR/lib/run-claude.mjs" -p "$CLAUDE_INPUT"'));
  });
});

describe("factory-agent Claude model knobs (ADR-0080, ADR-0101)", () => {
  const block = script.match(/^MODEL_KNOB_RE=[\s\S]*?^ {2}FACTORY_INTEST_MODEL=""\nfi\n/m);

  // Run the knob block in bash with only the given env, under the factory's
  // own `set -euo pipefail` (bash 3.2 on the Mac mini).
  function runKnobs(env) {
    assert.ok(block, "model knob block not found");
    const r = spawnSync(
      "/bin/bash",
      [
        "-c",
        `set -euo pipefail\n${block[0]}\n` +
          'printf "M=[%s] B=[%s] I=[%s]\\n" "$FACTORY_MODEL" "$FACTORY_BROWSER_MODEL" "$FACTORY_INTEST_MODEL"',
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, ...env } },
    );
    assert.equal(r.status, 0, r.stderr);
    return r;
  }

  const GOOD = [
    "sonnet",
    "opus",
    "haiku",
    "fable",
    "opus[1m]",
    "claude-sonnet-5-5",
    "claude-sonnet-5-5[1m]",
    "claude-opus-4-1-20250805",
  ];
  // A leading dash or a space would smuggle a flag into the call; the rest
  // are typos the CLI would reject on every call.
  const BAD = [
    "--chrome",
    "sonnet --chrome",
    " sonnet",
    "sonnet\n",
    "Sonnet",
    "gpt-5",
    "claude-",
    "claude-x;rm",
    "sonnet[2m]",
    "$(id)",
  ];

  it("defaults FACTORY_MODEL to opus[1m] and both stage knobs to empty (= FACTORY_MODEL)", () => {
    assert.match(script, /^FACTORY_MODEL="\$\{FACTORY_MODEL:-opus\[1m\]\}"/m);
    assert.match(script, /^FACTORY_BROWSER_MODEL="\$\{FACTORY_BROWSER_MODEL:-\}"/m);
    assert.match(script, /^FACTORY_INTEST_MODEL="\$\{FACTORY_INTEST_MODEL:-\}"/m);
    const r = runKnobs({});
    assert.match(r.stdout, /^M=\[opus\[1m\]\] B=\[\] I=\[\]$/m);
    assert.equal(r.stderr, "", "an unset knob is not a warning");
    const empty = runKnobs({
      FACTORY_MODEL: "",
      FACTORY_BROWSER_MODEL: "",
      FACTORY_INTEST_MODEL: "",
    });
    assert.equal(empty.stdout, "M=[opus[1m]] B=[] I=[]\n");
    assert.equal(empty.stderr, "");
  });

  it("keeps an alias or a full claude-… name, with or without [1m]", () => {
    for (const good of GOOD) {
      const r = runKnobs({
        FACTORY_MODEL: good,
        FACTORY_BROWSER_MODEL: good,
        FACTORY_INTEST_MODEL: good,
      });
      assert.equal(r.stdout, `M=[${good}] B=[${good}] I=[${good}]\n`, good);
      assert.equal(r.stderr, "", good);
    }
  });

  it("drops an invalid FACTORY_MODEL to opus[1m] with a warning", () => {
    for (const bad of BAD) {
      const r = runKnobs({ FACTORY_MODEL: bad, FACTORY_BROWSER_MODEL: "sonnet" });
      assert.equal(r.stdout, "M=[opus[1m]] B=[sonnet] I=[]\n", JSON.stringify(bad));
      assert.match(r.stderr, /invalid FACTORY_MODEL='[\s\S]*'; defaulting to opus\[1m\]/);
      assert.doesNotMatch(r.stderr, /FACTORY_BROWSER_MODEL|FACTORY_INTEST_MODEL/);
    }
  });

  it("drops an invalid stage knob to empty (FACTORY_MODEL) with a warning, each on its own", () => {
    for (const bad of BAD) {
      const b = runKnobs({ FACTORY_BROWSER_MODEL: bad, FACTORY_INTEST_MODEL: "sonnet" });
      assert.equal(b.stdout, "M=[opus[1m]] B=[] I=[sonnet]\n", JSON.stringify(bad));
      assert.match(b.stderr, /invalid FACTORY_BROWSER_MODEL='[\s\S]*'; using FACTORY_MODEL/);
      assert.doesNotMatch(b.stderr, /FACTORY_INTEST_MODEL/);
      const i = runKnobs({ FACTORY_BROWSER_MODEL: "opus", FACTORY_INTEST_MODEL: bad });
      assert.equal(i.stdout, "M=[opus[1m]] B=[opus] I=[]\n", JSON.stringify(bad));
      assert.match(i.stderr, /invalid FACTORY_INTEST_MODEL='[\s\S]*'; using FACTORY_MODEL/);
    }
  });

  it("passes --model at every one of the eight calls, always quoted", () => {
    // Eight calls (seven stage calls plus the browser runner), so the effort
    // and --no-chrome counts above hold.
    const calls = script.match(/run-claude\.mjs" -p\b(?:[^\n]*\\\n)*[^\n]*/g) || [];
    assert.equal(calls.length, 8);
    for (const c of calls) {
      assert.equal((c.match(/ --model /g) || []).length, 1, `one --model in: ${c}`);
      // Quoted: unquoted, opus[1m] is a glob.
      assert.match(c, / --model "\$[^"\s]+"/, `--model quoted in: ${c}`);
    }
    // No more optional model arrays: the flag is never absent.
    assert.doesNotMatch(script, /model_args/);
  });

  it("puts --model where no pinned shape breaks", () => {
    // After `--effort … --no-chrome --strict-mcp-config` at the six stage
    // calls, so that run stays adjacent (factory-agent-browser.test.mjs). The
    // /split splitter puts `--tools ""` first; its own test pins that shape.
    for (const [site, model] of [
      ["plan + replan", '"\\$FACTORY_MODEL"'],
      ["code review", '"\\$\\{FACTORY_MODEL:-opus\\[1m\\]\\}"'],
      ["scenario writer", '"\\$intest_model"'],
      ["watch fix", '"\\$FACTORY_MODEL"'],
    ]) {
      assert.match(
        script,
        new RegExp(
          `--effort "\\$FACTORY_[A-Z]+_EFFORT" --no-chrome --strict-mcp-config --model ${model}`,
        ),
        site,
      );
    }
    // Implement: right before the session flag, as buildImplementArgv emits it.
    assert.match(
      script,
      /--effort "\$IMPL_EFFORT" --no-chrome --strict-mcp-config \\\n\s*--model "\$FACTORY_MODEL" "\$IMPL_SESSION_FLAG" "\$IMPL_SESSION_ID" \)/,
    );
    // Browser runner: right before the --effort that ends the call.
    assert.match(
      script,
      /run-claude\.mjs" -p --chrome(?:[^\n]*\\\n){1,3}[^\n]*--session-id "\$uuid" --model "\$runner_model" --effort "\$FACTORY_PLAN_EFFORT" \)/,
    );
  });

  it("resolves the two stage knobs to FACTORY_MODEL when empty, with defaults safe under set -u", () => {
    assert.match(
      script,
      /local runner_model="\$\{FACTORY_BROWSER_MODEL:-\$\{FACTORY_MODEL:-opus\[1m\]\}\}"/,
    );
    assert.match(
      script,
      /local intest_model="\$\{FACTORY_INTEST_MODEL:-\$\{FACTORY_MODEL:-opus\[1m\]\}\}"/,
    );
  });

  it("logs the model at every call", () => {
    for (const re of [
      /Invoking claude for #\$ISSUE_NUM \(--plan, [^\n]*model=\$FACTORY_MODEL, /,
      /Invoking claude for #\$ISSUE_NUM \(--plan replan, [^\n]*model=\$FACTORY_MODEL, /,
      /Invoking claude for #\$issue_num \(code review [^\n]*model=\$\{FACTORY_MODEL:-opus\[1m\]\}\)/,
      /Invoking claude for #\$issue_num \(split, [^\n]*model=\$\{FACTORY_MODEL:-opus\[1m\]\}, /,
      /Invoking claude for #\$issue_num \(In Test scenario, [^\n]*model=\$intest_model\)/,
      /Invoking the browser runner \([^\n]*model=\$runner_model\)/,
      /Invoking claude for #\$ISSUE_NUM \(--implement, [^\n]*model=\$FACTORY_MODEL\)/,
      /Invoking claude for #\$ISSUE_NUM \(--watch fix, [^\n]*model=\$FACTORY_MODEL\)/,
    ]) {
      assert.match(script, re);
    }
  });

  it("hands the verification shell lane FACTORY_MODEL, and the detached implement start too", () => {
    const work = script.match(/\nverify_shell_work\(\) \{[\s\S]*?\n\}\n/)[0];
    assert.match(work, /verify-lane\.mjs" start [\s\S]*?--model "\$\{FACTORY_MODEL:-opus\[1m\]\}"/);
    const start = script.match(/\nimplement_lane_start\(\) \{[\s\S]*?\n\}\n/)[0];
    assert.match(start, /--arg model "\$\{FACTORY_MODEL:-opus\[1m\]\}"/);
    assert.match(start, /model: \$model/);
  });
});
