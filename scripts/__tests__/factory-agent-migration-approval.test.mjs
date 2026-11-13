import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Tests for migration_approval_vouch (ADR-0078): the migration-approved label
// vouches for the migration SQL it was first seen with. The function runs for
// real against stubs of gh, node, log and issue_marker_check;
// migration-approval.test.mjs covers the hash itself. Where factory-agent.sh
// calls it: In Review and --implement below, Testing in
// factory-agent-verify.test.mjs, In Test in factory-agent-intest.test.mjs and
// --release in factory-agent-release.test.mjs.

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "factory-agent.sh");
const script = readFileSync(agentPath, "utf8");

const SHA = "1d3f9696cda7ce2dbaa5b750ee789ad6fe90e090";
const OLD_SHA = "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b";
const HASH = "0123456789abcdef";
const OLD = "fedcba9876543210";
const MIG_DIFF = "apps/web/src/x.ts\nsupabase/migrations/20261113000001_storage_quota.sql";
const LABELED = "status:approved,migration-approved";
const HASH_OUT = JSON.stringify({
  hash: HASH,
  files: [
    "supabase/migrations/20261020000001_grants.sql",
    "supabase/migrations/20261113000001_storage_quota.sql",
  ],
});
const rec = (hash, sha = SHA, pr = 802) => `${pr}:${sha}:${hash}`;

// Runs migration_approval_vouch with the given args, then prints "RC n",
// "LABELS <MIGRATION_APPROVAL_LABELS>" and every stubbed call. `files: null`
// calls it without the changed files, so it fetches them itself.
function run(opts = {}) {
  const {
    labels = LABELED,
    files = MIG_DIFF,
    prDiff = MIG_DIFF,
    prDiffFail = false,
    sha = SHA,
    vouched = "",
    stateFail = false,
    hashRc = 0,
    hashOut = HASH_OUT,
    editFail = false,
    commentFail = false,
    setFail = false,
    marker = 1,
    dryRun = 0,
    bash = "bash",
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
    "pr diff")
      echo "GH pr diff \${*:3}" >>"$CALLS"
      [[ "${prDiffFail ? 1 : 0}" == "1" ]] && return 1
      printf '%b\\n' ${q(prDiff)}; return 0 ;;
    "issue comment")
      echo "GH issue comment $3" >>"$CALLS"
      printf '%s\\n' "$*" | grep -o 'drafto-factory-migration-approval-void:[0-9a-f]*' >>"$CALLS" || true
      printf '%s\\n' "$*" | grep -o 'migration files at [^:]*: .*\\. Review' >>"$CALLS" || true
      return ${commentFail ? 1 : 0} ;;
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
issue_marker_check() { echo "MARKER? $2" >>"$CALLS"; return ${marker}; }
eval "$(awk '$0 ~ "^migration_approval_vouch\\\\(\\\\)" {f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
rc=0
${
  files === null
    ? `migration_approval_vouch 794 802 ${q(sha)} ${q(labels)} || rc=$?`
    : `migration_approval_vouch 794 802 ${q(sha)} ${q(labels)} "$(printf '%b' ${q(files)})" || rc=$?`
}
echo "RC $rc"
echo "LABELS $MIGRATION_APPROVAL_LABELS"
cat "$CALLS"
`;
  try {
    const r = spawnSync(bash, ["-c", snippet], { encoding: "utf8" });
    assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const order = (out, ...needles) => {
  const at = needles.map((n) => {
    const i = out.indexOf(n);
    assert.ok(i !== -1, `missing: ${n}\n${out}`);
    return i;
  });
  for (let i = 1; i < at.length; i++) {
    assert.ok(at[i - 1] < at[i], `${needles[i - 1]} before ${needles[i]}\n${out}`);
  }
};

describe("migration_approval_vouch (extracted, real bash)", () => {
  it("does nothing for a PR that touches no migrations", () => {
    const out = run({ files: "apps/web/src/x.ts\ndocs/operations/migrations.md" });
    assert.equal(out.trim(), `RC 0\nLABELS ${LABELED}`);
  });

  it("records this PR, head and hash the first time it sees the label, and keeps the label", () => {
    const out = run();
    assert.match(out, /^RC 0$/m);
    assert.match(out, new RegExp(`^LABELS ${LABELED}$`, "m"));
    assert.match(out, new RegExp(`^HASH hash --root /factory --pr 802 --head ${SHA}$`, "m"));
    assert.match(
      out,
      new RegExp(`^STATE factory:set-issue-field 794 migrationApprovedVouched ${rec(HASH)}$`, "m"),
    );
    assert.match(out, /migration-approved on PR #802 covers its migration SQL as of 1d3f9696cda7/);
    assert.doesNotMatch(out, /GH /);
  });

  it("skips the hash, and every fetch, while the head is the one recorded", () => {
    for (const files of [MIG_DIFF, null]) {
      const out = run({ vouched: rec(HASH), files });
      assert.equal(out.trim(), `RC 0\nLABELS ${LABELED}`);
    }
  });

  it("moves the record to a new head whose SQL hashes the same, and keeps the label", () => {
    const out = run({ vouched: rec(HASH, OLD_SHA) });
    assert.match(out, /^HASH /m);
    assert.match(
      out,
      new RegExp(`^STATE factory:set-issue-field 794 migrationApprovedVouched ${rec(HASH)}$`, "m"),
    );
    assert.match(out, new RegExp(`^LABELS ${LABELED}$`, "m"));
    assert.doesNotMatch(out, /GH |covers its migration SQL/);
  });

  it("treats another PR's record as nothing recorded: records afresh, never voids", () => {
    const out = run({ vouched: rec(OLD, SHA, 799) });
    assert.match(out, /recorded migration approval is for PR #799, not PR #802; vouching afresh/);
    assert.match(out, /^HASH /m);
    assert.match(
      out,
      new RegExp(`^STATE factory:set-issue-field 794 migrationApprovedVouched ${rec(HASH)}$`, "m"),
    );
    assert.match(out, new RegExp(`^LABELS ${LABELED}$`, "m"));
    assert.doesNotMatch(out, /GH /);
  });

  it("treats a malformed record as nothing recorded, with a log line", () => {
    for (const vouched of [OLD, "802:not-a-sha:0123456789abcdef", "802::", "garbage"]) {
      const out = run({ vouched });
      assert.match(out, /migrationApprovedVouched isn't <PR>:<head sha>:<hash>/, vouched);
      assert.match(
        out,
        new RegExp(
          `^STATE factory:set-issue-field 794 migrationApprovedVouched ${rec(HASH)}$`,
          "m",
        ),
      );
      assert.doesNotMatch(out, /GH /);
    }
  });

  it("voids a label the SQL changed under: comment first, then removal, then the record", () => {
    const out = run({ vouched: rec(OLD, OLD_SHA) });
    assert.match(out, /^LABELS status:approved$/m, "the caller goes on without it");
    assert.match(
      out,
      new RegExp(`^MARKER\\? drafto-factory-migration-approval-void:${HASH}$`, "m"),
    );
    assert.match(out, /^GH issue comment 794$/m);
    assert.match(out, new RegExp(`^drafto-factory-migration-approval-void:${HASH}$`, "m"));
    // The comment names the PR's migration files.
    assert.match(
      out,
      /migration files at `1d3f9696cda7`: `supabase\/migrations\/20261020000001_grants\.sql`, `supabase\/migrations\/20261113000001_storage_quota\.sql`\. Review/,
    );
    assert.match(
      out,
      /^GH pr edit 802 --repo JakubAnderwald\/drafto --remove-label migration-approved$/m,
    );
    assert.match(out, /^STATE factory:set-issue-field 794 migrationApprovedVouched $/m);
    assert.match(
      out,
      new RegExp(`changed since migration-approved was added \\(${OLD} -> ${HASH}`),
    );
    order(out, "MARKER? ", "GH issue comment", "GH pr edit", "STATE ");
  });

  it("doesn't comment again when the comment is already there, and still removes the label", () => {
    const out = run({ vouched: rec(OLD, OLD_SHA), marker: 0 });
    assert.doesNotMatch(out, /GH issue comment/);
    order(out, "MARKER? ", "GH pr edit", "STATE ");
  });

  it("keeps the label and the record when the comments can't be read", () => {
    const out = run({ vouched: rec(OLD, OLD_SHA), marker: 2 });
    assert.match(out, /couldn't read #794's comments; keeping migration-approved on PR #802/);
    assert.doesNotMatch(out, /GH (issue comment|pr edit)/);
    assert.doesNotMatch(out, /^STATE /m);
    assert.match(out, /^LABELS status:approved$/m, "this tick still goes on without it");
  });

  it("keeps the label and the record when the comment can't be posted", () => {
    const out = run({ vouched: rec(OLD, OLD_SHA), commentFail: true });
    assert.match(out, /^GH issue comment 794$/m);
    assert.match(out, /couldn't comment on #794 about the voided migration approval/);
    assert.doesNotMatch(out, /GH pr edit/);
    assert.doesNotMatch(out, /^STATE /m);
    assert.match(out, /^LABELS status:approved$/m);
  });

  it("keeps the record when the label can't be removed, so the next tick retries", () => {
    const out = run({ vouched: rec(OLD, OLD_SHA), editFail: true });
    assert.match(out, /^GH pr edit .*--remove-label migration-approved$/m);
    assert.doesNotMatch(out, /^STATE /m);
    assert.match(out, /couldn't remove migration-approved from PR #802; retrying next tick/);
    assert.match(out, /^LABELS status:approved$/m, "this tick still goes on without it");
  });

  it("forgets any record once the label is gone, without hashing", () => {
    for (const vouched of [rec(HASH), rec(OLD, SHA, 799), "garbage"]) {
      const out = run({ labels: "status:approved", vouched });
      assert.match(out, /^STATE factory:set-issue-field 794 migrationApprovedVouched $/m);
      assert.doesNotMatch(out, /^HASH |GH /m);
      assert.match(out, /^LABELS status:approved$/m);
    }
  });

  it("does nothing without the label and without a record", () => {
    for (const files of [MIG_DIFF, null]) {
      const out = run({ labels: "status:approved", files });
      assert.equal(out.trim(), "RC 0\nLABELS status:approved");
    }
  });

  describe("without the changed files from the caller", () => {
    it("fetches them only when it has to hash", () => {
      const out = run({ files: null });
      order(out, "GH pr diff 802 --repo JakubAnderwald/drafto --name-only", "HASH ", "STATE ");
    });

    it("stops at a PR that touches no migrations, before the hash", () => {
      const out = run({ files: null, prDiff: "apps/web/src/x.ts" });
      assert.match(out, /^GH pr diff /m);
      assert.doesNotMatch(out, /^(HASH|STATE) /m);
      assert.match(out, new RegExp(`^LABELS ${LABELED}$`, "m"));
    });

    it("changes nothing when the diff can't be read", () => {
      const out = run({ files: null, prDiffFail: true, vouched: rec(OLD, OLD_SHA) });
      assert.match(out, /gh pr diff #802 failed/);
      assert.doesNotMatch(out, /^(HASH|STATE) |GH (issue|pr edit)/m);
      assert.match(out, new RegExp(`^LABELS ${LABELED}$`, "m"));
    });
  });

  it("changes nothing when the hash fails, or isn't one", () => {
    for (const opts of [
      { vouched: rec(OLD, OLD_SHA), hashRc: 1, hashOut: "" },
      { vouched: rec(OLD, OLD_SHA), hashRc: 0, hashOut: '{"hash":"nope"}' },
      { vouched: rec(OLD, OLD_SHA), hashRc: 0, hashOut: "not json" },
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
    const out = run({ sha: "", vouched: rec(OLD, OLD_SHA) });
    assert.match(out, new RegExp(`^LABELS ${LABELED}$`, "m"));
    assert.doesNotMatch(out, /^(STATE|HASH|GH) /m);
  });

  it("logs a failed write and keeps the label", () => {
    const out = run({ setFail: true });
    assert.match(out, /couldn't record #794's migration SQL hash; retrying next tick/);
    assert.match(out, new RegExp(`^LABELS ${LABELED}$`, "m"));
  });

  it("only logs under DRY_RUN, but still hands the caller the voided labels", () => {
    const voided = run({ vouched: rec(OLD, OLD_SHA), dryRun: 1 });
    assert.match(voided, /^LABELS status:approved$/m);
    assert.doesNotMatch(voided, /^(STATE|GH|MARKER)/m);
    assert.match(
      voided,
      /DRY-RUN: would comment on #794 and remove migration-approved from PR #802/,
    );
    const first = run({ dryRun: 1 });
    assert.doesNotMatch(first, /^STATE /m);
    const gone = run({ labels: "status:approved", vouched: rec(HASH), dryRun: 1 });
    assert.doesNotMatch(gone, /^STATE /m);
    assert.match(gone, /DRY-RUN: would forget the migration SQL hash/);
  });

  it("runs under the Mac mini's /bin/bash (3.2) too", () => {
    const out = run({ vouched: rec(OLD, OLD_SHA), bash: "/bin/bash" });
    order(out, "MARKER? ", "GH issue comment", "GH pr edit", "STATE ");
    const fresh = run({ vouched: rec(OLD, SHA, 799), bash: "/bin/bash" });
    assert.match(fresh, /vouching afresh/);
  });
});

// Runs one function extracted from the script, after <setup>.
function withFn(fn, setup, body) {
  const r = spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
${setup}
eval "$(awk '/^${fn}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
${body}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

describe("issue_marker_check (extracted, real bash)", () => {
  const check = (comments, fail = false) =>
    withFn(
      "issue_marker_check",
      `fetch_issue_comments() { ${fail ? "return 1" : `printf '%s' ${JSON.stringify(comments)}`}; }
eval "$(awk '/^comments_have_marker\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"`,
      'rc=0; issue_marker_check 794 "drafto-factory-migration-approval-void:0123456789abcdef" || rc=$?; echo "$rc"',
    );
  const comment = (body, who = "OWNER") =>
    JSON.stringify([{ id: 1, body, authorAssociation: who }]);

  it("tells a factory comment with the marker, none, and a failed fetch apart", () => {
    assert.equal(
      check(comment("text\n<!-- drafto-factory-migration-approval-void:0123456789abcdef -->")),
      "0",
    );
    assert.equal(check(comment("<!-- drafto-factory-migration-approval-void:ffff -->")), "1");
    assert.equal(check("[]"), "1");
    assert.equal(check("", true), "2");
    assert.equal(check(""), "2", "empty output is a failed fetch, not no comments");
  });

  it("doesn't count someone else's comment quoting the marker", () => {
    assert.equal(
      check(comment("<!-- drafto-factory-migration-approval-void:0123456789abcdef -->", "NONE")),
      "1",
    );
  });
});

describe("migration_approval_vouch_view (extracted, real bash)", () => {
  const view = (v) =>
    withFn(
      "migration_approval_vouch_view",
      'migration_approval_vouch() { echo "VOUCH $# $1 $2 $3 [$4]"; return 1; }',
      `migration_approval_vouch_view 794 802 ${JSON.stringify(v)}; echo "RC $?"`,
    );

  it("hands the vouch the view's head and labels, without changed files", () => {
    assert.equal(
      view(
        JSON.stringify({
          state: "OPEN",
          headRefOid: SHA,
          labels: [{ name: "status:in-review" }, { name: "migration-approved" }],
        }),
      ),
      `VOUCH 4 794 802 ${SHA} [status:in-review,migration-approved]\nRC 0`,
    );
    assert.equal(
      view(JSON.stringify({ state: "OPEN", headRefOid: SHA, labels: [] })),
      `VOUCH 4 794 802 ${SHA} []\nRC 0`,
    );
  });

  it("skips a view without labels, a PR that isn't open, and a failed read", () => {
    assert.equal(view(JSON.stringify({ state: "OPEN", headRefOid: SHA })), "RC 0");
    assert.equal(view(JSON.stringify({ state: "MERGED", headRefOid: SHA, labels: [] })), "RC 0");
    assert.equal(view(""), "RC 0");
    assert.equal(view("not json"), "RC 0");
  });
});

// ── Where it runs ───────────────────────────────────────────────────────────

function slice(startNeedle, endNeedle) {
  const start = script.indexOf(startNeedle);
  assert.ok(start !== -1, `could not find ${startNeedle}`);
  const end = script.indexOf(endNeedle, start);
  assert.ok(end !== -1, `could not find ${endNeedle}`);
  return script.slice(start, end);
}

function at(block, s) {
  const i = block.indexOf(s);
  assert.ok(i !== -1, `missing: ${s}`);
  return i;
}

describe("migration approval in the In Review loop", () => {
  const loop = slice("  # ── 2. In Review → In Test ──", "  # ── 2b. Testing sweep");

  it("vouches early every tick, from the PR view the loop already fetches", () => {
    const view = at(loop, "--json state,mergeable,statusCheckRollup,comments,headRefOid,labels");
    const vouch = at(loop, 'migration_approval_vouch_view "$ISSUE_NUM" "$PR_NUM" "$PR_VIEW"');
    assert.ok(at(loop, "gh pr view #$PR_NUM failed (transient?)") < vouch);
    assert.doesNotMatch(loop.slice(view, vouch), /gh pr (view|diff) "/, "no fetch of its own");
    // Before anything that can skip the card or act on it this tick.
    for (const later of [
      'FAILING=$(pr_failing_required "$PR_VIEW")',
      'recover_cancelled_ci "$ISSUE_NUM"',
      'migration_renumber_gate "$ISSUE_NUM"',
      "→ conflict pass",
      "hosted_config_gate",
    ]) {
      assert.ok(vouch < at(loop, later), later);
    }
    assert.equal(loop.split("migration_approval_vouch").length - 1, 1, "called once");
  });
});

describe("migration approval before an --implement revision run", () => {
  const impl = slice('\nif [[ "$MODE_IMPLEMENT" -eq 1 ]]; then\n', "# ── --watch mode");

  it("vouches for a card with an open PR, after the PR lookup and before Claude runs", () => {
    const vouch = at(impl, 'migration_approval_vouch_view "$ISSUE_NUM" "$PRIOR_PR_NUM"');
    assert.ok(at(impl, 'PRIOR_PR=$(find_prior_pr "$ISSUE_NUM")') < vouch);
    assert.ok(at(impl, 'if [[ "$(echo "$PRIOR_PR" | jq -r \'.state // ""\'') < vouch);
    for (const later of [
      'SLOT=$(slot_for_issue "$ISSUE_NUM")',
      "build_implement_bundle",
      "Invoking claude for #$ISSUE_NUM (--implement",
    ]) {
      assert.ok(vouch < at(impl, later), later);
    }
    assert.match(
      impl,
      /gh pr view "\$PRIOR_PR_NUM" --repo JakubAnderwald\/drafto --json state,headRefOid,labels/,
    );
    assert.equal(impl.split("migration_approval_vouch").length - 1, 1, "called once");
  });

  it("only for an open PR, and never changes the run", () => {
    const start = at(impl, '    if [[ "$(echo "$PRIOR_PR" | jq -r \'.state // ""\'');
    const end = impl.indexOf("    fi\n", start) + "    fi\n".length;
    const run = (prior) => {
      const r = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
ISSUE_NUM=794; LOG_FILE=/dev/null; PRIOR_PR=${JSON.stringify(prior)}
gh() { echo '{"state":"OPEN","headRefOid":"abc","labels":[]}'; }
migration_approval_vouch_view() { echo "VIEW $1 $2 $3"; return 1; }
${impl.slice(start, end)}
echo "NEXT"`,
        ],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const open = JSON.stringify({
      number: 802,
      url: "u",
      headRef: "factory/issue-794",
      state: "OPEN",
    });
    assert.equal(run(open), 'VIEW 794 802 {"state":"OPEN","headRefOid":"abc","labels":[]}\nNEXT');
    assert.equal(run(JSON.stringify({ number: 802, state: "MERGED" })), "NEXT");
    assert.equal(run("null"), "NEXT");
  });
});
