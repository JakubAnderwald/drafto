// ADR-0079: no migration-version collisions between open factory PRs.
//
// The implement prompt named every new migration <today>000001, so two cards
// implemented the same day took the same version (#802 and #829 both added
// 20261111000001). Now --implement hands the implementer a version clear of
// main and of every open PR's (build_implement_bundle's `migrations`), and
// after the run moves the new PR off any version an older open PR also adds
// (implement_migration_claim_check). These tests run the real bash functions
// with only node's helper, gh and the gate stubbed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..");
const AGENT = resolve(SCRIPTS, "factory-agent.sh");
const script = readFileSync(AGENT, "utf8");

const extract = (fn) => `eval "$(awk '/^${fn}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${AGENT}")"`;

const body = (schema) =>
  [
    "### What",
    "",
    "Add a quota.",
    "",
    "### Affected platforms",
    "",
    "- [x] web (`apps/web`)",
    "",
    "### Schema changes?",
    "",
    schema,
    "",
  ].join("\n");

function bash(snippet, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "implement-migrations-"));
  try {
    const r = spawnSync("bash", ["-c", snippet], {
      encoding: "utf8",
      env: { ...process.env, DIR: dir, ...env },
    });
    let calls = "";
    try {
      calls = readFileSync(join(dir, "calls"), "utf8");
    } catch {
      // No calls file: nothing was recorded.
    }
    return { ...r, calls: calls.split("\n").filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("build_implement_bundle — migrations (ADR-0079)", () => {
  const NEXT = {
    mainNewest: "20261112000002",
    nextVersion: "20261113000002",
    claimed: [{ pr: 829, file: "20261113000001_note_text_chars.sql" }],
    skipped: [{ pr: 840 }],
  };
  // The real builder and allocator, the real factory-bundle.mjs; only the
  // next-version helper is stubbed ($NEXT is its stdout, "fail" a failure).
  function build(schema, next = JSON.stringify(NEXT)) {
    const snippet = `
set -euo pipefail
CALLS="$DIR/calls"; : >"$CALLS"
LOG_FILE="$DIR/log"
SCRIPT_DIR="${SCRIPTS}"; REPO_ROOT="$DIR"
SUPPORT_ALLOWLIST="a@example.com"; OAUTH_USER_EMAIL="s@example.com"; PHASE="C"
log() { echo "LOG $*" >>"$CALLS"; }
logerr() { echo "LOGERR $*" >>"$CALLS"; }
node() {
  if [[ "$1" == *migration-renumber.mjs ]]; then
    echo "HELPER \${*:2}" >>"$CALLS"
    [[ "$NEXT" == fail ]] && return 1
    printf '%s\\n' "$NEXT"
    return 0
  fi
  command node "$@"
}
${extract("build_implement_bundle")}
${extract("implement_migration_versions")}
build_implement_bundle "$ISSUE" null null 0 "[]" "[]" "[]" ""
`;
    const issue = JSON.stringify({ number: 794, title: "t", body: body(schema), labels: [] });
    const r = bash(snippet, { ISSUE: issue, NEXT: next });
    assert.equal(r.status, 0, r.stderr);
    return { bundle: JSON.parse(r.stdout), calls: r.calls };
  }

  it("asks the helper for a version when the spec says schema changes", () => {
    const { bundle, calls } = build("yes");
    assert.deepEqual(bundle.migrations, {
      mainNewest: "20261112000002",
      nextVersion: "20261113000002",
      claimed: [{ pr: 829, file: "20261113000001_note_text_chars.sql", version: "20261113000001" }],
    });
    // This card's own PR isn't excluded: a revision must not reuse its version.
    assert.ok(
      calls.some((c) => /^HELPER next-version --root \S+$/.test(c)),
      calls.join("\n"),
    );
    assert.equal(bundle.kind, "factory_implement");
    assert.equal(bundle.issue.number, 794);
  });

  it("never runs the helper for a card without schema changes", () => {
    for (const schema of ["no", ""]) {
      const { bundle, calls } = build(schema);
      assert.equal(bundle.migrations, null);
      assert.ok(!calls.some((c) => c.startsWith("HELPER")), schema);
    }
  });

  it("falls back to null with a warning when the helper fails, and still builds", () => {
    for (const next of ["fail", "not json", '{"nextVersion":null}']) {
      const { bundle, calls } = build("yes", next);
      assert.equal(bundle.migrations, null, next);
      assert.equal(bundle.kind, "factory_implement");
      assert.ok(
        calls.some((c) =>
          /^LOGERR WARNING: couldn't pick a migration version for the implement bundle/.test(c),
        ),
        next,
      );
      // stdout is the bundle: no log line may land in it (JSON.parse passed).
      assert.ok(!calls.some((c) => c.startsWith("LOG ")));
    }
  });
});

describe("implement_migration_claim_check (ADR-0079)", () => {
  function check(result) {
    const snippet = `
set -euo pipefail
CALLS="$DIR/calls"; : >"$CALLS"
log() { echo "LOG $*" >>"$CALLS"; }
pr_head_oid() { echo "HEADOID $1" >>"$CALLS"; echo "${"a".repeat(40)}"; }
migration_renumber_gate() {
  echo "GATE $(printf '<%s>' "$@")" >>"$CALLS"
  MIGRATION_RENUMBER_RESULT="${result}"
  [[ "${result}" == clean ]]
}
${extract("implement_migration_claim_check")}
if implement_migration_claim_check 794 835; then echo "RC=0"; else echo "RC=$?"; fi
`;
    const r = bash(snippet);
    assert.equal(r.status, 0, r.stderr);
    return { out: r.stdout.trim(), calls: r.calls };
  }

  it("runs the gate in claimed mode on the PR's current head", () => {
    const { out, calls } = check("renumbered");
    assert.equal(out, "RC=0");
    assert.deepEqual(calls.slice(0, 2), [
      "HEADOID 835",
      `GATE <794><835><${"a".repeat(40)}><In Progress><><claimed>`,
    ]);
  });

  it("never blocks the implement: every result returns 0, failures are logged", () => {
    for (const result of ["clean", "renumbered"]) {
      const { out, calls } = check(result);
      assert.equal(out, "RC=0", result);
      assert.ok(!calls.some((c) => c.startsWith("LOG")), result);
    }
    for (const result of ["manual", "capped", "error"]) {
      const { out, calls } = check(result);
      assert.equal(out, "RC=0", result);
      assert.ok(
        calls.some((c) =>
          c.startsWith(
            `LOG Issue #794: migration version post-check on PR #835 ended '${result}'; going on`,
          ),
        ),
        result,
      );
    }
  });
});

describe("factory-agent.sh --implement — migration post-check wiring (ADR-0079)", () => {
  const start = script.indexOf("      implemented)");
  const arm = script.slice(start, script.indexOf("      noop)", start));

  it("runs after the parity post-check and before the move to In Review, without blocking", () => {
    const parityAt = arm.indexOf("if ! implement_parity_gate ");
    const checkAt = arm.indexOf('implement_migration_claim_check "$ISSUE_NUM" "$PR_NUM"\n');
    const moveAt = arm.indexOf('transition_status "$ITEM_ID" "$ISSUE_NUM" "In Review"');
    assert.ok(parityAt !== -1 && checkAt !== -1 && moveAt !== -1);
    assert.ok(parityAt < checkAt, "a parity violation parks the card before any renumber");
    assert.ok(checkAt < moveAt, "the card reaches In Review with the renumbered head");
    // A plain call: nothing in the implement depends on its result.
    assert.match(arm, /\n {8}implement_migration_claim_check "\$ISSUE_NUM" "\$PR_NUM"\n/);
  });

  it("runs only on the implemented arm", () => {
    assert.equal((script.match(/implement_migration_claim_check "\$ISSUE_NUM"/g) || []).length, 1);
  });
});
