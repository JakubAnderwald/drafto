// Status-label plumbing in factory-agent.sh: the Testing column (ADR-0053)
// and transition_status's label swap.
//
// transition_status used to pass `--remove-label` for every name in
// ALL_STATUS_LABELS. gh resolves each one to a REPO label id first and fails
// the whole removal on a name the repo doesn't have — so adding
// status:testing to the list before scripts/setup-factory-labels.sh had run
// would leave every card carrying its old status:* label, and the --watch
// cleanup sweep would keep holding slots for cards that had moved on. The swap
// now removes only the status labels the issue actually carries.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "factory-agent.sh");
const script = readFileSync(agentPath, "utf8");

function extract(name) {
  const start = script.indexOf(`\n${name}() {`);
  assert.ok(start !== -1, `could not find ${name}()`);
  const end = script.indexOf("\n}\n", start);
  assert.ok(end !== -1, `could not find the end of ${name}()`);
  return script.slice(start + 1, end + 2);
}

const allStatusLine = (() => {
  const m = script.match(/^ALL_STATUS_LABELS="[^"]+"$/m);
  assert.ok(m, "could not find ALL_STATUS_LABELS");
  return m[0];
})();

// Run the real transition_status with gh / node stubbed. Under /bin/bash on
// purpose: on macOS that's bash 3.2, which is what launchd runs, and an empty
// array under `set -u` is an error there.
function runTransition({ newStatus, issueLabels = [], viewFails = false }) {
  const dir = mkdtempSync(join(tmpdir(), "factory-transition-"));
  const calls = join(dir, "calls.log");
  writeFileSync(calls, "");
  try {
    const harness = [
      "set -euo pipefail",
      'SCRIPT_DIR="/stub"',
      "LOG_FILE=/dev/null",
      `STATE_FILE="${join(dir, "state.json")}"`,
      `CALLS="${calls}"`,
      `VIEW_FAILS=${viewFails ? 1 : 0}`,
      'log() { echo "LOG: $*" >&2; }',
      'node() { printf "node|%s\\n" "$*" >> "$CALLS"; }',
      "gh() {",
      '  { printf "gh"; printf "|%s" "$@"; printf "\\n"; } >> "$CALLS"',
      '  if [[ "$1 $2" == "issue view" ]]; then',
      '    [[ "$VIEW_FAILS" -eq 1 ]] && return 1',
      '    [[ -n "$ISSUE_LABELS" ]] && printf "%s\\n" "$ISSUE_LABELS"',
      "    return 0",
      "  fi",
      "  return 0",
      "}",
      allStatusLine,
      extract("status_label_for"),
      extract("transition_status"),
      `transition_status ITEM_1 42 ${JSON.stringify(newStatus)}`,
    ].join("\n");
    // Via the environment: a newline inside a double-quoted bash string would
    // stay a literal backslash-n.
    const res = spawnSync("/bin/bash", ["-c", harness], {
      encoding: "utf8",
      env: { ...process.env, ISSUE_LABELS: issueLabels.join("\n") },
    });
    assert.equal(res.status, 0, res.stderr);
    const lines = readFileSync(calls, "utf8").split("\n").filter(Boolean);
    const edit = lines.find((l) => l.startsWith("gh|issue|edit|"));
    assert.ok(edit, `no gh issue edit call: ${lines.join("\n")}`);
    const args = edit.split("|").slice(1);
    const removed = [];
    const added = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--remove-label") removed.push(args[i + 1]);
      if (args[i] === "--add-label") added.push(args[i + 1]);
    }
    return { lines, added, removed, stderr: res.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("transition_status label swap", () => {
  it("removes only the status labels the issue carries", () => {
    const r = runTransition({
      newStatus: "In Test",
      issueLabels: ["bug", "status:in-review", "parity:web-only"],
    });
    assert.deepEqual(r.added, ["status:in-test"]);
    assert.deepEqual(r.removed, ["status:in-review"]);
    assert.ok(!r.removed.includes("status:testing"), "never names a label the issue lacks");
    // The board write still precedes the label swap.
    assert.match(r.lines[0], /^node\|.*set-status --item-id ITEM_1 --status In Test/);
  });

  it("sends no --remove-label at all when nothing needs removing (bash 3.2, set -u)", () => {
    const r = runTransition({ newStatus: "In Review", issueLabels: ["status:in-review"] });
    assert.deepEqual(r.added, ["status:in-review"]);
    assert.deepEqual(r.removed, []);
  });

  it("handles an issue with no labels", () => {
    const r = runTransition({ newStatus: "Planning", issueLabels: [] });
    assert.deepEqual(r.added, ["status:planning"]);
    assert.deepEqual(r.removed, []);
  });

  it("falls back to every other status label when the issue can't be read", () => {
    const r = runTransition({ newStatus: "In Test", viewFails: true });
    const all = allStatusLine.replace(/^ALL_STATUS_LABELS="|"$/g, "").split(",");
    assert.deepEqual(
      r.removed,
      all.filter((l) => l !== "status:in-test"),
    );
  });

  it("moves a card to Testing with status:testing", () => {
    const r = runTransition({ newStatus: "Testing", issueLabels: ["status:in-review"] });
    assert.deepEqual(r.added, ["status:testing"]);
    assert.deepEqual(r.removed, ["status:in-review"]);
  });

  it("strips status:testing when a card leaves Testing", () => {
    const r = runTransition({ newStatus: "In Test", issueLabels: ["status:testing"] });
    assert.deepEqual(r.removed, ["status:testing"]);
  });
});

describe("transition_status bash 3.2 guard (static)", () => {
  // The runtime test above only exercises bash 3.2 on macOS; Linux CI's
  // /bin/bash allows an empty array under `set -u`. Pin the idiom itself.
  it("expands remove_args with the ${arr[@]+...} guard", () => {
    assert.match(
      extract("transition_status"),
      /--add-label "\$new_label" \$\{remove_args\[@\]\+"\$\{remove_args\[@\]\}"\}/,
    );
  });
});

describe("Testing column wiring", () => {
  it("lists status:testing between in-review and in-test", () => {
    assert.match(allStatusLine, /status:in-review,status:testing,status:in-test/);
  });

  it("keeps a Testing card's slot + worktree in the cleanup sweep", () => {
    const start = script.indexOf("  # ── 1. Cleanup sweep ──");
    const end = script.indexOf("  # ── 2.", start);
    assert.ok(start !== -1 && end !== -1, "could not find the cleanup sweep block");
    const sweep = script.slice(start, end);
    assert.match(sweep, /STILL_ACTIVE=[\s\S]*?\. == "status:testing"/);
  });

  it("moves a card into Testing only on the verification stage's two paths (ADR-0053)", () => {
    // verify_enter (In Review → Testing) and the revision no-op path, both
    // behind verify_target_status, so FACTORY_VERIFY=0 never reaches either.
    const moves = script.match(/transition_status "[^"]*" "[^"]*" "Testing"/g) || [];
    assert.equal(moves.length, 2, moves.join("\n"));
    assert.match(extract("verify_enter"), /transition_status "\$item_id" "\$issue_num" "Testing"/);
    assert.match(
      script,
      /if verify_target_status "\$ISSUE_NUM" "\$PRE_HEAD_OID" "\$ITEM_LABELS" \\\n\s*&& transition_status "\$ITEM_ID" "\$ISSUE_NUM" "Testing"; then/,
    );
  });
});
