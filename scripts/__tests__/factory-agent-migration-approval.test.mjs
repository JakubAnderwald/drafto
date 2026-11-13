import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Tests for migration_approval_vouch (ADR-0078): the migration-approved label
// vouches for the migration SQL it was first seen with. The function runs for
// real against stubs of gh, node, log and issue_has_marker;
// migration-approval.test.mjs covers the hash itself. Where factory-agent.sh
// calls it is tested in factory-agent-release.test.mjs and
// factory-agent-intest.test.mjs.

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "factory-agent.sh");

const SHA = "1d3f9696cda7ce2dbaa5b750ee789ad6fe90e090";
const HASH = "0123456789abcdef";
const OLD = "fedcba9876543210";
const MIG_DIFF = "apps/web/src/x.ts\nsupabase/migrations/20261113000001_storage_quota.sql";
const LABELED = "status:approved,migration-approved";
const HASH_OUT = JSON.stringify({
  hash: HASH,
  files: ["20261113000001_storage_quota.sql", "20261020000001_grants.sql"],
});

// Runs migration_approval_vouch with the given args, then prints "RC n",
// "LABELS <MIGRATION_APPROVAL_LABELS>" and every stubbed call.
function run(opts = {}) {
  const {
    labels = LABELED,
    diff = MIG_DIFF,
    sha = SHA,
    vouched = "",
    stateFail = false,
    hashRc = 0,
    hashOut = HASH_OUT,
    editFail = false,
    setFail = false,
    markerExists = false,
    dryRun = 0,
  } = opts;
  const dir = mkdtempSync(join(tmpdir(), "factory-migration-approval-"));
  const q = (s) => JSON.stringify(s);
  const snippet = `
set -euo pipefail
CALLS="${dir}/calls"; : >"$CALLS"
LOG_FILE="${dir}/log"
STATE_FILE="${dir}/state.json"
SCRIPT_DIR=/factory/scripts
REPO_ROOT=/factory
DRY_RUN=${dryRun}
log() { echo "LOG $*" >>"$CALLS"; }
gh() {
  case "$1 $2" in
    "pr edit") echo "GH pr edit \${*:3}" >>"$CALLS"; return ${editFail ? 1 : 0} ;;
    "issue comment")
      echo "GH issue comment $3" >>"$CALLS"
      printf '%s\\n' "$*" | grep -o 'drafto-factory-migration-approval-void:[0-9a-f]*' >>"$CALLS" || true
      printf '%s\\n' "$*" | grep -o 'migration files at [^:]*: .*\\. Review' >>"$CALLS" || true
      return 0 ;;
  esac
  echo "GH unexpected $*" >>"$CALLS"; return 1
}
node() {
  case "$1" in
    */state-cli.mjs)
      if [[ "$2" == "factory:get-issue" ]]; then
        [[ "${stateFail ? 1 : 0}" == "1" ]] && return 1
        echo '{"migrationApprovedVouched":${q(vouched)}}'; return 0
      fi
      echo "STATE $2 $3 $4 $5" >>"$CALLS"; return ${setFail ? 1 : 0} ;;
    */migration-approval.mjs)
      echo "HASH \${*:2}" >>"$CALLS"
      printf '%s' ${q(hashOut)}; return ${hashRc} ;;
  esac
  echo "NODE unexpected $*" >>"$CALLS"; return 1
}
issue_has_marker() { echo "MARKER? $2" >>"$CALLS"; return ${markerExists ? 0 : 1}; }
eval "$(awk '$0 ~ "^migration_approval_vouch\\\\(\\\\)" {f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
rc=0; migration_approval_vouch 794 802 ${q(sha)} ${q(labels)} "$(printf '%b' ${q(diff)})" || rc=$?
echo "RC $rc"
echo "LABELS $MIGRATION_APPROVAL_LABELS"
cat "$CALLS"
`;
  try {
    const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
    assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("migration_approval_vouch (extracted, real bash)", () => {
  it("does nothing for a PR that touches no migrations", () => {
    const out = run({ diff: "apps/web/src/x.ts\ndocs/operations/migrations.md" });
    assert.equal(out.trim(), `RC 0\nLABELS ${LABELED}`);
  });

  it("records the hash the label was first seen with, and keeps the label", () => {
    const out = run();
    assert.match(out, /^RC 0$/m);
    assert.match(out, new RegExp(`^LABELS ${LABELED}$`, "m"));
    assert.match(out, new RegExp(`^HASH hash --root /factory --pr 802 --head ${SHA}$`, "m"));
    assert.match(
      out,
      new RegExp(`^STATE factory:set-issue-field 794 migrationApprovedVouched ${HASH}$`, "m"),
    );
    assert.match(out, /migration-approved on PR #802 covers its migration SQL as of 1d3f9696cda7/);
    assert.doesNotMatch(out, /GH /);
  });

  it("keeps the label, and writes nothing, while the SQL is unchanged", () => {
    const out = run({ vouched: HASH });
    assert.match(out, new RegExp(`^LABELS ${LABELED}$`, "m"));
    assert.match(out, /^HASH /m);
    assert.doesNotMatch(out, /^STATE /m);
    assert.doesNotMatch(out, /GH /);
  });

  it("voids a label the SQL changed under: removes it, forgets the hash, comments once", () => {
    const out = run({ vouched: OLD });
    assert.match(out, /^LABELS status:approved$/m, "the caller goes on without it");
    assert.match(
      out,
      /^GH pr edit 802 --repo JakubAnderwald\/drafto --remove-label migration-approved$/m,
    );
    assert.match(out, /^STATE factory:set-issue-field 794 migrationApprovedVouched $/m);
    assert.match(
      out,
      new RegExp(`^MARKER\\? drafto-factory-migration-approval-void:${HASH}$`, "m"),
    );
    assert.match(out, /^GH issue comment 794$/m);
    assert.match(out, new RegExp(`^drafto-factory-migration-approval-void:${HASH}$`, "m"));
    // The comment names the PR's migration files.
    assert.match(
      out,
      /migration files at `1d3f9696cda7`: `20261113000001_storage_quota\.sql`, `20261020000001_grants\.sql`\. Review/,
    );
    assert.match(
      out,
      new RegExp(`changed since migration-approved was added \\(${OLD} -> ${HASH}`),
    );
    // Removal first, then the state, then the comment.
    assert.ok(out.indexOf("GH pr edit") < out.indexOf("STATE "));
    assert.ok(out.indexOf("STATE ") < out.indexOf("GH issue comment"));
  });

  it("comments only once per hash", () => {
    const out = run({ vouched: OLD, markerExists: true });
    assert.match(out, /^GH pr edit /m);
    assert.doesNotMatch(out, /GH issue comment/);
  });

  it("keeps the old hash when the label can't be removed, so the next tick retries", () => {
    const out = run({ vouched: OLD, editFail: true });
    assert.match(out, /^GH pr edit .*--remove-label migration-approved$/m);
    assert.doesNotMatch(out, /^STATE /m);
    assert.doesNotMatch(out, /GH issue comment/);
    assert.match(out, /couldn't remove migration-approved from PR #802; retrying next tick/);
    assert.match(out, /^LABELS status:approved$/m, "this tick still goes on without it");
  });

  it("forgets the vouched hash once the label is gone, without hashing", () => {
    const out = run({ labels: "status:approved", vouched: HASH });
    assert.match(out, /^STATE factory:set-issue-field 794 migrationApprovedVouched $/m);
    assert.doesNotMatch(out, /^HASH /m);
    assert.match(out, /^LABELS status:approved$/m);
  });

  it("does nothing without the label and without a vouched hash", () => {
    const out = run({ labels: "status:approved" });
    assert.equal(out.trim(), "RC 0\nLABELS status:approved");
  });

  it("changes nothing when the hash fails, or isn't one", () => {
    for (const opts of [
      { vouched: OLD, hashRc: 1, hashOut: "" },
      { vouched: OLD, hashRc: 0, hashOut: '{"hash":"nope"}' },
      { vouched: OLD, hashRc: 0, hashOut: "not json" },
      { vouched: "", hashRc: 1, hashOut: "" },
    ]) {
      const out = run(opts);
      assert.match(out, /^RC 0$/m);
      assert.match(out, new RegExp(`^LABELS ${LABELED}$`, "m"), JSON.stringify(opts));
      assert.doesNotMatch(out, /^STATE /m);
      assert.doesNotMatch(out, /GH /);
      assert.match(out, /couldn't hash PR #802's migrations at 1d3f9696cda7/);
    }
  });

  it("changes nothing when the state can't be read", () => {
    for (const labels of [LABELED, "status:approved"]) {
      const out = run({ labels, stateFail: true });
      assert.match(out, new RegExp(`^LABELS ${labels}$`, "m"));
      assert.doesNotMatch(out, /^(STATE|HASH|GH) /m);
      assert.match(out, /couldn't read #794's state/);
    }
  });

  it("changes nothing without a head SHA", () => {
    const out = run({ sha: "", vouched: OLD });
    assert.match(out, new RegExp(`^LABELS ${LABELED}$`, "m"));
    assert.doesNotMatch(out, /^(STATE|HASH|GH) /m);
  });

  it("logs a failed first-sight write and keeps the label", () => {
    const out = run({ setFail: true });
    assert.match(out, /couldn't record #794's migration SQL hash; retrying next tick/);
    assert.match(out, new RegExp(`^LABELS ${LABELED}$`, "m"));
  });

  it("only logs under DRY_RUN, but still hands the caller the voided labels", () => {
    const voided = run({ vouched: OLD, dryRun: 1 });
    assert.match(voided, /^LABELS status:approved$/m);
    assert.doesNotMatch(voided, /^(STATE|GH) /m);
    assert.match(voided, /DRY-RUN: would remove migration-approved from PR #802/);
    const first = run({ dryRun: 1 });
    assert.doesNotMatch(first, /^STATE /m);
    const gone = run({ labels: "status:approved", vouched: HASH, dryRun: 1 });
    assert.doesNotMatch(gone, /^STATE /m);
    assert.match(gone, /DRY-RUN: would forget the migration SQL hash/);
  });
});
