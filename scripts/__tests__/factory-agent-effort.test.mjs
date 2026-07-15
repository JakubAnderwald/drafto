import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The dark factory must invoke `claude` at an explicit effort on every call:
// ultracode on the code-writing stages (--implement/--watch) and xhigh on the
// read-only planning stages (--plan/replan). See ADR-0029. Locking the flag —
// and its validation guards — in against a refactor that drops it: a silent
// regression would send the factory back to whatever ambient effort the host
// happens to default to, which is exactly the drift this change removed.

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "factory-agent.sh");
const script = readFileSync(scriptPath, "utf8");

describe("factory-agent Claude effort", () => {
  it("passes --effort at all four Claude call sites", () => {
    // Two plan sites (plan + replan) use the plan effort; two coding sites
    // (implement + watch) use the coding effort. Four total.
    const planFlags =
      script.match(/--dangerously-skip-permissions --effort "\$FACTORY_PLAN_EFFORT"/g) || [];
    const codeFlags =
      script.match(/--dangerously-skip-permissions --effort "\$FACTORY_EFFORT"/g) || [];
    assert.equal(
      planFlags.length,
      2,
      'expected --effort "$FACTORY_PLAN_EFFORT" at the plan + replan sites',
    );
    assert.equal(
      codeFlags.length,
      2,
      'expected --effort "$FACTORY_EFFORT" at the implement + watch sites',
    );
    assert.equal(
      planFlags.length + codeFlags.length,
      4,
      "every factory Claude call must carry an effort flag",
    );
  });

  it("defaults FACTORY_EFFORT to ultracode and FACTORY_PLAN_EFFORT to xhigh", () => {
    assert.match(script, /FACTORY_EFFORT="\$\{FACTORY_EFFORT:-ultracode\}"/);
    assert.match(script, /FACTORY_PLAN_EFFORT="\$\{FACTORY_PLAN_EFFORT:-xhigh\}"/);
  });

  it("validates both effort knobs against a known allowlist with a fallback", () => {
    // A case allowlist guards word-splitting / empty values (bash 3.2 safe) and
    // falls back to a safe default on an unknown level.
    assert.match(script, /ultracode\|max\|xhigh\|high\|medium\|low\)/);
    assert.match(script, /defaulting to ultracode/);
    assert.match(script, /defaulting to xhigh/);
  });

  it("raises the plan/replan timeout to a knob (FACTORY_PLAN_TIMEOUT_SEC)", () => {
    assert.match(script, /FACTORY_PLAN_TIMEOUT_SEC:-\$\{CLAUDE_CALL_TIMEOUT_SEC:-360\}/);
  });
});
