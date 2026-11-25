import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// factory-agent.sh's side of /split (ADR-0102): the directive, its acks, and
// split_card's write sequence. The real split_* functions run under /bin/bash
// (3.2 on the Mac mini) with `set -euo pipefail`. gh, the board CLI and claude
// are HARD stubs (fixtures/split/stubs.sh): split_card files public issues,
// and without them a unit test would do that on the live repo. state-cli.mjs
// and factory-split.mjs run for real, against temp files.

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentPath = join(scriptsDir, "factory-agent.sh");
const stubsPath = join(scriptsDir, "__tests__", "fixtures", "split", "stubs.sh");
const script = readFileSync(agentPath, "utf8");

const extract = (name) =>
  `eval "$(awk '/^${name}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"`;

const FNS = [
  "support_forward_filter",
  "gate_support_forwards",
  "owner_comments_since",
  "comments_have_marker",
  "spec_missing_section",
  "status_label_for",
  "transition_status",
  "split_directive_jq",
  "split_acked_ids",
  "split_trigger_ids",
  "split_drop_directives",
  "split_dir_for",
  "split_ack_lines",
  "split_abort",
  "split_write_cards",
  "split_file_children",
  "split_link_children",
  "split_park_parent",
  "split_finish",
  "split_card",
];
const ALL_STATUS_LABELS = script.match(/^ALL_STATUS_LABELS="[^"]*"$/m)[0];

const q = (s) => JSON.stringify(s);
const PLAN_ID = 9001;
const PLAN_AT = "2026-11-20T10:00:00Z";
const PLAN = `<!-- drafto-factory-plan -->
## Plan

### Size

Class **XL**, ~1,800 lines.

### Proposed split

1. \`feat: web\` — web part.
2. \`feat: mobile\` — mobile part.
3. \`feat: desktop\` — desktop part.

### Files to touch

- a.ts

<!-- drafto-factory-plan-size:XL:1800 -->`;

function cardBody({ title, schema = "no" }) {
  return [
    "### What",
    "",
    `${title} for users.`,
    "",
    "### Acceptance criteria",
    "",
    "- It works.",
    "",
    "### Affected platforms",
    "",
    "- [x] web (`apps/web`)",
    "- [ ] iOS / Android (`apps/mobile`)",
    "- [ ] macOS (`apps/desktop`)",
    "- [ ] None — factory internals / docs / CI (no app platform)",
    "",
    "### Schema changes?",
    "",
    schema,
    "",
    "### UI design (if applicable)",
    "",
    "_No response_",
    "",
    "### Out of scope",
    "",
    "- The other parts.",
  ].join("\n");
}

const splitOut = (cards) =>
  `Reading the plan.\nBEGIN DRAFTO SPLIT\n${JSON.stringify(cards)}\nEND DRAFTO SPLIT\n`;
const THREE = ["feat: web part", "feat: mobile part", "feat: desktop part"].map((title) => ({
  title,
  body: cardBody({ title }),
}));

const comment = (id, body, { at = "2026-11-21T10:00:00Z", assoc = "OWNER" } = {}) => ({
  id,
  user: { login: assoc === "OWNER" ? "JakubAnderwald" : "someone" },
  body,
  createdAt: at,
  authorAssociation: assoc,
});
const PLAN_COMMENT = comment(PLAN_ID, PLAN, { at: PLAN_AT });
const RECORD = {
  number: 42,
  title: "XL card",
  body: cardBody({ title: "everything" }),
  state: "OPEN",
  labels: ["status:plan-review"],
  createdAt: "2026-11-19T10:00:00Z",
};

function newDir() {
  return mkdtempSync(join(tmpdir(), "factory-split-bash-"));
}

// Run <body> after the extracted functions and the stubs, in <dir>. The env is
// built from scratch: no FACTORY_* knob of the caller's shell leaks in.
function run(dir, body, env = {}) {
  const snippet = `set -euo pipefail
${FNS.map(extract).join("\n")}
T=${q(dir)}
SCRIPT_DIR=${q(scriptsDir)}
REPO_ROOT=${q(dir)}
LOG_FILE=${q(join(dir, "agent.log"))}
STATE_FILE=${q(join(dir, "state.json"))}
SUPPORT_ALLOWLIST="reporter@example.com"
SUPPORT_STATE_FILE=""
DRY_RUN=\${DRY_RUN:-0}
FACTORY_PLAN_EFFORT=xhigh
SPLIT_LABEL=factory-split
${ALL_STATUS_LABELS}
source ${q(stubsPath)}
${body}
`;
  const r = spawnSync("/bin/bash", ["-c", snippet], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: dir, ...env },
  });
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  return { ...r, calls: read("calls"), posted: read("posted"), read };
}

function splitCard(dir, { claudeOut, triggers = '["9100"]', env = {} } = {}) {
  if (claudeOut !== undefined) writeFileSync(join(dir, "claude.out"), claudeOut);
  return run(
    dir,
    `split_card ITEM_42 42 ${q(JSON.stringify(RECORD))} ${q(JSON.stringify(PLAN_COMMENT))} ${q(triggers)}`,
    env,
  );
}

const stateOf = (dir) =>
  JSON.parse(
    spawnSync(
      process.execPath,
      [
        join(scriptsDir, "lib", "state-cli.mjs"),
        "factory:get-issue",
        "42",
        "--state-file",
        join(dir, "state.json"),
      ],
      { encoding: "utf8" },
    ).stdout,
  );

describe("/split directive: split_trigger_ids and split_drop_directives", () => {
  function triggers(comments) {
    const dir = newDir();
    try {
      const r = run(
        dir,
        `split_trigger_ids ${q(JSON.stringify([PLAN_COMMENT, ...comments]))} ${q(PLAN_AT)} 42`,
      );
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("takes an OWNER comment whose whole body is /split, whitespace aside", () => {
    assert.deepEqual(triggers([comment(9100, "/split")]), ["9100"]);
    assert.deepEqual(triggers([comment(9100, "  /split \r\n\n")]), ["9100"]);
  });

  it("ignores anything more, any other author, and a comment older than the plan", () => {
    for (const body of [
      "/split please",
      "> /split",
      "```\n/split\n```",
      "/Split",
      "/split\n/split",
      "split",
    ]) {
      assert.deepEqual(triggers([comment(9100, body)]), [], JSON.stringify(body));
    }
    assert.deepEqual(triggers([comment(9100, "/split", { assoc: "NONE" })]), []);
    assert.deepEqual(triggers([comment(9100, "/split", { assoc: "COLLABORATOR" })]), []);
    assert.deepEqual(triggers([comment(9100, "/split", { at: "2026-11-19T10:00:00Z" })]), []);
  });

  it("an OWNER ack consumes a directive; an ack anyone else posts doesn't", () => {
    const ack = "🏭 **Split into 2 sub-cards.**\n<!-- drafto-factory-split-ack:9100 -->";
    assert.deepEqual(triggers([comment(9100, "/split"), comment(9200, ack)]), []);
    assert.deepEqual(triggers([comment(9100, "/split"), comment(9200, ack, { assoc: "NONE" })]), [
      "9100",
    ]);
    assert.deepEqual(
      triggers([comment(9100, "/split"), comment(9101, "/split"), comment(9200, ack)]),
      ["9101"],
    );
  });

  function drop(comments, ids, mode = "") {
    const dir = newDir();
    try {
      const r = run(
        dir,
        `split_drop_directives ${q(JSON.stringify([PLAN_COMMENT, ...comments]))} ${q(JSON.stringify(ids))} ${mode}`,
      );
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("keeps every directive out of the replan with the knob on", () => {
    const cs = [comment(9100, "/split"), comment(9300, "Please also cover tablets")];
    assert.deepEqual(drop(cs, ["9100", "9300"], "all"), ["9300"]);
  });

  it("with the knob off, an unanswered /split is feedback, an answered one never is", () => {
    const cs = [comment(9100, "/split"), comment(9300, "Please also cover tablets")];
    assert.deepEqual(drop(cs, ["9100", "9300"]), ["9100", "9300"]);
    const acked = [...cs, comment(9400, "<!-- drafto-factory-split-ack:9100 -->")];
    assert.deepEqual(drop(acked, ["9100", "9300"]), ["9300"]);
  });

  it("passes the ids through unchanged when they can't be filtered", () => {
    const dir = newDir();
    try {
      const r = run(dir, `split_drop_directives '[]' 'not json' all`);
      assert.equal(r.stdout.trim(), "not json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("split_card (extracted, real bash, gh/board/claude stubbed)", () => {
  it("files every sub-card, links them, readies the first, then comments and parks the parent", () => {
    const dir = newDir();
    try {
      const r = splitCard(dir, { claudeOut: splitOut(THREE) });
      assert.equal(r.status, 0, r.stderr);
      const c = r.calls;
      // The splitter: plan effort, no tools at all, the pinned model.
      assert.match(
        c,
        /\[claude\] \[-p\] \[<input>\] \[--dangerously-skip-permissions\] \[--effort\] \[xhigh\] \[--no-chrome\] \[--strict-mcp-config\] \[--tools\] \[\] \[--model\] \[opus\[1m\]\] timeout=360/,
      );
      assert.equal((c.match(/\[claude\]/g) || []).length, 1);
      // Three issues, in order, each body checked and composed.
      assert.match(
        c,
        /issue create #1001 title=feat: web part[\s\S]*#1002 title=feat: mobile part[\s\S]*#1003 title=feat: desktop part/,
      );
      const b1 = r.read("body-1001");
      const b2 = r.read("body-1002");
      assert.match(b1, /Part 1 of 3 of #42/);
      assert.match(b1, /\n<!-- drafto-factory-split-child:42:9001:0 -->\n?$/);
      assert.match(b2, /Depends on #1001\./);
      assert.match(r.read("body-1003"), /Depends on #1002\./);
      // Linked as sub-issues by their REST ids.
      for (const n of [1001, 1002, 1003]) {
        assert.match(
          c,
          new RegExp(
            `api POST repos/JakubAnderwald/drafto/issues/42/sub_issues sub_issue_id=${7000000 + n}`,
          ),
        );
      }
      // On the board; only the first moves to Ready.
      assert.match(c, /\[project\] ensure-item --issue 1001/);
      assert.match(c, /\[project\] set-status --item-id ITEM_1001 --status Ready/);
      assert.doesNotMatch(c, /ITEM_1002 --status|ITEM_1003 --status/);
      assert.match(c, /issue edit 1001 --repo JakubAnderwald\/drafto --add-label status:ready/);
      // Parent: label, comment (with the ack), then Backlog without status:*.
      const label = c.indexOf(
        "issue edit 42 --repo JakubAnderwald/drafto --add-label factory-split",
      );
      const posted = c.indexOf("[gh] issue comment 42");
      const ready = c.indexOf("--status Ready");
      const backlog = c.indexOf("set-status --item-id ITEM_42 --status Backlog");
      assert.ok(ready < label && label < posted && posted < backlog, c);
      assert.match(
        c,
        /issue edit 42 --repo JakubAnderwald\/drafto --remove-label status:plan-review\n/,
      );
      assert.match(r.posted, /🏭 \*\*Split into 3 sub-cards\.\*\*/);
      assert.match(
        r.posted,
        /- #1001 \(\*\*Ready\*\*\)\n- #1002 \(\*\*Backlog\*\*\)\n- #1003 \(\*\*Backlog\*\*\)/,
      );
      assert.match(
        r.posted,
        /<!-- drafto-factory-split:9001 -->\n<!-- drafto-factory-split-ack:9100 -->/,
      );
      // The record, and the checked cards kept private.
      assert.equal(stateOf(dir).splitChildren, "9001:3:1001,1002,1003");
      assert.equal(stateOf(dir).lastStatus, "Backlog");
      const cards = join(dir, "logs/factory/split/issue-42/plan-9001.json");
      assert.equal(statSync(cards).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(cards)).mode & 0o777, 0o700);
      assert.deepEqual(
        JSON.parse(readFileSync(cards, "utf8")).map((x) => x.title),
        THREE.map((x) => x.title),
      );
      assert.doesNotMatch(c, /UNEXPECTED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aborts with one acked notice when the splitter's output can't be filed", () => {
    const dir = newDir();
    try {
      const r = splitCard(dir, { claudeOut: "I could not do it." });
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.calls, /issue create|ensure-item|set-status/);
      assert.match(
        r.posted,
        /🏭 \*\*Split not filed\.\*\* The splitter's sub-cards can't be filed: the splitter printed no BEGIN DRAFTO SPLIT/,
      );
      assert.match(r.posted, /<!-- drafto-factory-split-ack:9100 -->/);
      assert.doesNotMatch(r.posted, /drafto-factory-split:9001/);
      assert.ok(!existsSync(join(dir, "logs/factory/split/issue-42/plan-9001.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs every body through the spec gate before filing any", () => {
    const dir = newDir();
    try {
      const cards = [THREE[0], { title: "feat: b", body: cardBody({ title: "b", schema: "" }) }];
      const r = splitCard(dir, { claudeOut: splitOut(cards) });
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.calls, /issue create/);
      assert.match(r.posted, /sub-card 2 fails the spec gate \(missing: Schema changes\?\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("files nothing and runs no splitter when the plan has no Proposed split", () => {
    const dir = newDir();
    try {
      const plan = {
        ...PLAN_COMMENT,
        body: "<!-- drafto-factory-plan -->\n## Plan\n\n### Size\n\nS",
      };
      const r = run(
        dir,
        `split_card ITEM_42 42 ${q(JSON.stringify(RECORD))} ${q(JSON.stringify(plan))} '["9100"]'`,
      );
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.calls, /\[claude\]/);
      assert.match(
        r.posted,
        /The plan has no \*\*Proposed split\*\* section, so there is nothing to file\./,
      );
      assert.match(r.posted, /drafto-factory-split-ack:9100/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aborts on a failed splitter run, but pauses (no notice) on a session limit", () => {
    const dir = newDir();
    try {
      const r = splitCard(dir, { claudeOut: "boom", env: { CLAUDE_RC: "1" } });
      assert.match(r.posted, /The splitter run failed \(exit 1;/);
      const dir2 = newDir();
      try {
        const p = splitCard(dir2, { claudeOut: "", env: { CLAUDE_RC: "1", SESSION_LIMIT: "1" } });
        assert.equal(p.status, 0, p.stderr);
        assert.match(p.calls, /\[pause\]/);
        assert.equal(p.posted, "");
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumes a split that stopped part-way, without a second splitter run or a duplicate", () => {
    const dir = newDir();
    try {
      const first = splitCard(dir, { claudeOut: splitOut(THREE), env: { FAIL_CREATE_AT: "1002" } });
      assert.equal(first.status, 0, first.stderr);
      assert.equal(stateOf(dir).splitChildren, "9001:3:1001");
      assert.equal(first.posted, "", "no comment until every step is done");
      assert.doesNotMatch(first.calls, /sub_issues|ensure-item/);

      writeFileSync(join(dir, "calls"), "");
      const second = splitCard(dir);
      assert.equal(second.status, 0, second.stderr);
      assert.doesNotMatch(second.calls, /\[claude\]/, "the checked cards are reused");
      assert.equal((second.calls.match(/issue create/g) || []).length, 2);
      assert.match(
        second.calls,
        /issue create #1003 title=feat: mobile part[\s\S]*#1004 title=feat: desktop part/,
      );
      assert.match(second.read("body-1003"), /Depends on #1001\./);
      assert.equal(stateOf(dir).splitChildren, "9001:3:1001,1003,1004");
      assert.match(
        second.posted,
        /- #1001 \(\*\*Ready\*\*\)\n- #1003 \(\*\*Backlog\*\*\)\n- #1004/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds a sub-card whose create reply was lost instead of filing it again", () => {
    const dir = newDir();
    try {
      splitCard(dir, { claudeOut: splitOut(THREE), env: { LOSE_REPLY_AT: "1002" } });
      assert.equal(stateOf(dir).splitChildren, "9001:3:1001");
      writeFileSync(join(dir, "calls"), "");
      const second = splitCard(dir);
      assert.match(second.calls, /sub-card 2\/3 is already filed as #1002/);
      assert.equal((second.calls.match(/issue create/g) || []).length, 1);
      assert.equal(stateOf(dir).splitChildren, "9001:3:1001,1002,1003");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("files nothing when it can't check for an earlier create", () => {
    const dir = newDir();
    try {
      const r = splitCard(dir, { claudeOut: splitOut(THREE), env: { FAIL_RECENT: "1" } });
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.calls, /issue create/);
      assert.equal(r.posted, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips links that exist and leaves a first sub-card that has moved on", () => {
    const dir = newDir();
    try {
      writeFileSync(join(dir, "linked"), "1001\n");
      writeFileSync(join(dir, "status-1001"), '"Planning"');
      const r = splitCard(dir, { claudeOut: splitOut(THREE) });
      assert.doesNotMatch(r.calls, /sub_issue_id=7001001/);
      assert.match(r.calls, /sub_issue_id=7001002/);
      assert.doesNotMatch(r.calls, /ITEM_1001 --status Ready/);
      assert.match(r.calls, /sub-card #1001 is already in Planning; leaving it there/);
      assert.match(r.posted, /Split into 3 sub-cards/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the parent in Plan Review until its comment is posted, and finishes on the next tick", () => {
    const dir = newDir();
    try {
      const first = splitCard(dir, { claudeOut: splitOut(THREE), env: { FAIL_COMMENT: "1" } });
      assert.doesNotMatch(first.calls, /ITEM_42 --status Backlog/);
      writeFileSync(join(dir, "calls"), "");
      writeFileSync(join(dir, "posted"), "");
      writeFileSync(join(dir, "status-1001"), '"Ready"');
      const second = splitCard(dir);
      assert.doesNotMatch(second.calls, /\[claude\]|issue create/);
      assert.doesNotMatch(second.calls, /ITEM_1001 --status Ready/);
      assert.match(second.posted, /Split into 3 sub-cards/);
      assert.match(second.calls, /ITEM_42 --status Backlog/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing in a dry run", () => {
    const dir = newDir();
    try {
      const r = splitCard(dir, { claudeOut: splitOut(THREE), env: { DRY_RUN: "1" } });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.calls, /DRY-RUN: would split #42/);
      assert.doesNotMatch(r.calls, /\[claude\]|\[gh\]|\[project\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("factory-agent.sh /split: knob and --plan wiring", () => {
  const block = script.match(/^FACTORY_SPLIT="\$\{FACTORY_SPLIT:-1\}"\n[\s\S]*?^esac\n/m);
  const knob = (env) => {
    assert.ok(block, "FACTORY_SPLIT block not found");
    const r = spawnSync(
      "/bin/bash",
      ["-c", `set -euo pipefail\n${block[0]}\necho "S=$FACTORY_SPLIT"`],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, ...env },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    return r;
  };

  it("defaults FACTORY_SPLIT to 1; 0 turns it off; anything else warns and means 1", () => {
    assert.equal(knob({}).stdout.trim(), "S=1");
    assert.equal(knob({ FACTORY_SPLIT: "0" }).stdout.trim(), "S=0");
    const bad = knob({ FACTORY_SPLIT: "yes" });
    assert.equal(bad.stdout.trim(), "S=1");
    assert.match(bad.stderr, /invalid FACTORY_SPLIT='yes'; defaulting to 1/);
  });

  const REPLAN = script.slice(
    script.indexOf("# ── Plan Review sweep: in-place replan"),
    script.indexOf("# ── --implement mode"),
  );

  it("handles /split before any replan, behind the knob, and moves on to the next card", () => {
    const size = REPLAN.indexOf('plan_size_label "$ISSUE_NUM" "$ITEM_LABELS" "$PLAN_BODY"');
    const gate = REPLAN.indexOf('if [[ "${FACTORY_SPLIT:-1}" -eq 1 ]]; then');
    const trig = REPLAN.indexOf(
      'SPLIT_TRIGGERS=$(split_trigger_ids "$COMMENTS_JSON" "$PLAN_CREATED_AT" "$ISSUE_NUM")',
    );
    const card = REPLAN.indexOf(
      'split_card "$ITEM_ID" "$ISSUE_NUM" "$ISSUE_RECORD" "$PLAN_COMMENT_JSON" "$SPLIT_TRIGGERS"\n        continue',
    );
    const acked = REPLAN.indexOf("ACKED_JSON=$(extract_acked_comment_ids");
    assert.ok(size !== -1 && size < gate && gate < trig && trig < card && card < acked);
    assert.ok(card < REPLAN.indexOf("lib/run-claude.mjs"), "before the replan run");
  });

  it("parks an already-split card back in Backlog instead of replanning it", () => {
    assert.match(
      REPLAN,
      /== \*",\$SPLIT_LABEL,"\* \]\] \\\n\s+&& comments_have_marker "\$COMMENTS_JSON" "drafto-factory-split:\$PLAN_COMMENT_ID"; then\n[^\n]*\n\s+\[\[ "\$DRY_RUN" -eq 1 \]\] \|\| split_park_parent "\$ITEM_ID" "\$ISSUE_NUM"\n\s+continue/,
    );
  });

  it("never feeds a directive to the replanner: all with the knob on, answered ones always", () => {
    assert.match(
      REPLAN,
      /UNACKED_JSON=\$\(unacked_owner_comments [^\n]*\n(?:\s+#[^\n]*\n)*\s+if \[\[ "\$\{FACTORY_SPLIT:-1\}" -eq 1 \]\]; then\n\s+UNACKED_JSON=\$\(split_drop_directives "\$COMMENTS_JSON" "\$UNACKED_JSON" all\)\n\s+else\n\s+UNACKED_JSON=\$\(split_drop_directives "\$COMMENTS_JSON" "\$UNACKED_JSON"\)\n\s+fi/,
    );
  });

  it("keeps the splitter's claude call out of the sweeps (one claude call per sweep)", () => {
    assert.equal((REPLAN.match(/run-claude\.mjs/g) || []).length, 1);
    const fn = script.slice(
      script.indexOf("\nsplit_write_cards() {"),
      script.indexOf("\nsplit_file_children() {"),
    );
    assert.equal((fn.match(/run-claude\.mjs" -p/g) || []).length, 1);
    assert.match(fn, /--tools "" --model "\$\{FACTORY_MODEL:-opus\[1m\]\}"/);
  });
});
