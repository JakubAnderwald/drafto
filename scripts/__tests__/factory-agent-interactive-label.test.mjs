import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// driver:interactive (ADR-0091): an interactive Claude Code session owns the
// card, so every factory mode must skip it exactly as it skips factory-pause.
// The skip lives in one helper, card_opted_out; these tests pin its behaviour
// and that no guard checks factory-pause on its own (which would let the
// factory work a card a session is driving).

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "factory-agent.sh");
const script = readFileSync(agentPath, "utf8");

function optedOut(labels) {
  const r = spawnSync(
    "/bin/bash",
    [
      "-c",
      `set -euo pipefail
eval "$(awk '/^card_opted_out\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
if reason=$(card_opted_out "$LABELS"); then echo "yes:$reason"; else echo "no:$reason"; fi`,
    ],
    { encoding: "utf8", env: { ...process.env, LABELS: labels } },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

describe("card_opted_out", () => {
  it("opts out factory-pause and driver:interactive cards, with the reason", () => {
    assert.equal(optedOut("bug,factory-pause"), "yes:factory-pause label set");
    assert.equal(
      optedOut("driver:interactive,status:in-review"),
      "yes:driver:interactive label set — an interactive session owns it",
    );
  });

  it("leaves every other card to the factory", () => {
    assert.equal(optedOut(""), "no:");
    assert.equal(optedOut("status:ready,support"), "no:");
    // Whole labels only: a label that merely contains the name doesn't count.
    assert.equal(optedOut("not-driver:interactive,factory-pause-later"), "no:");
  });
});

describe("every per-card skip goes through card_opted_out", () => {
  it("has no bare factory-pause guard left outside the helper", () => {
    const helper = script.slice(script.indexOf("\ncard_opted_out() {"));
    const outside = script.replace(helper.slice(0, helper.indexOf("\n}\n") + 3), "");
    assert.doesNotMatch(outside, /",factory-pause,"\*/);
  });

  it("guards each column-walking mode", () => {
    // Testing sweep, plan rescue, --plan (Ready), Plan Review, --implement,
    // --watch In Review, the In Test sweep and --release.
    const guards = script.match(/card_opted_out "\$(ITEM_LABELS|item_labels)"/g) ?? [];
    assert.equal(guards.length, 8);
  });

  it("holds a detached implement run's result while a session owns the card", () => {
    const start = script.indexOf("\nimplement_lane_card_check() {");
    const fn = script.slice(start, script.indexOf("\n}\n", start));
    assert.match(fn, /index\("factory-pause"\) != null or index\("driver:interactive"\) != null/);
  });

  it("re-checks before a browser run", () => {
    assert.match(
      script,
      /select\(\(\(\.labels \/\/ \[\]\) \| index\("factory-pause"\)\) == null\)\n\s+\| select\(\(\(\.labels \/\/ \[\]\) \| index\("driver:interactive"\)\) == null\)/,
    );
  });

  it("creates the label with the others", () => {
    const labels = readFileSync(resolve(HERE, "..", "setup-factory-labels.sh"), "utf8");
    assert.match(labels, /"driver:interactive\|[0-9A-F]{6}\|/);
  });
});
