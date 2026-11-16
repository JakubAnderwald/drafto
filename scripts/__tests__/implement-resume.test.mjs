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
  decideResume,
  resumeStarted,
  taskKey,
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
const KEY = "plan:111|rev:5,40";
const NOW = new Date("2026-11-16T12:00:00Z");

function record(over = {}) {
  return {
    attempts: 1,
    implementResumeSession: SESSION,
    implementResumeHead: HEAD,
    implementResumeKey: KEY,
    implementResumePreHead: PRE,
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
    taskKey: KEY,
    prState: "OPEN",
    transcript: `/projects/-wt/${SESSION}.jsonl`,
    now: NOW,
    maxAgeMin: 360,
    ...over,
  };
}

describe("taskKey", () => {
  it("joins the plan comment id with the sorted, de-duplicated revision ids", () => {
    assert.equal(
      taskKey({ planCommentId: 111, revisionCommentIds: ["40", "5", "40"] }),
      "plan:111|rev:5,40",
    );
  });

  it("sorts ids numerically, not as strings", () => {
    assert.equal(
      taskKey({ planCommentId: "1", revisionCommentIds: ["3000000001", "999999999"] }),
      "plan:1|rev:999999999,3000000001",
    );
  });

  it("takes the comma-separated form the CLI passes, and an empty one", () => {
    assert.equal(taskKey({ planCommentId: "9", revisionCommentIds: "7, 3,,7" }), "plan:9|rev:3,7");
    assert.equal(taskKey({ planCommentId: "9", revisionCommentIds: "" }), "plan:9|rev:");
    assert.equal(taskKey({ planCommentId: "9" }), "plan:9|rev:");
  });

  it("is empty without a plan id", () => {
    assert.equal(taskKey({ planCommentId: "" }), "");
    assert.equal(taskKey({ planCommentId: null }), "");
    assert.equal(taskKey({ planCommentId: "null" }), "");
    assert.equal(taskKey(), "");
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
    ["task-changed", { taskKey: "plan:111|rev:5,40,41" }],
    ["task-changed", { taskKey: "plan:112|rev:5,40" }],
    ["task-changed", { taskKey: "" }],
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

  it("task-key prints the key bare", () => {
    const r = run(["task-key", "--plan-id", "111", "--rev-ids", "40,5"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "plan:111|rev:5,40");
  });

  const decideArgs = (over = {}) => {
    const o = {
      record: JSON.stringify(record()),
      worktree: JSON.stringify({ reused: true, fastForwarded: false }),
      head: HEAD,
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
