import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
    assert.match(script, /IS_REVISION" -eq 1 \]\]; then\n\s*# The feedback needed no code change/);
  });

  it("advances the feedback high-water mark only after consuming comments", () => {
    // lastFeedbackAt is set in --implement (consume), not in the sweep (detect).
    assert.match(script, /lastFeedbackAt "\$NOW_ISO"/);
  });
});
