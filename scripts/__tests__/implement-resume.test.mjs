import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MAX_AGE_MIN,
  NO_RESUME_REASONS,
  bodyDigest,
  decideResume,
  resumeStarted,
  taskKey,
  worktreeDigest,
} from "../lib/implement-resume.mjs";

// ADR-0084: a fresh --implement run that hit the wall cap (or stopped with
// action=incomplete) records its session; the next run resumes it only when
// nothing it relied on changed. These pin every reason not to, in order.

const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "lib",
  "implement-resume.mjs",
);

const SESSION = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const HEAD = "a".repeat(40);
const PRE = "b".repeat(40);
const KEY = "plan:111@aaaa|rev:5@bbbb,40@cccc";
const TREE = "d".repeat(64);
const NOW = new Date("2026-11-16T12:00:00Z");

function record(over = {}) {
  return {
    attempts: 1,
    implementResumeSession: SESSION,
    implementResumeHead: HEAD,
    implementResumeTreeDigest: TREE,
    implementResumeKey: KEY,
    implementResumePreHead: PRE,
    implementResumeRunStartedAt: "2026-11-16T10:15:00.000Z",
    implementResumeAt: "2026-11-16T11:00:00.000Z",
    ...over,
  };
}

// Everything safe: the decision is to resume.
function safe(over = {}) {
  return {
    enabled: true,
    record: record(),
    worktree: { path: "/wt", branch: "factory/issue-7", reused: true, fastForwarded: false },
    head: HEAD,
    treeDigest: TREE,
    taskKey: KEY,
    prState: "OPEN",
    transcript: `/projects/-wt/${SESSION}.jsonl`,
    now: NOW,
    maxAgeMin: 360,
    ...over,
  };
}

describe("taskKey", () => {
  const plan = { id: 111, body: "<!-- drafto-factory-plan -->\n## Approach\nDo it." };
  const d = (body) => bodyDigest(body);

  it("pairs each comment id with a digest of its body, revisions sorted and de-duplicated", () => {
    const key = taskKey({
      plan,
      revisions: [
        { id: 40, body: "b" },
        { id: "5", body: "a" },
        { id: 40, body: "b" },
      ],
    });
    assert.equal(
      key,
      `plan:111@${d(plan.body)}|rev:5@${d("a")},40@${d("b")}|issue:${d("")}|phase:`,
    );
    assert.match(d("x"), /^[0-9a-f]{16}$/);
  });

  it("sorts ids numerically, not as strings", () => {
    const key = taskKey({
      plan: { id: "1", body: "" },
      revisions: [
        { id: "3000000001", body: "" },
        { id: "999999999", body: "" },
      ],
    });
    assert.match(key, /\|rev:999999999@[0-9a-f]{16},3000000001@[0-9a-f]{16}\|issue:/);
  });

  // An approved plan edited in place keeps its comment id (#842 review).
  it("changes when the plan or a feedback comment is edited in place, same ids", () => {
    const base = taskKey({ plan, revisions: [{ id: 5, body: "make it blue" }] });
    assert.notEqual(
      taskKey({
        plan: { ...plan, body: plan.body + " Also X." },
        revisions: [{ id: 5, body: "make it blue" }],
      }),
      base,
    );
    assert.notEqual(taskKey({ plan, revisions: [{ id: 5, body: "make it red" }] }), base);
    // Line endings alone don't count as an edit.
    assert.equal(
      taskKey({
        plan: { ...plan, body: plan.body.replace(/\n/g, "\r\n") },
        revisions: [{ id: 5, body: "make it blue" }],
      }),
      base,
    );
  });

  it("has an empty revision list on a first implementation", () => {
    const none = `plan:111@${d(plan.body)}|rev:|issue:${d("")}|phase:`;
    assert.equal(taskKey({ plan }), none);
    assert.equal(taskKey({ plan, revisions: null }), none);
  });

  // #842 review: the issue body is the spec, and every fresh bundle reads it
  // again; a resumed session holds the one it started with.
  it("changes when the issue body (the spec) is edited", () => {
    const issue = { number: 7, title: "feat: x", body: "### What\nA" };
    const base = taskKey({ plan, issue });
    assert.ok(base.endsWith(`|issue:${d(issue.body)}|phase:`));
    assert.notEqual(taskKey({ plan, issue: { ...issue, body: "### What\nB" } }), base);
    // The title isn't part of the spec bash bundles from the body.
    assert.equal(taskKey({ plan, issue: { ...issue, title: "feat: y" } }), base);
  });

  // #842 review: the phase decides what a run may touch; a session started
  // under another FACTORY_PHASE must not be resumed.
  it("names the phase, so a phase change starts a fresh session", () => {
    const b = taskKey({ plan, phase: "B" });
    assert.ok(b.endsWith("|phase:B"));
    assert.notEqual(taskKey({ plan, phase: "C" }), b);
    assert.equal(taskKey({ plan, phase: " B " }), b);
  });

  // #842 review: the factory passes raw GitHub comments ({id, body}); the
  // bundle's approvedPlan spells them commentId / bodyEnveloped.
  it("reads the raw comment shape and the bundle's approvedPlan shape alike", () => {
    const raw = { id: 111, body: "plan text", user: { login: "o" }, authorAssociation: "OWNER" };
    const bundled = { commentId: "111", bodyEnveloped: "plan text", url: "u" };
    assert.equal(taskKey({ plan: bundled }), taskKey({ plan: raw }));
    assert.notEqual(
      taskKey({ plan: { ...raw, body: "plan text, edited" } }),
      taskKey({ plan: raw }),
    );
    assert.equal(
      taskKey({ plan: raw, revisions: [{ commentId: 5, bodyEnveloped: "a" }] }),
      taskKey({ plan: raw, revisions: [{ id: 5, body: "a" }] }),
    );
  });

  it("is empty without a plan id", () => {
    assert.equal(taskKey({ plan: { id: "", body: "x" } }), "");
    assert.equal(taskKey({ plan: { id: null } }), "");
    assert.equal(taskKey({ plan: { id: "null" } }), "");
    assert.equal(taskKey({ plan: null }), "");
    assert.equal(taskKey(), "");
  });
});

function gitRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "implement-resume-wt-"));
  const g = (...args) => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  g("init", "-q");
  g("config", "user.name", "t");
  g("config", "user.email", "t@example.com");
  g("config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  g("add", ".");
  g("commit", "-q", "-m", "base");
  return dir;
}

describe("worktreeDigest", () => {
  it("is stable while nothing changes, and moves with tracked, staged and untracked edits", () => {
    const dir = gitRepo();
    try {
      const clean = worktreeDigest(dir);
      assert.match(clean, /^[0-9a-f]{64}$/);
      assert.equal(worktreeDigest(dir), clean);
      writeFileSync(path.join(dir, "a.txt"), "a2\n");
      const edited = worktreeDigest(dir);
      assert.notEqual(edited, clean);
      // Same path, different content: the diff tells them apart.
      writeFileSync(path.join(dir, "a.txt"), "a3\n");
      assert.notEqual(worktreeDigest(dir), edited);
      writeFileSync(path.join(dir, "a.txt"), "a\n");
      assert.equal(worktreeDigest(dir), clean, "back to HEAD is back to the clean digest");
      writeFileSync(path.join(dir, "new.txt"), "one\n");
      const untracked = worktreeDigest(dir);
      assert.notEqual(untracked, clean);
      // An untracked file's content counts, not only its name.
      writeFileSync(path.join(dir, "new.txt"), "two\n");
      assert.notEqual(worktreeDigest(dir), untracked);
      spawnSync("git", ["-C", dir, "add", "new.txt"]);
      assert.notEqual(worktreeDigest(dir), untracked, "staging changes the status");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #842 review: the index can change while the files on disk don't.
  it("moves when only the staged content changes", () => {
    const dir = gitRepo();
    try {
      writeFileSync(path.join(dir, "a.txt"), "v2\n");
      spawnSync("git", ["-C", dir, "add", "a.txt"]);
      writeFileSync(path.join(dir, "a.txt"), "v3\n");
      const before = worktreeDigest(dir);
      // Stage v3, then put the same v3 back on disk: the working file and the
      // status letters (MM → M_) differ only through the index.
      spawnSync("git", ["-C", dir, "add", "a.txt"]);
      const staged = worktreeDigest(dir);
      assert.notEqual(staged, before);
      // Unstage to v2 again by hand: same file on disk, different index.
      writeFileSync(path.join(dir, "a.txt"), "v2\n");
      spawnSync("git", ["-C", dir, "add", "a.txt"]);
      writeFileSync(path.join(dir, "a.txt"), "v3\n");
      assert.equal(worktreeDigest(dir), before, "same index and files, same digest");
      // Index v4, disk still v3: same status (MM), same working file, same
      // diff against HEAD. Only the staged diff tells this apart.
      writeFileSync(path.join(dir, "a.txt"), "v4\n");
      spawnSync("git", ["-C", dir, "add", "a.txt"]);
      writeFileSync(path.join(dir, "a.txt"), "v3\n");
      assert.notEqual(worktreeDigest(dir), before, "a different index, same files on disk");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores ignored files, and is null outside a git worktree", () => {
    const dir = gitRepo();
    try {
      const clean = worktreeDigest(dir);
      writeFileSync(path.join(dir, "ignored.txt"), "build output\n");
      assert.equal(worktreeDigest(dir), clean);
      const plain = mkdtempSync(path.join(tmpdir(), "implement-resume-plain-"));
      try {
        assert.equal(worktreeDigest(plain), null);
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("decideResume", () => {
  it("resumes when everything is unchanged, with the stopped run's session and PR head", () => {
    assert.deepEqual(decideResume(safe()), { resume: true, sessionId: SESSION, preHead: PRE });
  });

  it("hands back an empty pre-head when the stopped run had no PR", () => {
    const d = decideResume(
      safe({ record: record({ implementResumePreHead: null }), prState: null }),
    );
    assert.deepEqual(d, { resume: true, sessionId: SESSION, preHead: "" });
  });

  // #842 review: on a first implementation the key names no feedback, so a
  // reporter comment posted after the stopped run started must refuse.
  it("resumes past owner comments from before the stopped run started, not after", () => {
    assert.equal(decideResume(safe({ newestOwnerCommentAt: "2026-11-16T10:14:59Z" })).resume, true);
    assert.equal(decideResume(safe({ newestOwnerCommentAt: "2026-11-16T10:15:00Z" })).resume, true);
    assert.equal(decideResume(safe({ newestOwnerCommentAt: "" })).resume, true);
    const d = decideResume(safe({ newestOwnerCommentAt: "2026-11-16T10:15:01Z" }));
    assert.deepEqual(d, {
      resume: false,
      reason: "new-feedback",
      detail: "owner comment at 2026-11-16T10:15:01Z",
    });
  });

  it("resumes with no PR state (the PR isn't open yet) and with an open one", () => {
    assert.equal(decideResume(safe({ prState: "" })).resume, true);
    assert.equal(decideResume(safe({ prState: "OPEN" })).resume, true);
  });

  const matrix = [
    ["off", { enabled: false }],
    ["no-record", { record: null }],
    ["no-record", { record: record({ implementResumeSession: null }) }],
    ["no-record", { record: record({ implementResumeSession: "not-a-uuid" }) }],
    ["stale", { record: record({ implementResumeAt: null }) }],
    ["stale", { record: record({ implementResumeAt: "garbage" }) }],
    ["stale", { record: record({ implementResumeAt: "2026-11-16T05:59:00Z" }) }],
    ["worktree-new", { worktree: { reused: false, created: true, branchReused: true } }],
    ["worktree-new", { worktree: null }],
    ["worktree-moved", { worktree: { reused: true, fastForwarded: true } }],
    [
      "worktree-moved",
      { worktree: { reused: true, fastForwarded: true, leftoversRef: "refs/factory-leftovers/x" } },
    ],
    ["head-moved", { head: "c".repeat(40) }],
    ["head-moved", { head: "" }],
    ["worktree-dirty-changed", { treeDigest: "e".repeat(64) }],
    ["worktree-dirty-changed", { treeDigest: null }],
    ["worktree-dirty-changed", { record: record({ implementResumeTreeDigest: null }) }],
    ["task-changed", { taskKey: "plan:111@aaaa|rev:5@bbbb,40@cccc,41@dddd" }],
    ["task-changed", { taskKey: "plan:111@ffff|rev:5@bbbb,40@cccc" }],
    ["task-changed", { taskKey: "" }],
    ["new-feedback", { newestOwnerCommentAt: "2026-11-16T10:20:00Z" }],
    ["new-feedback", { record: record({ implementResumeRunStartedAt: null }) }],
    ["pr-closed", { prState: "CLOSED" }],
    ["pr-closed", { prState: "MERGED" }],
    ["no-transcript", { transcript: null }],
  ];
  for (const [reason, over] of matrix) {
    it(`does not resume: ${reason} (${JSON.stringify(over).slice(0, 70)})`, () => {
      const d = decideResume(safe(over));
      assert.equal(d.resume, false);
      assert.equal(d.reason, reason);
    });
  }

  it("covers every documented reason, and checks them in the documented order", () => {
    assert.deepEqual(
      [...new Set(matrix.map(([r]) => r))],
      [...NO_RESUME_REASONS],
      "the matrix must exercise every reason, in order",
    );
    // When several things changed, the earliest reason in the list wins.
    const d = decideResume(
      safe({
        worktree: { reused: false },
        head: "c".repeat(40),
        prState: "CLOSED",
        transcript: null,
      }),
    );
    assert.equal(d.reason, "worktree-new");
  });

  it("keeps a record exactly maxAgeMin old, and drops one a minute older", () => {
    const at = (min) => new Date(NOW.getTime() - min * 60_000).toISOString();
    assert.equal(
      decideResume(safe({ record: record({ implementResumeAt: at(360) }) })).resume,
      true,
    );
    const old = decideResume(safe({ record: record({ implementResumeAt: at(361) }) }));
    assert.equal(old.reason, "stale");
    assert.match(old.detail, /recorded 361 min ago \(max 360\)/);
    assert.equal(DEFAULT_MAX_AGE_MIN, 360);
  });

  it("says what moved", () => {
    assert.equal(
      decideResume(safe({ head: "c".repeat(40) })).detail,
      `${"a".repeat(12)} → ${"c".repeat(12)}`,
    );
    assert.equal(
      decideResume(safe({ worktree: { reused: true, leftoversRef: "refs/factory-leftovers/x" } }))
        .detail,
      "leftovers at refs/factory-leftovers/x",
    );
  });
});

function line(obj) {
  return JSON.stringify(obj);
}

describe("resumeStarted", () => {
  const since = "2026-11-16T12:00:00Z";
  const old = line({ type: "assistant", timestamp: "2026-11-16T11:30:00.000Z", message: {} });
  const prompt = line({ type: "user", timestamp: "2026-11-16T12:00:01.000Z", message: {} });

  it("is true once the model answered after the start", () => {
    const answer = line({ type: "assistant", timestamp: "2026-11-16T12:00:05.120Z", message: {} });
    assert.equal(resumeStarted([old, prompt, answer].join("\n"), since), true);
  });

  it("counts a record stamped in the start's own second", () => {
    const answer = line({ type: "assistant", timestamp: "2026-11-16T12:00:00.250Z", message: {} });
    assert.equal(resumeStarted(answer, since), true);
  });

  it("is false when only the killed run's records, the new prompt or an API error are there", () => {
    const apiError = line({
      type: "assistant",
      isApiErrorMessage: true,
      timestamp: "2026-11-16T12:00:02.000Z",
      message: { content: [{ type: "text", text: "API Error: 400 tool_use without tool_result" }] },
    });
    assert.equal(resumeStarted([old, prompt, apiError, "not json", ""].join("\n"), since), false);
    assert.equal(resumeStarted("", since), false);
  });

  it("ignores the assistant records the CLI writes itself", () => {
    const synthetic = line({
      type: "assistant",
      timestamp: "2026-11-16T12:00:03.000Z",
      message: {
        model: "<synthetic>",
        content: [{ type: "text", text: "No response requested." }],
      },
    });
    assert.equal(resumeStarted([old, prompt, synthetic].join("\n"), since), false);
  });

  it("counts as started when <since> can't be read (the attempt is spent, as before)", () => {
    assert.equal(resumeStarted(old, "garbage"), true);
  });
});

describe("CLI", () => {
  function withHome(fn) {
    const home = mkdtempSync(path.join(tmpdir(), "implement-resume-"));
    try {
      return fn(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  function run(args, env = {}) {
    return spawnSync("node", [CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: "", ...env },
    });
  }

  function seedTranscript(home, lines) {
    const dir = path.join(home, ".claude", "projects", "-Volumes-x-worktrees-factory-issue-7");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${SESSION}.jsonl`), lines.join("\n") + "\n");
  }

  it("task-key prints the key bare, from the comments' JSON", () => {
    const r = run([
      "task-key",
      "--plan-comment",
      JSON.stringify({ id: 111, body: "plan", user: { login: "x" } }),
      "--revision-comments",
      JSON.stringify([
        { id: 40, body: "b" },
        { id: 5, body: "a" },
      ]),
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      `plan:111@${bodyDigest("plan")}|rev:5@${bodyDigest("a")},40@${bodyDigest("b")}|issue:${bodyDigest("")}|phase:`,
    );
    const none = run(["task-key", "--plan-comment", JSON.stringify({ id: 1, body: "" })]);
    assert.equal(none.stdout, `plan:1@${bodyDigest("")}|rev:|issue:${bodyDigest("")}|phase:`);
    const issue = run([
      "task-key",
      "--plan-comment",
      JSON.stringify({ id: 1, body: "" }),
      "--issue-record",
      JSON.stringify({ number: 7, body: "spec" }),
    ]);
    assert.equal(issue.stdout, `plan:1@${bodyDigest("")}|rev:|issue:${bodyDigest("spec")}|phase:`);
    const phased = run([
      "task-key",
      "--plan-comment",
      JSON.stringify({ id: 1, body: "" }),
      "--phase",
      "C",
    ]);
    assert.ok(phased.stdout.endsWith("|phase:C"));
  });

  it("worktree-digest prints the digest, and fails outside git", () => {
    const dir = gitRepo();
    try {
      const r = run(["worktree-digest", "--path", dir]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, worktreeDigest(dir));
      const bad = run(["worktree-digest", "--path", path.join(dir, "nope")]);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /could not read the worktree/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const decideArgs = (over = {}) => {
    const o = {
      record: JSON.stringify(record()),
      worktree: JSON.stringify({ reused: true, fastForwarded: false }),
      head: HEAD,
      "tree-digest": TREE,
      "task-key": KEY,
      "pr-state": "OPEN",
      enabled: "1",
      "max-age-min": "360",
      now: NOW.toISOString(),
      ...over,
    };
    return ["decide", ...Object.entries(o).flatMap(([k, v]) => [`--${k}`, v])];
  };

  it("decide resumes when claude has the session's transcript", () => {
    withHome((home) => {
      seedTranscript(home, [line({ type: "user", message: {} })]);
      const r = run(decideArgs(), { HOME: home });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { resume: true, sessionId: SESSION, preHead: PRE });
    });
  });

  it("decide refuses without the transcript, and when switched off", () => {
    withHome((home) => {
      const missing = run(decideArgs(), { HOME: home });
      assert.equal(JSON.parse(missing.stdout).reason, "no-transcript");
      seedTranscript(home, [line({ type: "user", message: {} })]);
      const off = run(decideArgs({ enabled: "0" }), { HOME: home });
      assert.equal(JSON.parse(off.stdout).reason, "off");
    });
  });

  it("decide reads --projects-dir when given", () => {
    withHome((home) => {
      seedTranscript(home, [line({ type: "user", message: {} })]);
      const r = run([...decideArgs(), "--projects-dir", path.join(home, ".claude", "projects")], {
        HOME: "/nonexistent",
      });
      assert.equal(JSON.parse(r.stdout).resume, true);
    });
  });

  it("decide treats a missing record (no state yet) as no-record", () => {
    const r = run(decideArgs({ record: "null" }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).reason, "no-record");
  });

  it("decide fails loudly on bad JSON or a bad clock", () => {
    assert.equal(run(decideArgs({ worktree: "{" })).status, 1);
    const bad = run(decideArgs({ now: "nope" }));
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /invalid --now/);
  });

  it("started reads the session's transcript", () => {
    withHome((home) => {
      seedTranscript(home, [
        line({ type: "assistant", timestamp: "2026-11-16T11:00:00Z", message: {} }),
      ]);
      const no = run(["started", "--session-id", SESSION, "--since", "2026-11-16T12:00:00Z"], {
        HOME: home,
      });
      assert.equal(no.status, 0, no.stderr);
      assert.equal(JSON.parse(no.stdout).started, false);
      seedTranscript(home, [
        line({ type: "assistant", timestamp: "2026-11-16T12:00:09Z", message: {} }),
      ]);
      const yes = run(["started", "--session-id", SESSION, "--since", "2026-11-16T12:00:00Z"], {
        HOME: home,
      });
      assert.equal(JSON.parse(yes.stdout).started, true);
      assert.match(JSON.parse(yes.stdout).transcript, new RegExp(`${SESSION}\\.jsonl$`));
    });
  });

  it("started is false when there is no transcript at all", () => {
    withHome((home) => {
      const r = run(["started", "--session-id", SESSION, "--since", "2026-11-16T12:00:00Z"], {
        HOME: home,
      });
      assert.deepEqual(JSON.parse(r.stdout), { started: false, transcript: null });
    });
  });

  it("rejects a bad session id, a bad --since and an unknown subcommand", () => {
    assert.equal(
      run(["started", "--session-id", "x", "--since", "2026-11-16T12:00:00Z"]).status,
      1,
    );
    assert.equal(run(["started", "--session-id", SESSION, "--since", "x"]).status, 1);
    const r = run(["nope"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown subcommand/);
  });
});
