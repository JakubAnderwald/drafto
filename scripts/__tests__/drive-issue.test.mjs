import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DRIVER_LABEL,
  PR_MARKER,
  createDriver,
  handbackBlocker,
  labelSwap,
  main,
  planCommentOf,
  preparePlanBody,
  prepareScenarioBody,
  renderLogComment,
  sessionMarker,
} from "../drive-issue.mjs";
import { FACTORY_PLAN_MARKER } from "../lib/factory-bundle.mjs";

// scripts/drive-issue.mjs against a fake GitHub: one issue, its comments, its
// board card and (optionally) its factory PR. `calls` records every gh / git /
// node / project call in order.

const HEAD = "a".repeat(40);

const PLAN = `## Plan for #42

### Approach
Do it.

### Confidence
high — read the code.

### Size
Class **S**, ~50 lines.

### Files to touch
- \`apps/web/x.ts\` (modify)

### Risks
- none

### Parity checklist
- web — x.ts

### Tests
unit

### Estimated affected platforms
web

<!-- drafto-factory-plan-size:S:50 -->`;

function world({
  status = "Ready",
  onBoard = true,
  labels = ["status:ready"],
  state = "OPEN",
  pr = null,
  forkPrs = [],
  prFiles = ["apps/web/src/x.ts"],
  checks = [{ name: "ci", bucket: "pass" }],
  threads = [],
  hostedConfigCode = 0,
  gitHead = HEAD,
  comments = [],
} = {}) {
  const w = {
    issue: {
      number: 42,
      state,
      title: "feat: x",
      url: "https://github.com/JakubAnderwald/drafto/issues/42",
      body: "### What\nx\n\n### Acceptance criteria\ny\n\n### Affected platforms\n- [x] web (`apps/web`)\n\n### Schema changes?\nno\n\n### Out of scope\nz",
      labels: [...labels],
    },
    comments: [...comments],
    card: {
      itemId: onBoard ? "ITEM" : null,
      contentId: "ISSUE_NODE",
      status: onBoard ? status : null,
    },
    pr,
    calls: [],
    nextId: 100,
  };
  const reply = (stdout, code = 0, stderr = "") => ({ code, stdout, stderr });
  const flag = (args, name) => args[args.indexOf(name) + 1];

  async function exec(cmd, args, { stdin } = {}) {
    w.calls.push([cmd, ...args].join(" "));
    if (cmd === "git") return reply(args[0] === "rev-parse" ? `${gitHead}\n` : "");
    if (cmd === "node") {
      if (args[0].endsWith("hosted-config.mjs")) return reply("{}", hostedConfigCode);
      if (args[0].endsWith("check-migration-order.mjs")) return reply("");
      if (args[0].endsWith("migration-approval.mjs")) {
        return reply(
          JSON.stringify({ hash: "feedfacecafebeef", files: ["supabase/migrations/1_x.sql"] }),
        );
      }
    }
    const [a, b] = args;
    if (a === "issue" && b === "view") {
      return reply(
        JSON.stringify({ ...w.issue, labels: w.issue.labels.map((name) => ({ name })) }),
      );
    }
    if (a === "api" && /issues\/42\/comments$/.test(b)) {
      return reply(w.comments.map((c) => JSON.stringify(c)).join("\n"));
    }
    if (a === "api" && args.includes("PATCH")) {
      const id = Number(
        args
          .find((x) => x.includes("/comments/"))
          .split("/")
          .pop(),
      );
      w.comments.find((c) => c.id === id).body = JSON.parse(stdin).body;
      return reply("{}");
    }
    if (a === "api" && b === "graphql") {
      return reply(
        JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } },
        }),
      );
    }
    if (a === "issue" && b === "comment") {
      const id = w.nextId++;
      const url = `${w.issue.url}#issuecomment-${id}`;
      w.comments.push({ id, authorAssociation: "OWNER", body: stdin, createdAt: `t${id}`, url });
      return reply(`${url}\n`);
    }
    if (a === "issue" && b === "edit") {
      args.forEach((x, i) => {
        if (x === "--add-label" && !w.issue.labels.includes(args[i + 1]))
          w.issue.labels.push(args[i + 1]);
        if (x === "--remove-label")
          w.issue.labels = w.issue.labels.filter((l) => l !== args[i + 1]);
      });
      return reply("");
    }
    if (a === "pr" && (b === "list" || b === "view")) {
      const shape = (p) => ({ ...p, labels: (p.labels ?? []).map((name) => ({ name })) });
      const all = [...forkPrs, ...(w.pr ? [w.pr] : [])].map(shape);
      if (b === "list") return reply(JSON.stringify(all));
      return reply(JSON.stringify(all.find((p) => String(p.number) === args[2]) ?? null));
    }
    if (a === "pr" && b === "diff") return reply(prFiles.join("\n"));
    if (a === "pr" && b === "checks")
      return reply(JSON.stringify(checks), checks.every((c) => c.bucket === "pass") ? 0 : 1);
    if (a === "pr" && b === "edit") {
      if (args.includes("--body-file")) w.pr.body = stdin;
      if (args.includes("--add-label"))
        w.pr.labels = [...(w.pr.labels ?? []), flag(args, "--add-label")];
      return reply("");
    }
    throw new Error(`unstubbed: ${cmd} ${args.join(" ")}`);
  }

  const project = {
    resolveProjectId: async () => "PROJECT",
    findItemForIssue: async () => ({ ...w.card }),
    addIssueToProject: async () => {
      w.calls.push("project add");
      w.card.itemId = "ITEM";
      return "ITEM";
    },
    setItemStatusByName: async ({ statusName }) => {
      w.calls.push(`project set-status ${statusName}`);
      w.card.status = statusName;
    },
  };
  w.driver = createDriver({ exec, project, repoRoot: "/repo" });
  return w;
}

const openPr = (over = {}) => ({
  number: 7,
  url: "https://github.com/JakubAnderwald/drafto/pull/7",
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: "factory/issue-42",
  headRefOid: HEAD,
  body: `${PR_MARKER}\n\nCloses #42`,
  labels: [],
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  ...over,
});

const planComment = {
  id: 5,
  authorAssociation: "OWNER",
  body: `${FACTORY_PLAN_MARKER}\n\n${PLAN}`,
  url: "u5",
};

describe("pure helpers", () => {
  it("renders a log entry with the session marker in the drafto-factory family", () => {
    const text = renderLogComment({ step: "tests", body: "all green", key: "abc" });
    assert.match(text, /^🧑‍💻 \*\*Interactive session · Test results\*\*/);
    assert.match(text, /<!-- drafto-factory-session:tests:abc -->\n$/);
    assert.throws(() => renderLogComment({ step: "bogus" }), /unknown log step/);
  });

  it("puts the plan marker first and flags missing sections", () => {
    const ok = preparePlanBody(PLAN);
    assert.ok(ok.body.startsWith(`${FACTORY_PLAN_MARKER}\n\n## Plan for #42`));
    assert.ok(ok.body.trimEnd().endsWith(sessionMarker("plan")));
    assert.deepEqual(ok.missing, []);
    assert.deepEqual(ok.size, { sizeClass: "S", estLines: 50 });
    // Re-preparing a prepared body doesn't stack markers.
    assert.equal(preparePlanBody(ok.body).body, ok.body);
    const bad = preparePlanBody("## Plan\n\n### Approach\nx");
    assert.ok(bad.missing.includes("Risks"));
    assert.ok(bad.missing.some((m) => m.startsWith("plan-size marker")));
  });

  it("finds the plan comment the way the factory does (OWNER, marker first)", () => {
    const quoted = {
      id: 1,
      authorAssociation: "NONE",
      body: `${FACTORY_PLAN_MARKER}\nx`,
      url: "u1",
    };
    const later = {
      id: 2,
      authorAssociation: "OWNER",
      body: `x\n${FACTORY_PLAN_MARKER}`,
      url: "u2",
    };
    assert.equal(planCommentOf([quoted, later]), null);
    assert.equal(planCommentOf([quoted, planComment]).id, 5);
  });

  it("closes a scenario with the factory's markers", () => {
    const text = prepareScenarioBody("### Steps\n1. go\n<!-- drafto-factory-in-test -->", HEAD);
    const lines = text.trimEnd().split("\n");
    assert.deepEqual(lines.slice(-4), [
      "<!-- drafto-factory-in-test -->",
      "<!-- drafto-factory-test-scenario -->",
      `<!-- drafto-factory-scenario-sha:${HEAD} -->`,
      sessionMarker("scenario", HEAD.slice(0, 12)),
    ]);
    assert.equal(text.split("drafto-factory-in-test").length, 2, "no duplicate in-test marker");
    assert.throws(() => prepareScenarioBody("x", "abc"), /40-char/);
  });

  it("swaps only status:* labels", () => {
    assert.deepEqual(labelSwap(["status:ready", "bug", "status:blocked"], "In Progress"), {
      add: "status:in-progress",
      remove: ["status:ready", "status:blocked"],
    });
    assert.deepEqual(labelSwap(["status:ready"], "Backlog"), { add: "", remove: ["status:ready"] });
  });

  it("checks handback preconditions per column: hard and soft", () => {
    const pr = { state: "OPEN" };
    const none = { hard: "", soft: "" };
    assert.deepEqual(handbackBlocker("Ready", { hasPlan: false, pr: null, issue: 1 }), none);
    assert.match(handbackBlocker("Planning", { issue: 1 }).hard, /transient/);
    assert.match(handbackBlocker("Nope", { issue: 1 }).hard, /unknown column/);
    assert.match(handbackBlocker(null, { issue: 1 }).hard, /can't be read/);
    assert.match(handbackBlocker("In Progress", { hasPlan: false, issue: 1 }).soft, /plan comment/);
    assert.deepEqual(handbackBlocker("In Progress", { hasPlan: true, pr: null, issue: 1 }), none);
    assert.match(
      handbackBlocker("In Review", { hasPlan: true, pr: null, issue: 1 }).soft,
      /open PR on factory\/issue-1/,
    );
    assert.deepEqual(handbackBlocker("Approved", { hasPlan: true, pr, issue: 1 }), none);
  });

  it("keeps the factory's ack markers across a session replan, and adds --ack ones", () => {
    const prior = `${FACTORY_PLAN_MARKER}\n\nold plan\n<!-- drafto-factory-replan-ack:123 -->\n<!-- drafto-factory-plan-probe-ack:9-1700 -->`;
    const out = preparePlanBody(PLAN, { priorBody: prior, ack: ["456"] });
    for (const m of [
      "<!-- drafto-factory-replan-ack:123 -->",
      "<!-- drafto-factory-plan-probe-ack:9-1700 -->",
      "<!-- drafto-factory-replan-ack:456 -->",
    ]) {
      assert.equal(out.body.split(m).length, 2, `exactly one ${m}`);
    }
    assert.ok(
      out.body.indexOf("replan-ack:123") > out.body.indexOf("plan-size"),
      "acks after the plan",
    );
    assert.ok(out.body.trimEnd().endsWith(sessionMarker("plan")));
    assert.equal(preparePlanBody(out.body, { priorBody: out.body }).body, out.body, "stable");
    assert.throws(() => preparePlanBody(PLAN, { ack: ["abc"] }), /comment ids/);
  });
});

describe("claim", () => {
  it("labels the card, then logs the claim", async () => {
    const w = world();
    const r = await w.driver.claim(42);
    assert.equal(r.already, false);
    assert.equal(r.branch, "factory/issue-42");
    assert.ok(w.issue.labels.includes(DRIVER_LABEL));
    assert.equal(w.comments.length, 1);
    assert.match(w.comments[0].body, /<!-- drafto-factory-session:claim -->/);
    assert.match(w.comments[0].body, /factory skips it while `driver:interactive` is on/);
  });

  it("refuses a card a factory run may hold, unless forced", async () => {
    for (const status of ["Planning", "In Progress", "In Review", "Testing", "Approved"]) {
      const w = world({ status });
      await assert.rejects(w.driver.claim(42), /a factory run may be live/);
      assert.ok(!w.issue.labels.includes(DRIVER_LABEL), "nothing changes on a refusal");
      assert.equal(w.comments.length, 0);
    }
    const w = world({ status: "In Progress" });
    await w.driver.claim(42, { force: true });
    assert.ok(w.issue.labels.includes(DRIVER_LABEL));
  });

  it("adds a card that isn't on the board to Ready, after the label", async () => {
    const w = world({ onBoard: false, labels: [] });
    const r = await w.driver.claim(42);
    assert.equal(r.addedToBoard, true);
    assert.equal(w.card.status, "Ready");
    assert.ok(w.issue.labels.includes("status:ready"));
    const labelAt = w.calls.findIndex((c) => c.includes(`--add-label ${DRIVER_LABEL}`));
    const addAt = w.calls.indexOf("project add");
    assert.ok(labelAt !== -1 && labelAt < addAt, "label before the card reaches the board");
  });

  it("refuses a card another session claimed, unless resuming", async () => {
    const earlier = {
      id: 3,
      authorAssociation: "OWNER",
      body: sessionMarker("claim"),
      createdAt: "2026-11-20T10:00:00Z",
      url: "u3",
    };
    const w = world({ labels: [DRIVER_LABEL], comments: [earlier] });
    await assert.rejects(w.driver.claim(42), /already claimed.*2026-11-20T10:00:00Z: u3.*--resume/);
    assert.equal(w.comments.length, 1, "a refusal posts nothing");
    const r = await w.driver.claim(42, { resume: true });
    assert.equal(r.already, true);
    assert.match(w.comments.at(-1).body, /Claim resumed/);
  });

  it("refuses a closed issue", async () => {
    await assert.rejects(world({ state: "CLOSED" }).driver.claim(42), /not OPEN/);
  });
});

describe("move and log", () => {
  it("move sets the column, swaps the status label and always logs", async () => {
    const w = world({ labels: [DRIVER_LABEL, "status:ready"] });
    const r = await w.driver.move(42, "Plan Review", { note: "plan posted" });
    assert.deepEqual([r.from, r.to], ["Ready", "Plan Review"]);
    assert.equal(w.card.status, "Plan Review");
    assert.ok(w.issue.labels.includes("status:plan-review"));
    assert.ok(!w.issue.labels.includes("status:ready"));
    assert.match(
      w.comments.at(-1).body,
      /Interactive session · Ready → Plan Review\*\*\n\nplan posted/,
    );
  });

  it("move needs a claim, a note and a real column", async () => {
    await assert.rejects(world().driver.move(42, "In Progress", { note: "x" }), /isn't claimed/);
    const w = world({ labels: [DRIVER_LABEL] });
    await assert.rejects(w.driver.move(42, "In Progress", { note: " " }), /needs --note/);
    await assert.rejects(w.driver.move(42, "Doing", { note: "x" }), /unknown column/);
  });

  it("log with a key posts once; without one, every time", async () => {
    const w = world({ labels: [DRIVER_LABEL] });
    assert.equal(
      (await w.driver.log(42, { step: "tests", body: "ok", key: "abc123" })).posted,
      true,
    );
    assert.equal(
      (await w.driver.log(42, { step: "tests", body: "ok", key: "abc123" })).posted,
      false,
    );
    await w.driver.log(42, { step: "note", body: "a" });
    await w.driver.log(42, { step: "note", body: "a" });
    assert.equal(w.comments.length, 3);
  });

  it("ignores a marker someone else pasted", async () => {
    const pasted = {
      id: 1,
      authorAssociation: "NONE",
      body: sessionMarker("tests", "abc"),
      url: "x",
    };
    const w = world({ labels: [DRIVER_LABEL], comments: [pasted] });
    assert.equal((await w.driver.log(42, { step: "tests", body: "ok", key: "abc" })).posted, true);
  });
});

describe("plan and scenario", () => {
  it("posts the plan, then edits it in place and logs a replan", async () => {
    const w = world({ labels: [DRIVER_LABEL] });
    const first = await w.driver.plan(42, { body: PLAN });
    assert.equal(first.replanned, false);
    assert.ok(w.comments[0].body.startsWith(FACTORY_PLAN_MARKER));
    const second = await w.driver.plan(42, {
      body: PLAN.replace("Do it.", "Do it better."),
      note: "per review",
    });
    assert.equal(second.replanned, true);
    assert.equal(w.comments.length, 2, "one plan comment plus one replan log");
    assert.match(w.comments[0].body, /Do it better\./);
    assert.match(w.comments[1].body, /drafto-factory-session:replan/);
  });

  it("refuses an incomplete plan", async () => {
    const w = world({ labels: [DRIVER_LABEL] });
    await assert.rejects(w.driver.plan(42, { body: "### Approach\nx" }), /the plan is missing/);
  });

  it("posts one scenario per head SHA", async () => {
    const w = world({ labels: [DRIVER_LABEL] });
    assert.equal((await w.driver.scenario(42, { body: "1. a", sha: HEAD })).edited, false);
    assert.equal((await w.driver.scenario(42, { body: "1. b", sha: HEAD })).edited, true);
    assert.equal(w.comments.length, 1);
    assert.match(w.comments[0].body, /1\. b/);
  });
});

describe("gates", () => {
  it("passes a clean PR, in the --release order", async () => {
    const w = world({ labels: [DRIVER_LABEL], pr: openPr() });
    const r = await w.driver.gates(42, { logResult: true });
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    assert.deepEqual(
      r.checks.map((c) => c.name),
      [
        "ready, against main",
        "factory PR marker",
        "migration-approved label",
        "parity",
        "no conflicts",
        "required CI green",
        "up to date with main",
        "review threads resolved",
        "hosted config applied",
      ],
    );
    assert.match(w.comments.at(-1).body, /all gates pass/);
    assert.match(w.comments.at(-1).body, new RegExp(sessionMarker("gates", HEAD.slice(0, 12))));
  });

  it("names every failing gate", async () => {
    const w = world({
      pr: openPr({
        isDraft: true,
        body: "no marker",
        mergeable: "CONFLICTING",
        mergeStateStatus: "BEHIND",
      }),
      prFiles: ["apps/mobile/x.ts", "supabase/migrations/20261101000000_x.sql"],
      checks: [{ name: "ci", bucket: "fail" }],
      threads: [{ isResolved: false }, { isResolved: true }],
      hostedConfigCode: 3,
    });
    const r = await w.driver.gates(42);
    assert.equal(r.ok, false);
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
    assert.deepEqual(failed, [
      "ready, against main",
      "factory PR marker",
      "migration-approved label",
      "parity",
      "no conflicts",
      "required CI green",
      "up to date with main",
      "review threads resolved",
      "hosted config applied",
    ]);
  });

  it("re-hashes approved migration SQL", async () => {
    const files = ["apps/web/x.ts", "supabase/migrations/20261101000000_x.sql"];
    const stale = {
      id: 9,
      authorAssociation: "OWNER",
      body: sessionMarker("migration-approved", "0000000000000000"),
      url: "u9",
    };
    const w = world({
      pr: openPr({ labels: ["migration-approved"] }),
      prFiles: files,
      comments: [stale],
    });
    const r = await w.driver.gates(42);
    const sql = r.checks.find((c) => c.name === "migration SQL unchanged since approval");
    assert.equal(sql.ok, false);
    assert.match(sql.detail, /feedfacecafebeef/);
    assert.ok(r.checks.find((c) => c.name === "migration order").ok);
  });

  it("ignores a fork PR from a branch of the same name", async () => {
    const fork = openPr({ number: 99, isCrossRepository: true });
    const w = world({ labels: [DRIVER_LABEL], forkPrs: [fork] });
    const r = await w.driver.gates(42);
    assert.equal(r.checks[0].name, "open PR");
    await assert.rejects(w.driver.approveMigration(42), /no open PR/);
    await assert.rejects(w.driver.gates(42, { pr: 99 }), /isn't on factory\/issue-42/);
    // With the card's own PR present too, the fork is still skipped.
    const both = world({ labels: [DRIVER_LABEL], forkPrs: [fork], pr: openPr() });
    assert.equal((await both.driver.gates(42)).pr, 7);
  });

  it("fails without an open PR", async () => {
    const r = await world().driver.gates(42);
    assert.equal(r.ok, false);
    assert.equal(r.checks[0].name, "open PR");
  });
});

describe("approve-migration", () => {
  it("labels the PR and logs the SQL hash", async () => {
    const w = world({ labels: [DRIVER_LABEL], pr: openPr() });
    const r = await w.driver.approveMigration(42);
    assert.equal(r.hash, "feedfacecafebeef");
    assert.ok(w.pr.labels.includes("migration-approved"));
    assert.match(
      w.comments.at(-1).body,
      /drafto-factory-session:migration-approved:feedfacecafebeef/,
    );
  });
});

describe("release", () => {
  it("logs the handback, then removes the label", async () => {
    const w = world({
      labels: [DRIVER_LABEL, "status:in-review"],
      status: "In Review",
      pr: openPr({ body: "Closes #42" }),
      comments: [planComment],
    });
    const r = await w.driver.release(42, { to: "Approved", note: "tested on all platforms" });
    assert.equal(r.column, "Approved");
    assert.equal(r.markerAdded, true);
    assert.ok(w.pr.body.startsWith(PR_MARKER), "PR marker added for the factory");
    assert.equal(w.card.status, "Approved");
    assert.ok(!w.issue.labels.includes(DRIVER_LABEL));
    const handback = w.comments.at(-1).body;
    assert.match(handback, /drafto-factory-session:handback/);
    assert.match(handback, /--release runs its merge gates/);
    const unlabelAt = w.calls.findIndex((c) => c.includes(`--remove-label ${DRIVER_LABEL}`));
    const logAt = w.calls.findLastIndex((c) => c.startsWith("gh issue comment"));
    assert.ok(unlabelAt < logAt, "the label comes off before the handback is logged");
  });

  it("checks the current column when --to is left out", async () => {
    const w = world({ labels: [DRIVER_LABEL], status: "In Review", comments: [planComment] });
    await assert.rejects(
      w.driver.release(42, { note: "x" }),
      /can't hand back in In Review: .*open PR/,
    );
    assert.ok(w.issue.labels.includes(DRIVER_LABEL));
    const r = await w.driver.release(42, { note: "x", force: true });
    assert.equal(r.column, "In Review");
  });

  it("never lets --force through an unknown column or Planning, and changes nothing first", async () => {
    for (const to of ["In Reveiw", "Planning"]) {
      const w = world({ labels: [DRIVER_LABEL], pr: openPr({ body: "Closes #42" }) });
      await assert.rejects(w.driver.release(42, { to, note: "x", force: true }), /can't hand back/);
      assert.equal(w.pr.body, "Closes #42", "the PR body is untouched");
      assert.ok(w.issue.labels.includes(DRIVER_LABEL));
    }
  });

  it("refuses a column the card isn't ready for", async () => {
    const w = world({ labels: [DRIVER_LABEL] });
    await assert.rejects(w.driver.release(42, { to: "In Review", note: "x" }), /plan comment/);
    await assert.rejects(world().driver.release(42, { note: "x" }), /isn't claimed/);
    assert.ok(w.issue.labels.includes(DRIVER_LABEL));
  });
});

describe("CLI", () => {
  const stubDriver = (over) => ({
    spec: async () => ({
      issue: 1,
      missing: "What",
      override: "",
      spec: { affectedPlatforms: [] },
    }),
    ...over,
  });

  it("exits 1 when the spec gate fails", async () => {
    const r = await main(["spec", "1"], stubDriver());
    assert.equal(r.code, 1);
    assert.match(r.text, /missing "What"/);
  });

  it("validates its arguments", async () => {
    await assert.rejects(main(["spec", "x"], stubDriver()), /issue number/);
    await assert.rejects(main(["nope", "1"], stubDriver()), /Usage/);
    await assert.rejects(main(["move", "1", "Ready"], stubDriver()), /--note/);
  });
});
