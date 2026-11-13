import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The retry budget shared by --plan / --implement / --watch (ADR-0076). It was
// 5 until #797 was parked in Blocked over a one-line docs nit: review-thread
// fix passes spend from the same budget, and two of its five attempts had gone
// to factory-side failures. The guard matters as much as the default: a value
// bash can't compare (e.g. "08", read as invalid octal) would turn every
// `-ge "$FACTORY_MAX_ATTEMPTS"` check into an unlimited budget.

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "factory-agent.sh");
const script = readFileSync(scriptPath, "utf8");

describe("every retry-budget check reads FACTORY_MAX_ATTEMPTS", () => {
  // The plan, replan and orphan-rescue paths used to compare against a
  // hard-coded 5, so planning ignored the knob (and a plist override) while
  // --implement and --watch honoured it.
  it("compares $ATTEMPTS only against the knob, never a literal", () => {
    assert.doesNotMatch(script, /"\$ATTEMPTS" -(?:ge|gt|eq) \d/);
    const checks = script.match(/"\$ATTEMPTS" -ge "\$FACTORY_MAX_ATTEMPTS"/g) || [];
    // orphan rescue, plan, replan, implement, watch
    assert.equal(checks.length, 5);
  });
});

const block = (() => {
  const m = script.match(
    /^FACTORY_MAX_ATTEMPTS="\$\{FACTORY_MAX_ATTEMPTS:-\d+\}"\n(?:#[^\n]*\n)*if [^\n]*\n[\s\S]*?\nfi\n/m,
  );
  assert.ok(m, "could not locate the FACTORY_MAX_ATTEMPTS default and its guard");
  return m[0];
})();

// Run the real default + guard with FACTORY_MAX_ATTEMPTS set (or unset) and
// return the resolved value and anything written to stderr.
function resolveBudget(value) {
  const env = { PATH: process.env.PATH };
  if (value !== undefined) env.FACTORY_MAX_ATTEMPTS = value;
  const r = spawnSync("bash", ["-c", `set -euo pipefail\n${block}\necho "$FACTORY_MAX_ATTEMPTS"`], {
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
  return { value: r.stdout.trim(), stderr: r.stderr };
}

describe("factory retry budget (FACTORY_MAX_ATTEMPTS)", () => {
  it("defaults to 10", () => {
    assert.match(block, /FACTORY_MAX_ATTEMPTS="\$\{FACTORY_MAX_ATTEMPTS:-10\}"/);
    assert.equal(resolveBudget().value, "10");
  });

  it("keeps a valid override from the plist", () => {
    assert.deepEqual(resolveBudget("7"), { value: "7", stderr: "" });
    assert.equal(resolveBudget("12").value, "12");
  });

  for (const bad of ["abc", "0", "08", "-3", " 5", ""]) {
    it(`falls back to 10 with a warning on ${JSON.stringify(bad)}`, () => {
      const { value, stderr } = resolveBudget(bad);
      assert.equal(value, "10");
      // An empty value is the unset case: ${VAR:-10} supplies the default.
      if (bad !== "")
        assert.match(stderr, /WARNING: invalid FACTORY_MAX_ATTEMPTS=.*defaulting to 10/);
    });
  }
});
