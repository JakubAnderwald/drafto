import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Tests for the In Test iteration loop: a reporter comment on an In Test card
// rolls it back to In Progress for a revision on the same PR branch. Covers the
// two new bash helpers (behaviourally, by extracting the real definitions from
// the script) and the structural wiring in factory-agent.sh.

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "factory-agent.sh");
const script = readFileSync(agentPath, "utf8");

// Run a bash snippet that extracts a function definition from the real script
// (start of `name()` through its first column-0 `}`) and exercises it.
function withFn(fn, body) {
  const snippet = `
set -euo pipefail
eval "$(awk '/^${fn}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
${body}
`;
  const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
  assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
  return r.stdout.trim();
}

describe("is_noise_comment (extracted from factory-agent.sh)", () => {
  const noise = ["thanks!", "Thank you", "LGTM 👍", "👍", "Looks good.", "ship it", "perfect", "x"];
  const actionable = [
    "move the button to the top-right",
    "the close button overlaps the title",
    "add an Esc key handler please",
  ];
  for (const c of noise) {
    it(`treats ${JSON.stringify(c)} as noise`, () => {
      assert.equal(
        withFn(
          "is_noise_comment",
          `is_noise_comment ${JSON.stringify(c)} && echo NOISE || echo ACTIONABLE`,
        ),
        "NOISE",
      );
    });
  }
  for (const c of actionable) {
    it(`treats ${JSON.stringify(c)} as actionable`, () => {
      assert.equal(
        withFn(
          "is_noise_comment",
          `is_noise_comment ${JSON.stringify(c)} && echo NOISE || echo ACTIONABLE`,
        ),
        "ACTIONABLE",
      );
    });
  }
});

describe("owner_comments_since (extracted from factory-agent.sh)", () => {
  const cjson = JSON.stringify([
    {
      id: 1,
      user: { login: "x" },
      body: "old",
      createdAt: "2026-05-24T10:00:00Z",
      authorAssociation: "OWNER",
    },
    {
      id: 2,
      user: { login: "bot" },
      body: "<!-- drafto-factory-in-test -->preview",
      createdAt: "2026-05-24T12:00:00Z",
      authorAssociation: "OWNER",
    },
    {
      id: 3,
      user: { login: "x" },
      body: "move the button",
      createdAt: "2026-05-24T13:00:00Z",
      authorAssociation: "OWNER",
    },
    {
      id: 4,
      user: { login: "ext" },
      body: "not owner",
      createdAt: "2026-05-24T13:30:00Z",
      authorAssociation: "NONE",
    },
  ]);

  it("returns only new OWNER comments, excluding factory markers and non-owners", () => {
    const out = withFn(
      "owner_comments_since",
      `owner_comments_since ${JSON.stringify(cjson)} "2026-05-24T11:00:00Z" | jq -c '[.[].id]'`,
    );
    assert.equal(out, "[3]");
  });

  it("returns [] when no baseline (since empty)", () => {
    const out = withFn("owner_comments_since", `owner_comments_since ${JSON.stringify(cjson)} ""`);
    assert.equal(out, "[]");
  });

  it("drops the implementer's revision reply, so it can't re-trigger a revision", () => {
    const withReply = JSON.stringify([
      ...JSON.parse(cjson),
      {
        id: 5,
        user: { login: "x" },
        body: "🏭 Ran all 11 steps.\n\n<!-- drafto-factory-revise-reply-3 -->",
        createdAt: "2026-05-24T14:00:00Z",
        authorAssociation: "OWNER",
      },
    ]);
    const out = withFn(
      "owner_comments_since",
      `owner_comments_since ${JSON.stringify(withReply)} "2026-05-24T11:00:00Z" | jq -c '[.[].id]'`,
    );
    assert.equal(out, "[3]");
  });
});

describe("revise_noop_reply (extracted, real bash)", () => {
  // Runs the real revise_noop_reply against a stubbed comment list. `gh` is a
  // HARD STUB: the fallback path posts an issue comment, and without the stub a
  // unit test would post to a live issue. The fetch stub fails its first
  // `failFirst` calls and counts every call; `sleep` is stubbed out.
  function runReply({ comments = [], failFirst = 0, pr = "665", marker, kind = "" }) {
    const dir = mkdtempSync(join(tmpdir(), "revise-reply-"));
    const fetches = join(dir, "fetches");
    try {
      const snippet = `
set -euo pipefail
eval "$(awk '/^revise_noop_reply\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"
log() { echo "[log] $*"; }
gh() { printf '[gh-stub] %s\\n' "$*"; return 0; }
sleep() { :; }
fetch_issue_comments() {
  local n
  n=$(( $(cat ${JSON.stringify(fetches)} 2>/dev/null || echo 0) + 1 ))
  echo "$n" >${JSON.stringify(fetches)}
  if [[ "$n" -le ${failFirst} ]]; then return 1; fi
  printf '%s' ${JSON.stringify(JSON.stringify(comments))}
}
LOG_FILE=${JSON.stringify(join(dir, "agent.log"))}
revise_noop_reply 659 ${JSON.stringify(pr)} ${JSON.stringify(marker)}${kind ? ` ${JSON.stringify(kind)}` : ""}
`;
      const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
      assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
      const read = (p) => {
        try {
          return readFileSync(p, "utf8");
        } catch {
          return "";
        }
      };
      return {
        log: r.stdout,
        posted: read(join(dir, "agent.log")),
        fetches: Number(read(fetches) || 0),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const reply = (id) => ({ id: 9, body: `🏭 Done.\n\n<!-- drafto-factory-revise-reply-${id} -->` });

  it("posts nothing when the implementer's reply is on the issue", () => {
    const out = runReply({ comments: [reply(123)], marker: "drafto-factory-revise-reply-123" });
    assert.match(out.log, /revision reply posted \(drafto-factory-revise-reply-123\)/);
    assert.equal(out.posted, "");
  });

  it("posts the fallback, naming the PR, when no reply was left", () => {
    const out = runReply({ comments: [], marker: "drafto-factory-revise-reply-123" });
    assert.match(out.log, /no revision reply found for drafto-factory-revise-reply-123/);
    assert.match(out.posted, /\[gh-stub\] issue comment 659 --repo JakubAnderwald\/drafto/);
    assert.match(out.posted, /No code change was made for that, and no reply was found/);
    assert.match(out.posted, /notes in PR #665's description; if not, comment again/);
    assert.match(out.posted, /<!-- drafto-factory-revise-noop -->/);
  });

  it("does not take another round's reply for this one (reply-1234 is not reply-123)", () => {
    const out = runReply({ comments: [reply(1234)], marker: "drafto-factory-revise-reply-123" });
    assert.match(out.posted, /no reply was found/);
  });

  it("posts the fallback without a marker to look for, and fetches nothing", () => {
    const out = runReply({ comments: [reply(123)], marker: "" });
    assert.match(out.log, /no reply marker for this revision; posting the fallback/);
    assert.match(out.posted, /<!-- drafto-factory-revise-noop -->/);
    assert.equal(out.fetches, 0);
  });

  it("drops the PR sentence when the PR number is unknown", () => {
    const out = runReply({ comments: [], pr: "", marker: "drafto-factory-revise-reply-123" });
    assert.match(out.posted, /The preview is unchanged\. Drag to/);
    assert.doesNotMatch(out.posted, /notes in PR/);
  });

  it("retries a failed comment fetch before deciding", () => {
    const out = runReply({
      comments: [reply(123)],
      failFirst: 2,
      marker: "drafto-factory-revise-reply-123",
    });
    assert.equal(out.fetches, 3);
    assert.match(out.log, /revision reply posted/);
    assert.equal(out.posted, "");
  });

  it("fails open: posts the fallback when the comments still can't be read", () => {
    // A silent round trip is the bug this exists to fix, so an unreadable
    // thread must not count as "replied".
    const out = runReply({ failFirst: 99, marker: "drafto-factory-revise-reply-123" });
    assert.equal(out.fetches, 3);
    assert.match(out.log, /WARNING: could not read #659's comments/);
    assert.match(out.posted, /<!-- drafto-factory-revise-noop -->/);
  });

  it("a declined revision with its reply posted gets no fallback (ADR-0058)", () => {
    const out = runReply({
      comments: [reply(123)],
      marker: "drafto-factory-revise-reply-123",
      kind: "declined",
    });
    assert.match(out.log, /revision reply posted/);
    assert.equal(out.posted, "");
  });

  it("a declined revision with no reply gets the declined fallback, not the no-op one", () => {
    const out = runReply({
      comments: [],
      marker: "drafto-factory-revise-reply-123",
      kind: "declined",
    });
    assert.match(
      out.posted,
      /The factory declined that as outside this issue's plan, and no reply was found/,
    );
    assert.match(out.posted, /Open a new issue for that work instead of rephrasing it here/);
    assert.match(out.posted, /Drag to \*\*Approved\*\* to ship this PR as it is\./);
    // Rephrasing an out-of-plan request would only be declined again.
    assert.doesNotMatch(out.posted, /comment a more specific change/);
    assert.doesNotMatch(out.posted, /No code change was made for that/);
    assert.match(out.posted, /<!-- drafto-factory-revise-noop -->/);
  });
});

describe("worktree_untouched (extracted, real git)", () => {
  // The guard that decides whether a declined revision may go back to In Test:
  // only a worktree holding nothing the PR lacks qualifies, and any doubt
  // (a git error, an unknown PR head) counts as touched.
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), "untouched-"));
    const git = (...args) => {
      const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("commit", "-q", "--allow-empty", "-m", "one");
    const one = git("rev-parse", "HEAD");
    git("commit", "-q", "--allow-empty", "-m", "two");
    const two = git("rev-parse", "HEAD");
    return { dir, git, one, two };
  }
  const check = (dir, head) =>
    withFn(
      "worktree_untouched",
      `LOG_FILE=/dev/null; worktree_untouched ${JSON.stringify(dir)} ${JSON.stringify(head)} && echo UNTOUCHED || echo TOUCHED`,
    );
  const cases = [
    ["sits on the PR head", "UNTOUCHED", ({ two }) => two],
    [
      "is merely behind the PR head",
      "UNTOUCHED",
      ({ git, one, two }) => {
        git("checkout", "-q", one);
        return two;
      },
    ],
    ["has commits the PR head lacks", "TOUCHED", ({ one }) => one],
    [
      "diverged from the PR head",
      "TOUCHED",
      ({ git, one, two }) => {
        git("checkout", "-q", one);
        git("commit", "-q", "--allow-empty", "-m", "side");
        return two;
      },
    ],
    [
      "has uncommitted edits",
      "TOUCHED",
      ({ dir, two }) => {
        writeFileSync(join(dir, "edited.txt"), "half-done change\n");
        return two;
      },
    ],
    // A PR head that isn't in the local object store makes merge-base error:
    // undecidable, so fail closed rather than read it as "behind".
    ["can't see the PR head commit", "TOUCHED", () => "0".repeat(40)],
    ["has no PR head to compare against", "TOUCHED", () => ""],
  ];
  for (const [name, want, setup] of cases) {
    it(`reads a worktree that ${name} as ${want.toLowerCase()}`, () => {
      const ctx = repo();
      try {
        assert.equal(check(ctx.dir, setup(ctx)), want);
      } finally {
        rmSync(ctx.dir, { recursive: true, force: true });
      }
    });
  }
});

describe("factory-agent.sh structural wiring (In Test iteration)", () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", agentPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  it("cleanup keep-set retains slots for in-progress (so the worktree survives a revision bounce)", () => {
    // status:testing too: a card verifying in the Testing column (ADR-0053)
    // still owns its slot + worktree.
    assert.match(
      script,
      /any\(\. == "status:in-progress" or \. == "status:in-review" or \. == "status:testing" or \. == "status:in-test"\)/,
    );
  });

  it("has an In Test feedback sweep that returns cards to In Progress", () => {
    assert.match(script, /In Test feedback sweep/);
    assert.match(script, /query-status-items \\\n\s*--status "In Test"/);
    assert.match(script, /drafto-factory-revising/);
    assert.match(script, /transition_status "\$ITEM_ID" "\$ISSUE_NUM" "In Progress"/);
  });

  it("feeds revision comments to the implementer bundle when a prior PR exists", () => {
    assert.match(script, /REVISION_COMMENTS=\$\(owner_comments_since/);
    assert.match(
      script,
      /build_implement_bundle "\$ISSUE_RECORD" "\$PLAN_COMMENT_JSON" "\$PRIOR_PR" "\$ATTEMPTS" "\$REVISION_COMMENTS"/,
    );
  });

  it("a revision no-op re-presents the existing preview (back to In Test)", () => {
    assert.match(script, /drafto-factory-revise-noop/);
    // Slice the noop arm rather than pinning line adjacency: the revision arm
    // now opens with the committed-but-unlanded guard before this comment.
    const noopArm = (() => {
      const start = script.indexOf('      noop)\n        if [[ "$IS_REVISION" -eq 1 ]]; then');
      assert.ok(start !== -1, "could not find the implement noop arm");
      const end = script.indexOf("      blocked)", start);
      assert.ok(end !== -1, "could not find the end of the noop arm");
      return script.slice(start, end);
    })();
    assert.match(noopArm, /# The feedback needed no code change/);
    // The PR number comes from bash's own lookup, and the shared helper does
    // the move, the consume and the reply check.
    assert.match(
      noopArm,
      /revision_return_to_test "\$ISSUE_NUM" "\$ITEM_ID" "\$PRE_HEAD_OID" "\$ITEM_LABELS" \\\n\s*"\$\(echo "\$PRIOR_PR" \| jq -r '\.number \/\/ ""'[^\n]*\n\s*"\$REPLY_MARKER" "\$FEEDBACK_MARK" noop\n/,
    );
    assert.doesNotMatch(noopArm, /gh issue comment/);
    const back = script.slice(
      script.indexOf("revision_return_to_test() {"),
      script.indexOf("\n}\n", script.indexOf("revision_return_to_test() {")),
    );
    assert.match(back, /transition_status "\$item_id" "\$issue_num" "In Test"/);
    assert.match(back, /lastFeedbackAt "\$mark"/);
    assert.match(back, /factory:reset-attempts "\$issue_num"/);
    // The reply check replaced the arm's own fixed comment.
    assert.match(back, /revise_noop_reply "\$issue_num" "\$pr_num" "\$marker" "\$kind"/);
  });

  // --implement's own arms; other stages have blocked) arms of their own.
  const implementArm = (name) => {
    const from = script.indexOf('      noop)\n        if [[ "$IS_REVISION" -eq 1 ]]; then');
    const start = script.indexOf(`      ${name})\n`, from);
    assert.ok(from !== -1 && start !== -1, `could not find --implement's ${name} arm`);
    return script.slice(start, script.indexOf("\n        ;;\n", start));
  };

  it("returns a declined revision to In Test only for the head shown there, untouched (ADR-0058)", () => {
    const arm = implementArm("declined");
    assert.match(arm, /jq -r '\.intestCommentSha \/\/ ""'/);
    assert.match(
      arm,
      /if \[\[ "\$IS_REVISION" -eq 1 && "\$PRE_HEAD_KNOWN" -eq 1 && -n "\$PRE_HEAD_OID" \\\n\s*&& "\$DECLINE_SHOWN_SHA" == "\$PRE_HEAD_OID" \]\] \\\n\s*&& worktree_untouched "\$WT_PATH" "\$PRE_HEAD_OID"; then\n\s*revision_return_to_test /,
    );
    assert.match(arm, /"\$REPLY_MARKER" "\$FEEDBACK_MARK" declined\n/);
    // Anything else parks in Blocked, as action=blocked does.
    assert.match(arm, /else\n\s*implement_park_blocked "\$ITEM_ID" "\$ISSUE_NUM" "\$SLOT" \\/);
  });

  it("still parks every action=blocked in Blocked, revision or not", () => {
    const arm = implementArm("blocked");
    assert.match(
      arm,
      /implement_park_blocked "\$ITEM_ID" "\$ISSUE_NUM" "\$SLOT" "implementer returned blocked"/,
    );
    assert.doesNotMatch(arm, /revision_return_to_test/);
    const park = script.slice(
      script.indexOf("implement_park_blocked() {"),
      script.indexOf("\n}\n", script.indexOf("implement_park_blocked() {")),
    );
    assert.match(park, /transition_status "\$item_id" "\$issue_num" "Blocked"/);
    assert.match(park, /factory:slot-release "\$slot"/);
    assert.match(park, /worktree-cli\.mjs" remove --issue "\$issue_num"/);
  });

  it("keys the revision reply marker on the newest feedback comment and hands it to the bundle", () => {
    const start = script.indexOf('    REVISION_COMMENTS="[]"');
    assert.ok(start !== -1, "could not find the revision-feedback block");
    const block = script.slice(start, script.indexOf("    # Acquire a slot", start));
    // Reset per issue, so one card's marker can't leak into the next card's run.
    assert.match(block, /REPLY_MARKER=""\n/);
    assert.match(block, /sort_by\(\.createdAt\) \| \.\[-1\]\.id/);
    assert.match(block, /REPLY_MARKER="drafto-factory-revise-reply-\$REPLY_ID"/);
    assert.match(
      script,
      /build_implement_bundle "\$ISSUE_RECORD" "\$PLAN_COMMENT_JSON" "\$PRIOR_PR" "\$ATTEMPTS" "\$REVISION_COMMENTS" "\$COMMENTS_JSON" "\$REPLY_MARKER"\)/,
    );
    assert.match(script, /--arg replyMarker "\$reply_marker"/);
  });

  it("the revising notice says non-code feedback gets a reply on the issue", () => {
    assert.match(script, /Anything else, such as a question or a \\\ntest run, gets a reply here/);
  });

  it("advances the feedback high-water mark only after consuming comments", () => {
    // lastFeedbackAt is set in --implement (consume), not in the sweep (detect).
    assert.match(script, /lastFeedbackAt "\$NOW_ISO"/);
  });
});
