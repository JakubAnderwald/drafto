import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// #718: the operator asked a question on a plan in Plan Review. The factory
// replanned, folded its answer into the silently edited plan, and the reply
// the planner wrote went only to the log, so the question looked ignored. Now
// every trigger comment gets its own reply: the planner writes it to a file,
// bash posts it with drafto-factory-plan-reply-<id> appended and posts a
// fallback for a handled comment left without one (plan_reply_check), and the
// factory's own replies, posted under the operator's identity, never read as
// new feedback (unacked_owner_comments).

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentPath = join(scriptsDir, "factory-agent.sh");
const script = readFileSync(agentPath, "utf8");

const extract = (name) =>
  `eval "$(awk '/^${name}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"`;

describe("unacked_owner_comments (extracted, real bash)", () => {
  const comments = [
    // The plan itself, then everything after it.
    {
      id: 500,
      body: "<!-- drafto-factory-plan -->",
      createdAt: "2026-10-19T10:00:00Z",
      authorAssociation: "OWNER",
    },
    {
      id: 10,
      body: "Shouldn't trashed notes sit in a common trash?",
      createdAt: "2026-10-19T11:00:00Z",
      authorAssociation: "OWNER",
    },
    {
      id: 11,
      body: "🏭 Answer.\n\n<!-- drafto-factory-plan-reply-10 -->",
      createdAt: "2026-10-19T11:05:00Z",
      authorAssociation: "OWNER",
    },
    {
      id: 12,
      body: "already handled",
      createdAt: "2026-10-19T11:10:00Z",
      authorAssociation: "OWNER",
    },
    { id: 13, body: "drive-by", createdAt: "2026-10-19T11:20:00Z", authorAssociation: "NONE" },
    {
      id: 9,
      body: "before the plan",
      createdAt: "2026-10-19T09:00:00Z",
      authorAssociation: "OWNER",
    },
  ];

  it("skips the factory's own replies, so a reply can't start another replan", () => {
    const r = spawnSync(
      "bash",
      [
        "-c",
        `${extract("unacked_owner_comments")}
unacked_owner_comments ${JSON.stringify(JSON.stringify(comments))} "2026-10-19T10:00:00Z" '["12"]'`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ["10"]);
  });
});

describe("reply_markers_for (extracted, real bash)", () => {
  it("builds one marker per comment that needs an answer, skipping approval noise", () => {
    const comments = [
      { id: 10, body: "Shouldn't trashed notes sit\tin a common trash?\nOr not?" },
      { id: 11, body: "thanks!" },
      { id: 12, body: "LGTM" },
      { id: 13, body: "Why not reuse the hook?" },
      { id: "x", body: "no id" },
    ];
    const r = spawnSync(
      "bash",
      [
        "-c",
        `${extract("reply_markers_for")}
${extract("is_noise_comment")}
reply_markers_for ${JSON.stringify(JSON.stringify(comments))} "drafto-factory-plan-reply-"`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [
      { commentId: "10", marker: "drafto-factory-plan-reply-10" },
      { commentId: "13", marker: "drafto-factory-plan-reply-13" },
    ]);
  });

  it("prints [] for no comments, or for ones it can't parse", () => {
    for (const input of ["[]", "not json"]) {
      const r = spawnSync(
        "bash",
        [
          "-c",
          `${extract("reply_markers_for")}
${extract("is_noise_comment")}
reply_markers_for ${JSON.stringify(input)} "drafto-factory-plan-reply-"`,
        ],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "[]", input);
    }
  });
});

describe("plan_reply_check (extracted, real bash)", () => {
  const plan = (id, ...acked) => ({
    id,
    authorAssociation: "OWNER",
    body: [
      "<!-- drafto-factory-plan -->",
      "## Plan",
      ...acked.map((c) => `<!-- drafto-factory-replan-ack:${c} -->`),
    ].join("\n"),
  });
  const reply = (id, authorAssociation = "OWNER", kind = "plan") => ({
    id: 900 + Number(id),
    authorAssociation,
    body: `🏭 Answer.\n\n<!-- drafto-factory-${kind}-reply-${id} -->`,
  });
  const markersFor = (ids) =>
    ids.map((id) => ({ commentId: id, marker: `drafto-factory-plan-reply-${id}` }));

  // `gh` is a HARD STUB: this posts issue comments, and without the stub a
  // unit test would post to a live issue. It echoes a --body-file - body from
  // stdin so the test can read what was posted. The fetch stub fails its first
  // `failFirst` calls and counts every call; `sleep` is stubbed out, and the
  // reply directory is the test's own.
  function runCheck({
    comments = [],
    ids = ["10"],
    files = {},
    final = "",
    failFirst = 0,
    dryRun = 0,
    twice = false,
  }) {
    const dir = mkdtempSync(join(tmpdir(), "plan-reply-"));
    const fetches = join(dir, "fetches");
    const replies = join(dir, "replies");
    mkdirSync(replies);
    for (const [id, text] of Object.entries(files)) writeFileSync(join(replies, `${id}.md`), text);
    const markers = JSON.stringify(JSON.stringify(markersFor(ids)));
    try {
      const snippet = `
set -euo pipefail
${extract("plan_reply_check")}
${extract("post_issue_replies")}
${extract("fetch_comments_retry")}
${extract("comments_have_marker")}
${extract("extract_acked_comment_ids")}
reply_dir_for() { printf '%s' ${JSON.stringify(replies)}; }
log() { echo "[log] $*"; }
gh() {
  printf '[gh-stub] %s\\n' "$*"
  if [[ "$*" == *"--body-file -"* ]]; then cat; printf '\\n'; fi
  return 0
}
sleep() { :; }
fetch_issue_comments() {
  local n
  n=$(( $(cat ${JSON.stringify(fetches)} 2>/dev/null || echo 0) + 1 ))
  echo "$n" >${JSON.stringify(fetches)}
  if [[ "$n" -le ${failFirst} ]]; then return 1; fi
  printf '%s' ${JSON.stringify(JSON.stringify(comments))}
}
SCRIPT_DIR=${JSON.stringify(scriptsDir)}
DRY_RUN=${dryRun}
LOG_FILE=${JSON.stringify(join(dir, "agent.log"))}
POSTED_REPLY_IDS=" "
plan_reply_check 718 ${markers}
${twice ? `plan_reply_check 718 ${markers} 1` : ""}
${final ? `plan_reply_check 718 ${markers} ${final}` : ""}
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
      const posted = read(join(dir, "agent.log"));
      return {
        log: r.stdout,
        posted,
        posts: (posted.match(/\[gh-stub\] issue comment/g) || []).length,
        fetches: Number(read(fetches) || 0),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("posts each reply for a comment the plan now acks, with the marker appended", () => {
    const out = runCheck({
      comments: [plan(500, "10", "11")],
      ids: ["10", "11"],
      files: { 10: "🏭 First answer.", 11: "🏭 Second answer. <!-- drafto-factory-plan -->" },
    });
    assert.equal(out.posts, 2);
    assert.match(out.posted, /🏭 First answer\.\n\n<!-- drafto-factory-plan-reply-10 -->/);
    assert.match(out.posted, /<!-- drafto-factory-plan-reply-11 -->/);
    // The model's text can't carry a factory marker of its own.
    assert.doesNotMatch(out.posted, /Second answer\. <!-- drafto-factory-plan -->/);
    // Posted just now: no fallback, even though the comment list doesn't show them yet.
    assert.doesNotMatch(out.posted, /No reply was posted/);
  });

  it("holds back a reply whose comment the plan hasn't acked: the edit it describes didn't land", () => {
    const out = runCheck({ comments: [plan(500)], files: { 10: "🏭 I moved X into scope." } });
    assert.equal(out.posts, 0);
  });

  it("doesn't post a reply again when its marker is already on the issue", () => {
    const out = runCheck({ comments: [plan(500, "10"), reply("10")], files: { 10: "🏭 Again." } });
    assert.equal(out.posts, 0);
    assert.match(out.log, /the reply to comment 10 is already posted/);
  });

  it("posts a fallback for an acked comment with no reply, linking the comment and the plan", () => {
    const out = runCheck({ comments: [plan(500, "10", "11"), reply("10")], ids: ["10", "11"] });
    assert.match(
      out.log,
      /no plan reply found for drafto-factory-plan-reply-11; posting the fallback/,
    );
    assert.equal(out.posts, 1);
    assert.match(out.posted, /\[gh-stub\] issue comment 718 --repo JakubAnderwald\/drafto/);
    assert.match(
      out.posted,
      /No reply was posted to \[your comment\]\(https:\/\/github\.com\/JakubAnderwald\/drafto\/issues\/718#issuecomment-11\)/,
    );
    assert.match(
      out.posted,
      /\[the plan\]\(https:\/\/github\.com\/JakubAnderwald\/drafto\/issues\/718#issuecomment-500\), which is current/,
    );
    // The fallback carries the comment's own marker: it counts as answered,
    // and the detector never reads the fallback back as feedback.
    assert.match(out.posted, /<!-- drafto-factory-plan-reply-11 -->/);
  });

  it("reads the acks from a fresh plan comment too (action=planned)", () => {
    const out = runCheck({ comments: [plan(500), plan(600, "10")] });
    assert.equal(out.posts, 1);
    assert.match(out.posted, /\[the plan\]\([^)]*#issuecomment-600\)/);
  });

  it("leaves an unacked comment to the next tick's replan", () => {
    const out = runCheck({ comments: [plan(500)] });
    assert.equal(out.posts, 0);
  });

  it("answers an unacked comment under the Blocked marker when the card leaves Plan Review", () => {
    const out = runCheck({
      comments: [plan(500)],
      files: { 10: "🏭 Can't do this in phase B." },
      final: "1",
    });
    assert.equal(out.posts, 1);
    assert.match(
      out.posted,
      /Can't do this in phase B\.\n\n<!-- drafto-factory-plan-blocked-reply-10 -->/,
    );
    // A later replan of the same comment must still reply: its own marker isn't used up.
    assert.doesNotMatch(out.posted, /drafto-factory-plan-reply-10 -->/);
  });

  it("posts the Blocked fallback when the planner wrote nothing", () => {
    const out = runCheck({ comments: [plan(500)], final: "1" });
    assert.equal(out.posts, 1);
    assert.match(out.posted, /couldn't revise the plan for \[your comment\]/);
    assert.match(out.posted, /The card is in \*\*Blocked\*\*/);
    assert.match(out.posted, /<!-- drafto-factory-plan-blocked-reply-10 -->/);
  });

  it("doesn't post a reply twice when the Blocked check runs after the first one", () => {
    const out = runCheck({
      comments: [plan(500, "10")],
      ids: ["10", "11"],
      files: { 10: "🏭 Done.", 11: "🏭 Can't." },
      twice: true,
    });
    // 10: once (acked, posted by the first call); 11: once, as Blocked.
    assert.equal(out.posts, 2);
    assert.equal((out.posted.match(/drafto-factory-plan-reply-10 -->/g) || []).length, 1);
    assert.match(out.posted, /<!-- drafto-factory-plan-blocked-reply-11 -->/);
  });

  it("doesn't take acks or the plan link from someone else's plan-looking comment", () => {
    const fake = { ...plan(777, "10"), authorAssociation: "NONE" };
    // Unacked by the real plan: the planner's reply is held back.
    const held = runCheck({ comments: [plan(500), fake], files: { 10: "🏭 Answer." } });
    assert.equal(held.posts, 0);
    // And a fallback links the real plan, never the impostor.
    const out = runCheck({ comments: [plan(500, "10"), fake] });
    assert.equal(out.posts, 1);
    assert.match(out.posted, /\[the plan\]\([^)]*#issuecomment-500\)/);
    assert.doesNotMatch(out.posted, /#issuecomment-777/);
  });

  it("doesn't repeat a fallback when the Blocked check runs right after it", () => {
    // The comment list (a stub) never shows the first call's fallback, as when
    // GitHub's listing lags.
    const out = runCheck({ comments: [plan(500, "10")], twice: true });
    assert.equal(out.posts, 1);
    assert.match(out.posted, /No reply was posted to \[your comment\]/);
  });

  it("omits the plan link when there is no plan comment", () => {
    const out = runCheck({ comments: [], final: "1" });
    assert.equal(out.posts, 1);
    assert.match(out.posted, /and the plan is as it was/);
    assert.doesNotMatch(out.posted, /#issuecomment-\)/);
  });

  it("doesn't count a marker in someone else's comment (the repo is public)", () => {
    const out = runCheck({ comments: [plan(500, "10"), reply("10", "NONE")] });
    assert.equal(out.posts, 1);
  });

  it("does not take another comment's reply for this one (reply-100 is not reply-10)", () => {
    const out = runCheck({ comments: [plan(500, "10"), reply("100")] });
    assert.equal(out.posts, 1);
    assert.match(out.posted, /<!-- drafto-factory-plan-reply-10 -->/);
  });

  it("retries a failed comment fetch before deciding", () => {
    const out = runCheck({ comments: [plan(500, "10"), reply("10")], failFirst: 2 });
    assert.equal(out.posts, 0);
    assert.equal(out.fetches, 3);
  });

  it("fails closed when the comments can't be read: the acks are unknown", () => {
    const out = runCheck({ failFirst: 99, files: { 10: "🏭 Answer." } });
    assert.match(
      out.log,
      /WARNING: could not read #718's comments to check the plan replies; skipping/,
    );
    assert.equal(out.posts, 0);
  });

  it("does nothing on a dry run, or with no comment to answer", () => {
    assert.equal(runCheck({ comments: [plan(500, "10")], files: { 10: "x" }, dryRun: 1 }).posts, 0);
    const none = runCheck({ comments: [plan(500, "10")], ids: [] });
    assert.equal(none.posts, 0);
    assert.equal(none.fetches, 0);
  });
});

describe("plan replies: wiring in factory-agent.sh", () => {
  const replan = script.slice(script.indexOf("# ── Plan Review sweep: in-place replan"));

  it("builds the reply markers once, for the bundle and the check", () => {
    assert.match(replan, /PLAN_REPLY_MARKERS=\$\(reply_markers_for \\/);
    assert.match(replan, /--argjson replyMarkers "\$PLAN_REPLY_MARKERS"/);
    assert.match(replan, /replyDir: \$replyDir/);
  });

  it("gives the planner an empty reply directory before the replan run", () => {
    const reset = replan.indexOf('reset_reply_dir "$ISSUE_NUM"\n    POSTED_REPLY_IDS=" "');
    const run = replan.indexOf("Invoking claude for #$ISSUE_NUM (--plan replan");
    assert.ok(reset !== -1 && reset < run, "reset_reply_dir must come right before the run");
  });

  it("checks the replies right after the replan run, before any early exit", () => {
    const call = replan.indexOf('plan_reply_check "$ISSUE_NUM" "$PLAN_REPLY_MARKERS"\n');
    const run = replan.indexOf("lib/run-claude.mjs");
    const timeout = replan.indexOf("if [[ $EXIT_CODE -eq 124 ]]; then");
    assert.ok(call !== -1, "the replan sweep must call plan_reply_check");
    assert.ok(run < call && call < timeout, "between the claude run and the exit-code branches");
  });

  it("answers every comment when the card leaves Plan Review for Blocked", () => {
    assert.match(
      replan,
      /lastError "replanner returned blocked"[\s\S]*?plan_reply_check "\$ISSUE_NUM" "\$PLAN_REPLY_MARKERS" 1\n\s*;;/,
    );
    assert.match(
      replan,
      /replan retry budget exhausted[\s\S]*?transition_status "\$ITEM_ID" "\$ISSUE_NUM" "Blocked" \|\| true\n[^\n]*\n\s*plan_reply_check "\$ISSUE_NUM" "\$PLAN_REPLY_MARKERS" 1/,
    );
  });
});
