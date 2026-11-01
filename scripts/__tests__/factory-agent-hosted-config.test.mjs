import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Tests for hosted_config_gate (ADR-0065) and where factory-agent.sh calls it.
// The functions run for real against stubs of gh, node and issue_has_marker;
// scripts/__tests__/hosted-config.test.mjs covers the check itself.

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "factory-agent.sh");
const script = readFileSync(agentPath, "utf8");

const SHA = "1d3f9696cda7ce2dbaa5b750ee789ad6fe90e090";
const SHA12 = SHA.slice(0, 12);
const BASE = "4f2831372cf5c33c4797c985072d4bfcb77cd58a";
const CONFIG_DIFF = "apps/mobile/src/lib/supabase.ts\nsupabase/config.toml";
const HEAD_CONFIG = '[auth]\nadditional_redirect_urls = ["drafto://x?y=*"]\n';
const HEAD_HASH = "head-hash-123456";

// Runs <call> after extracting the gate functions. Prints the call's exit code
// as "RC n", then every stubbed call. Options shape the stubs' answers.
function run(call, opts = {}) {
  const {
    nodeRc = 0,
    nodeOut = "",
    markerExists = false,
    compareFail = false,
    contentsFail = "", // "" | "404" | "500"
    vouched = "",
    dryRun = 0,
    prDiff = CONFIG_DIFF,
    prLabels = "",
  } = opts;
  const dir = mkdtempSync(join(tmpdir(), "factory-hosted-config-"));
  writeFileSync(join(dir, "diff"), prDiff);
  const snippet = `
set -euo pipefail
CALLS="${dir}/calls"; : >"$CALLS"
LOG_FILE="${dir}/log"
STATE_FILE="${dir}/state.json"
SCRIPT_DIR=/factory/scripts
DIFF_FILE="${dir}/diff"
DRY_RUN=${dryRun}
logerr() { echo "LOG $*" >>"$CALLS"; }
shasum() { echo "${HEAD_HASH}fffffff  $2"; }
gh() {
  case "$1 $2" in
    "api repos/JakubAnderwald/drafto/compare/"*)
      echo "GH compare \${2##*/}" >>"$CALLS"
      [[ "${compareFail ? 1 : 0}" == "1" ]] && return 1
      echo "${BASE}"; return 0 ;;
    "api repos/JakubAnderwald/drafto/contents/"*)
      echo "GH contents \${2##*=}" >>"$CALLS"
      if [[ "${contentsFail}" == "404" && "\${2##*=}" == "${SHA}" ]]; then echo "gh: Not Found (HTTP 404)" >&2; return 1; fi
      if [[ "${contentsFail}" == "500" ]]; then echo "gh: Server Error (HTTP 500)" >&2; return 1; fi
      printf '%s' ${JSON.stringify(HEAD_CONFIG)}; return 0 ;;
    "pr diff") echo "GH pr diff" >>"$CALLS"; cat "${dir}/diff"; return 0 ;;
    "pr view") echo "GH pr view" >>"$CALLS"; echo ${JSON.stringify(prLabels)}; return 0 ;;
    "pr edit") echo "GH pr edit $*" >>"$CALLS"; return 0 ;;
    "issue comment")
      echo "GH issue comment $3" >>"$CALLS"
      printf '%s\\n' "$*" | grep -o 'drafto-factory-hosted-config-[a-z]*:[a-z-]*:[0-9a-f]*' >>"$CALLS" || true
      return 0 ;;
  esac
  echo "GH unexpected $*" >>"$CALLS"; return 1
}
node() {
  case "$1" in
    */state-cli.mjs)
      if [[ "$2" == "factory:get-issue" ]]; then echo '{"hostedConfigVouched":${JSON.stringify(vouched)}}'; return 0; fi
      echo "STATE $2 $3 $4 $5" >>"$CALLS"; return 0 ;;
    */hosted-config.mjs)
      local args=("$@")
      echo "CHECK \${args[*]:1}" >>"$CALLS"
      echo "HEAD $(cat "\${args[5]}")" >>"$CALLS"
      printf '%s' ${JSON.stringify(nodeOut)}; return ${nodeRc} ;;
  esac
  echo "NODE unexpected $*" >>"$CALLS"; return 1
}
issue_has_marker() { echo "MARKER? $2" >>"$CALLS"; return ${markerExists ? 0 : 1}; }
for fn in hosted_config_gate hosted_config_fetch hosted_config_gate_pr; do
  eval "$(awk -v fn="$fn" '$0 ~ "^"fn"\\\\(\\\\)" {f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
done
rc=0; ${call} || rc=$?
echo "RC $rc"
cat "$CALLS"
`;
  try {
    const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const q = (s) => JSON.stringify(s);
// ANSI-C quoting, so the diff's newlines reach bash as real newlines.
const ansi = (s) => `$'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
const gate = ({
  diff = CONFIG_DIFF,
  sha = SHA,
  labels = "status:in-review",
  where = "In Review",
} = {}) => `hosted_config_gate 685 778 ${q(sha)} ${ansi(diff)} ${q(labels)} ${q(where)}`;

describe("hosted_config_gate (extracted, real bash)", () => {
  it("passes without any call when supabase/config.toml isn't in the diff", () => {
    const out = run(gate({ diff: "apps/web/src/x.ts\nsupabase/migrations/1_x.sql" }));
    assert.equal(out.trim(), "RC 0");
  });

  it("doesn't mistake a look-alike path for the config", () => {
    assert.equal(run(gate({ diff: "docs/supabase/config.toml.md" })).trim(), "RC 0");
  });

  it("finds config.toml early in a diff far larger than a pipe buffer (no SIGPIPE fail-open)", () => {
    const big = [
      "supabase/config.toml",
      ...Array.from({ length: 20000 }, (_, i) => `apps/web/f${i}.ts`),
    ].join("\n");
    // The diff is read from a file inside bash: inlined into `bash -c` it would
    // exceed Linux's 128 KB per-argument limit and the spawn itself would fail.
    const out = run(
      `hosted_config_gate 685 778 ${q(SHA)} "$(cat "$DIFF_FILE")" "status:in-review" "In Review"`,
      { prDiff: big, nodeRc: 0, nodeOut: '{"status":"ok"}' },
    );
    assert.match(out, /^GH compare main\.\.\.1d3f/m, "the gate must run, not pass early");
  });

  it("diffs the head against its merge base, not main's tip, and passes on exit 0", () => {
    const out = run(gate(), { nodeRc: 0, nodeOut: '{"status":"ok","comment":""}' });
    assert.match(out, /^RC 0$/m);
    assert.match(out, new RegExp(`^GH compare main\\.\\.\\.${SHA}$`, "m"));
    assert.match(out, new RegExp(`^GH contents ${BASE}$`, "m"));
    assert.match(out, new RegExp(`^GH contents ${SHA}$`, "m"));
    assert.match(
      out,
      /^CHECK check --base-file \S+\/base --head-file \S+\/head --labels status:in-review --pr 778 --where In Review$/m,
    );
    assert.doesNotMatch(out, /GH issue comment/);
  });

  it("holds on exit 3 and comments once, keyed to the column and head SHA", () => {
    const out = run(gate(), {
      nodeRc: 3,
      nodeOut: JSON.stringify({ status: "hold", comment: "🏭 **Hold**" }),
    });
    assert.match(out, /^RC 1$/m);
    assert.match(out, new RegExp(`MARKER\\? drafto-factory-hosted-config-hold:in-review:${SHA12}`));
    assert.match(out, /^GH issue comment 685$/m);
    assert.match(out, new RegExp(`^drafto-factory-hosted-config-hold:in-review:${SHA12}$`, "m"));
  });

  it("uses a separate marker in Approved, so a hold there is never silenced by an In Review one", () => {
    const out = run(gate({ where: "Approved" }), {
      nodeRc: 3,
      nodeOut: '{"status":"hold","comment":"x"}',
    });
    assert.match(out, new RegExp(`^drafto-factory-hosted-config-hold:approved:${SHA12}$`, "m"));
  });

  it("doesn't comment again when the marker is already on the issue", () => {
    const out = run(gate(), {
      nodeRc: 3,
      nodeOut: '{"status":"hold","comment":"x"}',
      markerExists: true,
    });
    assert.match(out, /^RC 1$/m);
    assert.doesNotMatch(out, /GH issue comment/);
  });

  it("holds an unknown result under the unverified marker", () => {
    const out = run(gate(), { nodeRc: 4, nodeOut: '{"status":"unknown","comment":"x"}' });
    assert.match(out, /^RC 1$/m);
    assert.match(
      out,
      new RegExp(`^drafto-factory-hosted-config-unverified:in-review:${SHA12}$`, "m"),
    );
  });

  it("holds, with a fallback comment, when the check itself crashes", () => {
    const out = run(gate(), { nodeRc: 1, nodeOut: "" });
    assert.match(out, /^RC 1$/m);
    assert.match(out, /^GH issue comment 685$/m);
    assert.match(
      out,
      new RegExp(`^drafto-factory-hosted-config-unverified:in-review:${SHA12}$`, "m"),
    );
  });

  it("treats a head without config.toml (deleted) as an empty file, not as an outage", () => {
    const out = run(gate(), { contentsFail: "404", nodeRc: 0, nodeOut: '{"status":"ok"}' });
    assert.match(out, /^RC 0$/m);
    assert.match(out, /^HEAD $/m, "the head file handed to the check is empty");
  });

  it("holds quietly, without running the check, when GitHub fails", () => {
    for (const opts of [{ contentsFail: "500" }, { compareFail: true }]) {
      const out = run(gate(), opts);
      assert.match(out, /^RC 1$/m);
      assert.doesNotMatch(out, /^CHECK /m);
      assert.doesNotMatch(out, /GH issue comment/);
    }
  });

  it("holds when the head SHA is unknown", () => {
    const out = run(gate({ sha: "" }));
    assert.match(out, /^RC 1$/m);
    assert.doesNotMatch(out, /^GH /m);
  });

  it("only logs under DRY_RUN", () => {
    const out = run(gate(), { nodeRc: 3, nodeOut: '{"status":"hold","comment":"x"}', dryRun: 1 });
    assert.match(out, /^RC 1$/m);
    assert.doesNotMatch(out, /GH issue comment/);
    assert.match(out, /hosted-config gate held PR #778/);
  });
});

describe("hosted_config_gate — the label vouches for one config.toml", () => {
  const labelled = "status:in-review,hosted-config-applied";

  it("records the content the label was first seen with", () => {
    const out = run(gate({ labels: labelled }), { nodeRc: 0, nodeOut: '{"status":"ok"}' });
    assert.match(
      out,
      new RegExp(`^STATE factory:set-issue-field 685 hostedConfigVouched ${HEAD_HASH}$`, "m"),
    );
    assert.match(out, /--labels status:in-review,hosted-config-applied /);
  });

  it("keeps the label while config.toml is unchanged", () => {
    const out = run(gate({ labels: labelled }), {
      vouched: HEAD_HASH,
      nodeRc: 0,
      nodeOut: '{"status":"ok"}',
    });
    assert.doesNotMatch(out, /GH pr edit/);
    assert.match(out, /--labels status:in-review,hosted-config-applied /);
  });

  it("removes a label that vouched for an older config.toml, and checks without it", () => {
    const out = run(gate({ labels: labelled }), {
      vouched: "older-hash",
      nodeRc: 3,
      nodeOut: '{"status":"hold","comment":"x"}',
    });
    assert.match(
      out,
      /^GH pr edit pr edit 778 --repo JakubAnderwald\/drafto --remove-label hosted-config-applied$/m,
    );
    assert.match(out, /^STATE factory:set-issue-field 685 hostedConfigVouched $/m);
    assert.match(out, /--labels status:in-review --pr/);
  });

  it("forgets the vouched content once the label is gone", () => {
    const out = run(gate(), { vouched: HEAD_HASH, nodeRc: 0, nodeOut: '{"status":"ok"}' });
    assert.match(out, /^STATE factory:set-issue-field 685 hostedConfigVouched $/m);
  });
});

describe("hosted_config_gate_pr (the beta-dispatch entry point)", () => {
  it("passes after one diff call when the PR doesn't touch config.toml", () => {
    const out = run("hosted_config_gate_pr 685 778 " + q(SHA) + " beta", {
      prDiff: "apps/web/a.ts",
    });
    assert.equal(out.trim(), "RC 0\nGH pr diff");
  });

  it("fetches the labels and runs the gate with the beta marker when it does", () => {
    const out = run("hosted_config_gate_pr 685 778 " + q(SHA) + " beta", {
      prLabels: "status:in-test",
      nodeRc: 3,
      nodeOut: '{"status":"hold","comment":"x"}',
    });
    assert.match(out, /^RC 1$/m);
    assert.match(out, /^GH pr view$/m);
    assert.match(out, /--labels status:in-test --pr 778 --where beta$/m);
    assert.match(out, new RegExp(`^drafto-factory-hosted-config-hold:beta:${SHA12}$`, "m"));
  });
});

describe("hosted_config_gate wiring", () => {
  const section = (from, to) => {
    const start = script.indexOf(from);
    const end = script.indexOf(to, start);
    assert.ok(start !== -1 && end !== -1, `could not slice ${from} … ${to}`);
    return script.slice(start, end);
  };
  const inReview = section("# ── --watch mode", "# ── In Test feedback sweep");
  const release = section("# ── --release mode", "# All reachable modes have returned above");
  const dispatch = section("intest_dispatch_betas() {", "\n}\n");

  it("is the last In Review check before either promotion, after the CodeRabbit lane", () => {
    const cr = inReview.indexOf('cr_lane_gate "$ISSUE_NUM"');
    const g = inReview.indexOf("hosted_config_gate ");
    const verify = inReview.indexOf('if verify_target_status "$ISSUE_NUM"');
    const promote = inReview.indexOf('transition_status "$ITEM_ID" "$ISSUE_NUM" "In Test"');
    assert.ok(cr !== -1 && g !== -1 && verify !== -1 && promote !== -1);
    assert.ok(
      cr < g && g < verify && verify < promote,
      "order: CodeRabbit lane → gate → Testing → In Test",
    );
    assert.match(
      inReview,
      /hosted_config_gate "\$ISSUE_NUM" "\$PR_NUM" "\$HEAD_SHA" "\$INTEST_DIFF_FILES" "\$IR_PR_LABELS" "In Review"/,
    );
    assert.match(inReview, /--json state,mergeable,statusCheckRollup,comments,headRefOid,labels/);
  });

  it("gates every beta dispatch, after the idempotency check and before any build", () => {
    const idem = dispatch.indexOf('lanes="$to_dispatch"');
    const g = dispatch.indexOf('hosted_config_gate_pr "$issue_num" "$pr_num" "$sha" "beta"');
    const dry = dispatch.indexOf('if [[ "$DRY_RUN" -eq 1 ]]');
    const build = dispatch.indexOf("ensure_beta_build_root");
    assert.ok(idem !== -1 && g !== -1 && dry !== -1 && build !== -1);
    assert.ok(idem < g && g < dry && g < build);
    assert.match(dispatch, /reason: "hosted-config-hold"/);
    assert.match(dispatch, /dispatched: \[\], skipped: \$skipped, manualCommands: \[\]/);
  });

  it("runs in --release as the last check before the merge, after the hand-backs", () => {
    const conflict = release.indexOf("conflict_handback");
    const threads = release.indexOf('fetch_review_threads "$PR_NUM"');
    const g = release.indexOf("hosted_config_gate ");
    const merge = release.indexOf(
      'gh api --method PUT "repos/JakubAnderwald/drafto/pulls/$PR_NUM/merge"',
    );
    assert.ok(conflict !== -1 && threads !== -1 && g !== -1 && merge !== -1);
    assert.ok(conflict < g && threads < g && g < merge, "order: hand-backs → gate → merge");
    assert.match(
      release,
      /hosted_config_gate "\$ISSUE_NUM" "\$PR_NUM" "\$MERGE_SHA" "\$DIFF_FILES" "\$PR_LABELS" "Approved"/,
    );
  });

  it("pins the merge to the head SHA the gates checked", () => {
    assert.match(release, /MERGE_SHA=\$\(echo "\$PR_VIEW" \| jq -r '\.headRefOid \/\/ ""'\)/);
    assert.match(release, /MERGE_ARGS\+=\(-f "sha=\$MERGE_SHA"\)/);
    assert.match(release, /"\$\{MERGE_ARGS\[@\]\}"/);
  });
});
