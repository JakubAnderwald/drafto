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
  const VERSIONS = ["20261113000002", "20261113000003", "20261113000004"];
  const NEXT = {
    mainNewest: "20261112000002",
    ownNewest: null,
    versions: VERSIONS,
    claimed: [{ pr: 829, file: "20261113000001_note_text_chars.sql" }],
    skipped: [840],
  };
  // The real builder and allocator, the real factory-bundle.mjs; only the
  // next-version helper is stubbed ($NEXT is its stdout, "fail" a failure).
  // FAIL_SECOND_BUILD makes the second factory-bundle.mjs run fail.
  function build(schema, next = JSON.stringify(NEXT), { priorPr = "null", failSecond = 0 } = {}) {
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
  if [[ "$1" == *factory-bundle.mjs ]]; then
    echo x >>"$DIR/builds"
    if [[ "$FAIL_SECOND_BUILD" == 1 && $(wc -l <"$DIR/builds") -ge 2 ]]; then
      cat >/dev/null
      return 1
    fi
  fi
  command node "$@"
}
${extract("build_implement_bundle")}
${extract("implement_migration_versions")}
build_implement_bundle "$ISSUE" null "$PRIOR_PR" 0 "[]" "[]" "[]" ""
`;
    const issue = JSON.stringify({ number: 794, title: "t", body: body(schema), labels: [] });
    const r = bash(snippet, {
      ISSUE: issue,
      NEXT: next,
      PRIOR_PR: priorPr,
      FAIL_SECOND_BUILD: String(failSecond),
    });
    assert.equal(r.status, 0, r.stderr);
    return { bundle: JSON.parse(r.stdout), calls: r.calls };
  }

  it("asks the helper for versions when the spec says schema changes", () => {
    const { bundle, calls } = build("yes");
    assert.deepEqual(bundle.migrations, {
      mainNewest: "20261112000002",
      ownNewest: null,
      versions: VERSIONS,
      claimed: [{ pr: 829, file: "20261113000001_note_text_chars.sql", version: "20261113000001" }],
      claimedComplete: true,
    });
    // A first implementation has no PR of its own.
    assert.ok(
      calls.some((c) => /^HELPER next-version --root \S+$/.test(c)),
      calls.join("\n"),
    );
    assert.equal(bundle.kind, "factory_implement");
    assert.equal(bundle.issue.number, 794);
  });

  // A revision: its own PR's migrations raise the floor instead of being claims.
  it("names the card's own PR on a revision", () => {
    const priorPr = JSON.stringify({
      number: 835,
      url: "u",
      headRef: "factory/issue-794",
      state: "OPEN",
    });
    const { bundle, calls } = build(
      "yes",
      JSON.stringify({ ...NEXT, ownNewest: "20261113000001" }),
      { priorPr },
    );
    assert.ok(
      calls.some((c) => /^HELPER next-version --root \S+ --own-pr 835$/.test(c)),
      calls.join("\n"),
    );
    assert.equal(bundle.migrations.ownNewest, "20261113000001");
  });

  it("never runs the helper for a card without schema changes", () => {
    for (const schema of ["no", ""]) {
      const { bundle, calls } = build(schema);
      assert.equal(bundle.migrations, null);
      assert.ok(!calls.some((c) => c.startsWith("HELPER")), schema);
    }
  });

  it("falls back to null with a warning when the helper fails, and still builds", () => {
    for (const next of [
      "fail",
      "not json",
      '{"versions":[]}',
      '{"nextVersion":"20261113000001"}',
    ]) {
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

  // The versions are a help, not a precondition: a failed rebuild keeps the first bundle.
  it("keeps the first bundle, with a warning, when the rebuild with versions fails", () => {
    const { bundle, calls } = build("yes", JSON.stringify(NEXT), { failSecond: 1 });
    assert.equal(bundle.kind, "factory_implement");
    assert.equal(bundle.issue.number, 794);
    assert.equal(bundle.migrations, null);
    assert.ok(
      calls.some((c) =>
        /^LOGERR WARNING: couldn't add the migration versions to the implement bundle/.test(c),
      ),
      calls.join("\n"),
    );
  });
});

describe("implement_migration_claim_check (ADR-0079)", () => {
  const HEAD = "a".repeat(40);
  function check(result, args = `"${HEAD}" all ""`) {
    const snippet = `
set -euo pipefail
CALLS="$DIR/calls"; : >"$CALLS"
log() { echo "LOG $*" >>"$CALLS"; }
pr_head_oid() { echo "HEADOID $1" >>"$CALLS"; echo "${"b".repeat(40)}"; }
migration_renumber_gate() {
  echo "GATE $(printf '<%s>' "$@")" >>"$CALLS"
  MIGRATION_RENUMBER_RESULT="${result}"
  [[ "${result}" == clean ]]
}
${extract("implement_migration_claim_check")}
if implement_migration_claim_check 794 835 ${args}; then echo "RC=0"; else echo "RC=$?"; fi
`;
    const r = bash(snippet);
    assert.equal(r.status, 0, r.stderr);
    return { out: r.stdout.trim(), calls: r.calls };
  }

  // The head bash read after the run, and the bundle's claims: no gh pr view, no sweep.
  it("runs the gate in claimed mode on the head it was given, with the claims and the old head", () => {
    const claims = '[{"pr":829,"file":"20261113000001_x.sql"}]';
    const { out, calls } = check("renumbered", `"${HEAD}" "${"c".repeat(40)}" '${claims}'`);
    assert.equal(out, "RC=0");
    assert.deepEqual(calls.slice(0, 1), [
      `GATE <794><835><${HEAD}><In Progress><><claimed><${claims}><${"c".repeat(40)}>`,
    ]);
    assert.ok(!calls.some((c) => c.startsWith("HEADOID")), "no second read of the head");
  });

  it("reads the head only when it wasn't given (a fresh PR)", () => {
    const { calls } = check("clean", `"" all ""`);
    assert.deepEqual(calls.slice(0, 2), [
      "HEADOID 835",
      `GATE <794><835><${"b".repeat(40)}><In Progress><><claimed><><all>`,
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
  const CALL =
    'implement_migration_claim_check "$ISSUE_NUM" "$PR_NUM" "$CLAIM_HEAD" "$CLAIM_SINCE" "$CLAIM_JSON"';

  it("runs after the parity post-check and before the move to In Review, without blocking", () => {
    const parityAt = arm.indexOf("if ! implement_parity_gate ");
    const checkAt = arm.indexOf(`${CALL}\n`);
    const moveAt = arm.indexOf('transition_status "$ITEM_ID" "$ISSUE_NUM" "In Review"');
    assert.ok(parityAt !== -1 && checkAt !== -1 && moveAt !== -1);
    assert.ok(parityAt < checkAt, "a parity violation parks the card before any renumber");
    assert.ok(checkAt < moveAt, "the card reaches In Review with the renumbered head");
    // A plain call: nothing in the implement depends on its result.
    assert.ok(arm.includes(`\n        ${CALL}\n`));
  });

  // A revision reuses POST_HEAD_OID and names the head before the run; a fresh
  // PR has neither, so every migration it adds counts as the run's.
  it("passes the head it read, the head before the run, and the bundle's claims", () => {
    const block = arm.slice(arm.indexOf('CLAIM_HEAD=""'), arm.indexOf(CALL));
    assert.match(block, /^CLAIM_HEAD=""\n\s+CLAIM_SINCE="all"\n/);
    assert.match(
      block,
      /if \[\[ -n "\$PRE_HEAD_OID" \]\]; then\n\s+CLAIM_HEAD="\$POST_HEAD_OID"\n\s+CLAIM_SINCE="\$PRE_HEAD_OID"\n\s+fi/,
    );
    assert.match(
      block,
      /CLAIM_JSON=\$\(jq -c 'if \.migrations\.claimedComplete == true then \(\.migrations\.claimed \| map\(\{pr, file\}\)\) else empty end' <<<"\$BUNDLE"/,
    );
    // POST_HEAD_OID is read earlier in this arm, only on a revision.
    assert.ok(arm.indexOf('POST_HEAD_OID=$(pr_head_oid "$PR_NUM")') < arm.indexOf(CALL));
  });

  // The bundle shapes its claims for the model and can drop one (an odd
  // name, a non-14-digit version, the cap). The post-check reuses them only
  // when none was dropped; otherwise it gets no --claimed-json and sweeps.
  it("turns complete bundle claims into --claimed-json, and nothing otherwise", () => {
    const expr = arm
      .slice(arm.indexOf("CLAIM_JSON=$(jq -c '"))
      .match(/CLAIM_JSON=\$\(jq -c '([^']+)'/)[1];
    const jq = (bundle) =>
      spawnSync("jq", ["-c", expr], {
        input: JSON.stringify(bundle),
        encoding: "utf8",
      }).stdout.trim();
    const claimed = [{ pr: 829, file: "20261113000001_x.sql", version: "20261113000001" }];
    assert.equal(
      jq({ migrations: { claimed, claimedComplete: true } }),
      '[{"pr":829,"file":"20261113000001_x.sql"}]',
    );
    assert.equal(jq({ migrations: { claimed: [], claimedComplete: true } }), "[]");
    assert.equal(jq({ migrations: { claimed, claimedComplete: false } }), "");
    assert.equal(jq({ migrations: { claimed } }), "");
    assert.equal(jq({ migrations: null }), "");
  });

  it("runs only on the implemented arm", () => {
    assert.equal((script.match(/implement_migration_claim_check "\$ISSUE_NUM"/g) || []).length, 1);
  });
});

// The open-PR sweep in `pnpm migration:check` is skipped when DRAFTO_UNATTENDED
// is set; the implementer's and fix loop's claude runs must inherit it.
describe("factory-agent.sh — DRAFTO_UNATTENDED reaches its claude runs", () => {
  it("is exported at the top level, before any claude call", () => {
    const at = script.indexOf("\nexport DRAFTO_UNATTENDED=1\n");
    assert.ok(at !== -1);
    assert.ok(at < script.indexOf("run-claude.mjs"));
  });

  it("isn't stripped on the way: run-with-timeout spawns claude with the inherited env", () => {
    const runner = readFileSync(resolve(SCRIPTS, "lib", "run-with-timeout.mjs"), "utf8");
    assert.match(runner, /spawn\(command, args, \{ stdio: "inherit" \}\)/);
    assert.doesNotMatch(script, /env -i[^\n]*run-claude/);
  });
});
