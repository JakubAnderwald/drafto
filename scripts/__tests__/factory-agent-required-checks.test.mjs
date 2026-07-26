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
      /FAILING=\$\(pr_failing_required "\$PR_VIEW"\)[\s\S]*?required CI green \+ preview/,
    );
    assert.ok(block, "watch advance block not found");
    assert.match(block[0], /if ! ci_required_green "\$PR_VIEW"; then/);
  });

  it("--release park-check uses the required-only failing count", () => {
    const block = script.match(
      /A failing \*required\* check parks the card[\s\S]*?failing required check\(s\); not merging/,
    );
    assert.ok(block, "release CI gate block not found");
    assert.match(block[0], /FAILING=\$\(pr_failing_required "\$PR_VIEW"\)/);
  });

  it("surfaces advisory (non-required) reds in the In Test hand-off comment", () => {
    assert.match(script, /ADVISORY=\$\(pr_failing_advisory "\$PR_VIEW"\)/);
    assert.match(script, /Advisory \(non-required\) checks are not green: \$ADVISORY/);
  });

  it("hands the fix agent only required failures (CI_SUMMARY filtered by \\$req)", () => {
    const block = script.match(
      /CI_SUMMARY=\$\(echo "\$PR_VIEW" \| jq -r --argjson req[\s\S]*?join\("\\n"\)'\)/,
    );
    assert.ok(block, "CI_SUMMARY block not found / not filtered by required set");
    assert.match(block[0], /\$req \| index\(\$n\)/);
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
