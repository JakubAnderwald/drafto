import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  function runReply({ comments = [], failFirst = 0, pr = "665", marker }) {
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
revise_noop_reply 659 ${JSON.stringify(pr)} ${JSON.stringify(marker)}
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
});

describe("factory-agent.sh structural wiring (In Test iteration)", () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", agentPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  it("cleanup keep-set retains slots for in-progress (so the worktree survives a revision bounce)", () => {
    assert.match(
      script,
      /any\(\. == "status:in-progress" or \. == "status:in-review" or \. == "status:in-test"\)/,
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
    assert.match(noopArm, /transition_status "\$ITEM_ID" "\$ISSUE_NUM" "In Test"/);
    // The reply check replaced the arm's own fixed comment.
    assert.match(
      noopArm,
      /revise_noop_reply "\$ISSUE_NUM" "\$\(echo "\$PRIOR_PR" \| jq -r '\.number \/\/ ""'/,
    );
    assert.match(noopArm, /"\$REPLY_MARKER"\n/);
    assert.doesNotMatch(noopArm, /gh issue comment/);
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
