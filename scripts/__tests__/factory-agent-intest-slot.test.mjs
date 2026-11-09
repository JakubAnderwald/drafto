import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ADR-0070. On 2026-11-09 the two In Test cards (#794, #328) held both worktree
// slots while they waited on the operator, so every In Progress card deferred
// on every tick. Nothing in the In Test sweep uses the slot, so In Test no
// longer keeps one. And #794's PR had reached In Test behind a desktop version
// bump on main, so its desktop beta could never upload: --watch now brings a
// behind branch up to date before the hand-off.

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "factory-agent.sh");
const script = readFileSync(agentPath, "utf8");

function slice(startMarker, endMarker) {
  const start = script.indexOf(startMarker);
  const end = script.indexOf(endMarker, start);
  assert.ok(start !== -1 && end !== -1, `could not locate ${startMarker}`);
  return script.slice(start, end);
}

const sweepBlock = slice(
  "  # ── 1. Cleanup sweep ──",
  "  # ── 1b. CodeRabbit CLI run housekeeping",
);
const gateBlock = slice(
  "    # Behind main? (ADR-0070.)",
  "    # Pre-In-Test verification (ADR-0053).",
);
const implementBlock = slice("# ── --implement mode", "# ── --watch mode");
const watchBlock = slice("# ── --watch mode", "# ── In Test feedback sweep");

// Run <body> under the script's own `set -euo pipefail`, with the named real
// functions extracted from the script and gh / node / log / transition_status
// stubbed. Every stub call lands in $CALLS, printed after the body's stdout.
function run(fns, body, stubs = "") {
  const dir = mkdtempSync(join(tmpdir(), "factory-intest-slot-"));
  const extract = fns
    .map((fn) => `eval "$(awk '/^${fn}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"`)
    .join("\n");
  const snippet = `
set -euo pipefail
CALLS="${dir}/calls"; : >"$CALLS"
LOG_FILE="${dir}/log"
STATE_FILE="${dir}/state.json"
SCRIPT_DIR=/factory/scripts
REPO_ROOT="${dir}/repo"
DRY_RUN=0
FACTORY_MAX_BRANCH_UPDATES=3
log() { echo "LOG $*" >>"$CALLS"; }
transition_status() { echo "MOVE $2 $3" >>"$CALLS"; }
remove_worktree_for() { echo "RMWT $1" >>"$CALLS"; }
release_slot_and_worktree() { echo "FREE $1" >>"$CALLS"; }
${stubs}
${extract}
${body}
echo "---"
cat "$CALLS"
`;
  try {
    const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
    assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
    const [out, calls] = r.stdout.split("---\n");
    return { out: out.trim(), calls: calls.trim().split("\n").filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("cleanup sweep: a slot follows the board column (ADR-0070)", () => {
  // <slotList> is [[issue, issueView], …] in slot order. issueView is the
  // `gh issue view --json state,projectItems` answer, or null when that call
  // fails (and only `--json state` answers, with <fallbackState>).
  function sweep(slotList, { dry = 0, fallbackState = "OPEN" } = {}) {
    const slots = {
      slots: Object.fromEntries(slotList.map(([n], i) => [i, { issueNumber: n }])),
    };
    const ghCases = slotList
      .map(([n, view]) =>
        view === null
          ? `${n}) if [[ "$*" == *projectItems* ]]; then return 1; fi; echo '{"state":"${fallbackState}"}' ;;`
          : `${n}) echo '${JSON.stringify(view)}' ;;`,
      )
      .join("\n      ");
    const stubs = `
node() {
  case "$2" in
    factory:slot-status) echo '${JSON.stringify(slots)}' ;;
    factory:slot-release) echo "RELEASE $3" >>"$CALLS" ;;
  esac
}
gh() {
  case "$3" in
      ${ghCases}
  esac
}`;
    return run([], `DRY_RUN=${dry}\n${sweepBlock}`, stubs).calls;
  }
  const card = (column, state = "OPEN", title = "Drafto Factory") => ({
    state,
    projectItems: column ? [{ status: { optionId: "x", name: column }, title }] : [],
  });

  it("frees an In Test card's slot and worktree, and keeps an In Progress card", () => {
    const calls = sweep([
      ["794", card("In Test")],
      ["759", card("In Progress")],
    ]);
    assert.deepEqual(calls, [
      "LOG Slot 0: issue #794 left In Progress/In Review/Testing (now: In Test, OPEN); releasing slot + worktree",
      "RELEASE 0",
      "RMWT 794",
    ]);
  });

  it("reads the column, not the label: a plan approved out of Plan Review keeps its slot", () => {
    // #759 still carried status:plan-review in In Progress on 2026-11-09: the
    // label-based sweep would have freed its slot between two retries.
    assert.deepEqual(sweep([["759", card("In Progress")]]), []);
  });

  it("keeps In Review and Testing, the factory's own work", () => {
    assert.deepEqual(
      sweep([
        ["1", card("In Review")],
        ["2", card("Testing")],
      ]),
      [],
    );
  });

  it("frees Approved, closed and off-board cards, and only counts the factory board", () => {
    const calls = sweep([
      ["5", card("Approved")],
      ["6", card("In Progress", "CLOSED")],
    ]);
    assert.deepEqual(
      calls.filter((c) => c.startsWith("RELEASE")),
      ["RELEASE 0", "RELEASE 1"],
    );
    assert.ok(sweep([["7", card(null)]]).includes("RELEASE 0"));
    assert.ok(
      sweep([["8", card("In Progress", "OPEN", "Some Other Board")]]).includes("RELEASE 0"),
    );
  });

  it("without the column, frees only a closed issue's slot", () => {
    const open = sweep([["794", null]]);
    assert.ok(!open.some((c) => c.startsWith("RELEASE")), open.join("\n"));
    assert.ok(open.some((c) => c.includes("couldn't read its board column")));
    const closed = sweep([["794", null]], { fallbackState: "CLOSED" });
    assert.ok(closed.includes("RELEASE 0"), closed.join("\n"));
  });

  it("changes nothing in a dry run", () => {
    const calls = sweep([["794", card("In Test")]], { dry: 1 });
    assert.ok(
      !calls.some((c) => c.startsWith("RELEASE") || c.startsWith("RMWT")),
      calls.join("\n"),
    );
  });

  it("no longer consults status:* labels", () => {
    assert.ok(!sweepBlock.includes("status:in-"), "the sweep must read the board, not labels");
    assert.match(sweepBlock, /--json state,projectItems 2>>/);
  });
});

describe("--implement: work in flight goes first (ADR-0070)", () => {
  const items = JSON.stringify([
    { itemId: "a", issueNumber: 794 },
    { itemId: "b", issueNumber: "460" },
    { itemId: "c", issueNumber: 759 },
    { itemId: "d", issueNumber: 242 },
    { itemId: "e", issueNumber: 498 },
  ]);
  const prs = JSON.stringify([
    { headRefName: "factory/issue-759" },
    { headRefName: "factory/issue-460" },
    { headRefName: "dependabot/npm/foo" },
    { headRefName: "factory/issue-7940" },
  ]);
  function order({ slots = [null, null], gh = `echo '${prs}'` } = {}) {
    const slotJson = JSON.stringify({
      slots: { 0: { issueNumber: slots[0] }, 1: { issueNumber: slots[1] } },
    });
    const r = run(
      ["implement_queue_order"],
      `implement_queue_order '${items}'`,
      `node() { echo '${slotJson}'; }\ngh() { echo GH >>"$CALLS"; ${gh}; }`,
    );
    return { order: JSON.parse(r.out).map((i) => String(i.issueNumber)), calls: r.calls };
  }

  it("takes slot holders, then open-PR cards, then fresh ones, keeping board order in each", () => {
    assert.deepEqual(order().order, ["460", "759", "794", "242", "498"]);
    assert.deepEqual(order({ slots: ["242", null] }).order, ["242", "460", "759", "794", "498"]);
  });

  it("skips the PR lookup when nothing in the column could run", () => {
    const r = order({ slots: ["111", "222"] });
    assert.deepEqual(r.order, ["794", "460", "759", "242", "498"]);
    assert.deepEqual(r.calls, []);
    // ...but not when a card here holds a slot it could free mid-sweep
    assert.deepEqual(order({ slots: ["111", "498"] }).calls, ["GH"]);
  });

  it("falls back to holders-first, then board order, when the PR lookup fails", () => {
    assert.deepEqual(order({ gh: "return 1" }).order, ["794", "460", "759", "242", "498"]);
    assert.deepEqual(order({ slots: ["242", null], gh: "return 1" }).order, [
      "242",
      "794",
      "460",
      "759",
      "498",
    ]);
    assert.deepEqual(order({ gh: "echo 'not json'" }).order, ["794", "460", "759", "242", "498"]);
  });

  it("is applied before the In Progress loop, and only when there is something to order", () => {
    const call = implementBlock.indexOf('INPROG_JSON=$(implement_queue_order "$INPROG_JSON")');
    const loop = implementBlock.indexOf("for ((IDX=0; IDX<INPROG_COUNT; IDX++)); do");
    assert.ok(call !== -1 && loop !== -1 && call < loop);
    assert.match(
      implementBlock,
      /if \[\[ "\$INPROG_COUNT" -gt 1 && "\$PHASE" != "A" \]\]; then\n {4}INPROG_JSON=\$\(implement_queue_order/,
    );
  });

  it("starts each In Review stint with a fresh behind-main budget, on both paths to In Review", () => {
    const resets = implementBlock.match(
      /factory:set-issue-field "\$ISSUE_NUM" branchUpdates "" --state-file/g,
    );
    assert.equal(resets?.length, 2);
  });

  it("frees the slot once a no-op or declined revision has moved back to In Test", () => {
    const fn = script.match(/^revision_return_to_test\(\) \{\n[\s\S]*?\n\}\n/m)?.[0] ?? "";
    assert.match(
      fn,
      /elif transition_status "\$item_id" "\$issue_num" "In Test"; then\n {4}in_test=1/,
    );
    assert.match(
      fn,
      /if \[\[ "\$in_test" -eq 1 \]\]; then\n {4}release_slot_and_worktree "\$issue_num"/,
    );
  });
});

describe("pr_behind_main / update_pr_branch", () => {
  it("prints main's lead over the head from the compare API", () => {
    const r = run(
      ["pr_behind_main"],
      "pr_behind_main abc123",
      `gh() { echo "GH $*" >>"$CALLS"; echo 2; }`,
    );
    assert.equal(r.out, "2");
    assert.deepEqual(r.calls, [
      "GH api repos/JakubAnderwald/drafto/compare/main...abc123 --jq .behind_by",
    ]);
  });

  it("prints nothing when it can't tell", () => {
    assert.equal(run(["pr_behind_main"], "pr_behind_main abc123", "gh() { return 1; }").out, "");
    assert.equal(run(["pr_behind_main"], "pr_behind_main abc123", "gh() { echo null; }").out, "");
    assert.equal(run(["pr_behind_main"], 'pr_behind_main ""', "gh() { echo 5; }").out, "");
  });

  it("updates with a PUT pinned to the head it read", () => {
    const r = run(
      ["update_pr_branch"],
      "update_pr_branch 802 abc123",
      `gh() { echo "GH $*" >>"$CALLS"; }`,
    );
    assert.deepEqual(r.calls, [
      "GH api --method PUT repos/JakubAnderwald/drafto/pulls/802/update-branch -f expected_head_sha=abc123",
    ]);
  });
});

describe("worktree_within_head: never update past unpushed commits (ADR-0070)", () => {
  function git(cwd, ...args) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  }
  function within(setup) {
    const dir = mkdtempSync(join(tmpdir(), "factory-within-"));
    try {
      const wt = join(dir, "repo", "worktrees", "factory-issue-794");
      spawnSync("mkdir", ["-p", wt]);
      git(wt, "init", "-q", "-b", "factory/issue-794");
      git(
        wt,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "a",
      );
      const a = git(wt, "rev-parse", "HEAD");
      git(
        wt,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "b",
      );
      const b = git(wt, "rev-parse", "HEAD");
      const prHead = setup({ wt, a, b });
      const r = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail; LOG_FILE=/dev/null; REPO_ROOT="${join(dir, "repo")}"
eval "$(awk '/^worktree_within_head\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
if worktree_within_head 794 "${prHead}"; then echo OK; else echo AHEAD; fi`,
        ],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("allows a worktree at, or behind, the PR head", () => {
    assert.equal(
      within(({ b }) => b),
      "OK",
    );
    assert.equal(
      within(({ wt, a, b }) => {
        git(wt, "reset", "-q", "--hard", a);
        return b;
      }),
      "OK",
    );
  });

  it("refuses a worktree with commits the PR lacks", () => {
    assert.equal(
      within(({ a }) => a),
      "AHEAD",
    );
  });

  it("allows an issue with no worktree", () => {
    const r = run(
      ["worktree_within_head"],
      "if worktree_within_head 794 abc; then echo OK; else echo AHEAD; fi",
    );
    assert.equal(r.out, "OK");
  });
});

describe("carry_across_branch_update: a clean update keeps its review (ADR-0070)", () => {
  const OLD = "a".repeat(40);
  const NEW = "b".repeat(40);
  const MAIN = "c".repeat(40);
  function carry({
    from = OLD,
    review = OLD,
    cr = OLD,
    parents = `${OLD} ${MAIN}`,
    committer = "web-flow",
    subject = "Merge branch 'main' into factory/issue-794",
    head = NEW,
    gh = 0,
  }) {
    const state = JSON.stringify({
      branchUpdatedFrom: from,
      lastReviewSha: review,
      crCoverageSha: cr,
    });
    const commit = JSON.stringify({ parents, committer, subject }).replaceAll("'", "'\\''");
    const stubs = `
node() {
  case "$2" in
    factory:get-issue) echo '${state}' ;;
    factory:set-issue-field) echo "SET $4 $5" >>"$CALLS" ;;
  esac
}
gh() { echo "GH $2" >>"$CALLS"; [[ ${gh} -eq 0 ]] || return 1; echo '${commit}'; }`;
    return run(
      ["carry_across_branch_update"],
      `if carry_across_branch_update 794 "${head}"; then echo CARRIED; else echo REVIEW; fi`,
      stubs,
    );
  }

  it("carries the review and CodeRabbit coverage onto the update's merge commit", () => {
    const r = carry({});
    assert.equal(r.out, "CARRIED");
    assert.deepEqual(r.calls, [
      `GH repos/JakubAnderwald/drafto/commits/${NEW}`,
      `SET lastReviewSha ${NEW}`,
      `SET crCoverageSha ${NEW}`,
      `LOG Issue #794: ${NEW.slice(0, 12)} only merges main into the reviewed ${OLD.slice(0, 12)}; carried its code review and CodeRabbit coverage over`,
    ]);
  });

  it("carries only the review when CodeRabbit never decided the old commit", () => {
    const r = carry({ cr: "" });
    assert.equal(r.out, "CARRIED");
    assert.ok(!r.calls.some((c) => c.startsWith("SET crCoverageSha")));
  });

  it("reviews a head that is anything but GitHub's own update merge", () => {
    for (const [why, opts] of [
      ["a single-parent push", { parents: OLD }],
      ["a merge onto something else", { parents: `${MAIN} ${OLD}` }],
      ["a conflict resolution committed locally", { committer: "JakubAnderwald" }],
      [
        "a web-flow commit that isn't a main merge",
        { subject: "Apply suggestions from code review" },
      ],
      ["no update recorded", { from: "" }],
      ["an updated commit that was never reviewed", { review: MAIN }],
      ["the recorded commit itself", { head: OLD }],
      ["GitHub unreadable", { gh: 1 }],
    ]) {
      const r = carry(opts);
      assert.equal(r.out, "REVIEW", why);
      assert.ok(!r.calls.some((c) => c.startsWith("SET")), why);
    }
  });

  it("runs before the code review reads lastReviewSha, outside dry runs", () => {
    const carryIdx = watchBlock.indexOf('carry_across_branch_update "$ISSUE_NUM" "$HEAD_SHA"');
    const readIdx = watchBlock.indexOf("LAST_REVIEW_SHA=$(node");
    assert.ok(carryIdx !== -1 && readIdx !== -1 && carryIdx < readIdx);
    assert.match(watchBlock, /\[\[ "\$DRY_RUN" -eq 1 \]\] \|\| carry_across_branch_update/);
  });
});

describe("--watch: a behind PR is updated before In Test (ADR-0070)", () => {
  // Run the real gate inside a one-card loop: "PROMOTE" means the card went on
  // towards Testing / In Test, its absence that the gate `continue`d.
  function gate({
    behind,
    updates = "0",
    put = 0,
    head = "abc123",
    mergeable = "MERGEABLE",
    dry = 0,
    within = 0,
  }) {
    const stubs = `
node() {
  case "$2" in
    factory:get-issue) echo '{"branchUpdates":"${updates}"}' ;;
    factory:set-issue-field) echo "SET $3 $4 $5" >>"$CALLS" ;;
  esac
}
worktree_within_head() { return ${within}; }
gh() {
  if [[ "$1 $2" == "api --method" ]]; then echo "GH update-branch $*" >>"$CALLS"; return ${put}; fi
  if [[ "$1" == "api" ]]; then echo "${behind}"; return 0; fi
  if [[ "$*" == *"--json headRefOid"* ]]; then echo "${head}"; return 0; fi
  if [[ "$*" == *"--json mergeable"* ]]; then echo "${mergeable}"; return 0; fi
  if [[ "$1 $2" == "issue comment" ]]; then echo "GH comment" >>"$CALLS"; fi
}`;
    const body = `
DRY_RUN=${dry}
ISSUE_NUM=794; PR_NUM=802; HEAD_SHA=abc123
for _once in 1; do
${gateBlock}
  echo PROMOTE
done`;
    return run(["pr_behind_main", "update_pr_branch", "pr_head_oid"], body, stubs);
  }

  it("goes straight on when the branch is up to date, or the compare fails", () => {
    assert.equal(gate({ behind: "0" }).out, "PROMOTE");
    assert.equal(gate({ behind: "" }).out, "PROMOTE");
  });

  it("updates a behind branch, records it, drops the stale worktree and holds the card for CI", () => {
    const r = gate({ behind: "3" });
    assert.equal(r.out, "");
    assert.deepEqual(r.calls, [
      "SET 794 branchUpdates 1",
      "GH update-branch api --method PUT repos/JakubAnderwald/drafto/pulls/802/update-branch -f expected_head_sha=abc123",
      "SET 794 branchUpdatedFrom abc123",
      "LOG Issue #794: PR #802 was 3 commit(s) behind main; updated the branch (CI re-runs on the merged head)",
      "FREE 794",
    ]);
    assert.ok(!r.calls.includes("GH comment"), "no issue comment from In Review");
  });

  it("doesn't update past commits the worktree has and the PR lacks", () => {
    const r = gate({ behind: "3", within: 1 });
    assert.equal(r.out, "PROMOTE");
    assert.ok(!r.calls.some((c) => c.startsWith("GH update-branch") || c.startsWith("FREE")));
    assert.ok(r.calls.some((c) => c.includes("worktree has commits the PR lacks")));
  });

  it("goes on as it stands once the budget is spent", () => {
    const r = gate({ behind: "2", updates: "3" });
    assert.equal(r.out, "PROMOTE");
    assert.ok(!r.calls.some((c) => c.startsWith("GH update-branch")));
  });

  it("rechecks next tick when update-branch fails because the head moved or a conflict is pending", () => {
    for (const g of [
      gate({ behind: "1", put: 1, head: "def456" }),
      gate({ behind: "1", put: 1, mergeable: "UNKNOWN" }),
    ]) {
      assert.equal(g.out, "");
      assert.ok(!g.calls.some((c) => c.includes("branchUpdatedFrom") || c.startsWith("FREE")));
    }
  });

  it("lets a card through when update-branch fails for any other reason", () => {
    const r = gate({ behind: "1", put: 1 });
    assert.equal(r.out, "PROMOTE");
    assert.ok(r.calls.some((c) => c.startsWith("LOG WARNING: update-branch failed for PR #802")));
  });

  it("only logs in a dry run", () => {
    const r = gate({ behind: "4", dry: 1 });
    assert.equal(r.out, "");
    assert.deepEqual(r.calls, [
      "LOG DRY-RUN: PR #802 is 4 commit(s) behind main; would update the branch before In Test",
    ]);
  });

  it("is the last check before either promotion, after every wait a card can park in", () => {
    const at = (s) => {
      const i = watchBlock.indexOf(s);
      assert.ok(i !== -1, `missing: ${s}`);
      return i;
    };
    const gateIdx = at("    # Behind main? (ADR-0070.)");
    for (const before of [
      "required checks not all green yet; waiting",
      "CI green but no Vercel preview URL yet; waiting",
      'review_stage "$ISSUE_NUM"',
      'if ! cr_lane_gate "$ISSUE_NUM"',
      'if ! hosted_config_gate "$ISSUE_NUM"',
    ]) {
      assert.ok(at(before) < gateIdx, `${before} must come before the gate`);
    }
    assert.ok(gateIdx < at('if verify_target_status "$ISSUE_NUM"'));
    assert.ok(gateIdx < at('transition_status "$ITEM_ID" "$ISSUE_NUM" "In Test"'));
  });

  it("gives each In Test round a fresh budget, from both promotions", () => {
    assert.match(watchBlock, /factory:set-issue-field "\$ISSUE_NUM" branchUpdates "" --state-file/);
    assert.match(script, /factory:set-issue-field "\$issue_num" branchUpdates "" --state-file/);
  });
});
