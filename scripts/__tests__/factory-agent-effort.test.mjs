import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The dark factory must invoke `claude` at an explicit effort on every call:
// ultracode on --implement, xhigh on --watch fix passes (ADR-0076) and xhigh on
// the read-only planning stages (--plan/replan). See ADR-0029. Locking the flag —
// and its validation guards — in against a refactor that drops it: a silent
// regression would send the factory back to whatever ambient effort the host
// happens to default to, which is exactly the drift this change removed.

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "factory-agent.sh");
const script = readFileSync(scriptPath, "utf8");

describe("factory-agent Claude effort", () => {
  it("passes --effort at all six Claude call sites", () => {
    // Four read-only sites (plan + replan + In Test scenario + code review) use
    // the plan effort; the implement site uses the coding effort and the watch
    // fix site its own (ADR-0076).
    const planFlags =
      script.match(/--dangerously-skip-permissions --effort "\$FACTORY_PLAN_EFFORT"/g) || [];
    const codeFlags =
      script.match(/--dangerously-skip-permissions --effort "\$FACTORY_EFFORT"/g) || [];
    const watchFlags =
      script.match(/--dangerously-skip-permissions --effort "\$FACTORY_WATCH_EFFORT"/g) || [];
    assert.equal(
      planFlags.length,
      4,
      'expected --effort "$FACTORY_PLAN_EFFORT" at the plan + replan + In Test + review sites',
    );
    assert.equal(codeFlags.length, 1, 'expected --effort "$FACTORY_EFFORT" at the implement site');
    assert.equal(
      watchFlags.length,
      1,
      'expected --effort "$FACTORY_WATCH_EFFORT" at the watch fix site',
    );
    assert.equal(
      planFlags.length + codeFlags.length + watchFlags.length,
      6,
      "every factory Claude call must carry an effort flag",
    );
  });

  it("runs --implement at the coding effort and --watch fix passes at the watch effort", () => {
    // ADR-0076: at ultracode a watch fix pass finished its fix, then started a
    // review workflow and waited on it until the 1800s cap killed it with
    // nothing committed (#797). The log line and the flag must agree.
    const implement = script.match(/Invoking claude for #\$ISSUE_NUM \(--implement[\s\S]{0,600}/);
    assert.ok(implement, "implement claude invocation not found");
    assert.match(implement[0], /effort=\$FACTORY_EFFORT\)/);
    assert.match(implement[0], /--effort "\$FACTORY_EFFORT"/);
    const watch = script.match(/Invoking claude for #\$ISSUE_NUM \(--watch fix[\s\S]{0,600}/);
    assert.ok(watch, "watch fix claude invocation not found");
    assert.match(watch[0], /effort=\$FACTORY_WATCH_EFFORT\)/);
    assert.match(watch[0], /--effort "\$FACTORY_WATCH_EFFORT"/);
    assert.doesNotMatch(watch[0], /--effort "\$FACTORY_EFFORT"/);
  });

  it("runs the browser runner (the seventh call) at the read-only (plan) effort", () => {
    // ADR-0051: the locked-down Chrome runner has no --dangerously-skip-
    // permissions, so the counts above don't see it. It reads pages and prints
    // a report — plan-tier effort, like the scenario writer.
    const calls = script.match(/run-claude\.mjs" -p\b/g) || [];
    assert.equal(calls.length, 7, "six stage calls plus the browser runner");
    assert.match(
      script,
      /run-claude\.mjs" -p --chrome(?:[^\n]*\\\n){1,3}[^\n]*--effort "\$FACTORY_PLAN_EFFORT" \)/,
    );
  });

  it("runs the In Test scenario writer at the read-only (plan) effort", () => {
    // It reads a diff and posts a comment — no code is written, so it must not
    // burn the coding-tier effort budget.
    const block = script.match(/Invoking claude for #\$issue_num \(In Test scenario[\s\S]{0,800}/);
    assert.ok(block, "In Test claude invocation not found");
    assert.match(block[0], /--effort "\$FACTORY_PLAN_EFFORT"/);
  });

  it("defaults FACTORY_EFFORT to ultracode, FACTORY_WATCH_EFFORT and FACTORY_PLAN_EFFORT to xhigh", () => {
    assert.match(script, /FACTORY_EFFORT="\$\{FACTORY_EFFORT:-ultracode\}"/);
    assert.match(script, /FACTORY_WATCH_EFFORT="\$\{FACTORY_WATCH_EFFORT:-xhigh\}"/);
    assert.match(script, /FACTORY_PLAN_EFFORT="\$\{FACTORY_PLAN_EFFORT:-xhigh\}"/);
  });

  it("validates every effort knob against a known allowlist with a fallback", () => {
    // A case allowlist guards word-splitting / empty values (bash 3.2 safe) and
    // falls back to a safe default on an unknown level.
    for (const knob of ["FACTORY_EFFORT", "FACTORY_WATCH_EFFORT", "FACTORY_PLAN_EFFORT"]) {
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
