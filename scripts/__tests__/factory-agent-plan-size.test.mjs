import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// factory-agent.sh's side of the plan size estimate (ADR-0083): the
// factory-oversize label kept in step with the size marker in the OWNER plan,
// after a plan run and on every replan-sweep tick. `gh` is a HARD STUB in every
// test here: plan_size_label edits labels, and without the stub a unit test
// would do that on the live repo. plan-size.mjs runs for real.

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentPath = join(scriptsDir, "factory-agent.sh");
const script = readFileSync(agentPath, "utf8");

const extract = (name) =>
  `eval "$(awk '/^${name}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${agentPath}")"`;

const section = (from, to) => {
  const a = script.indexOf(from);
  assert.ok(a !== -1, from);
  const b = script.indexOf(to, a);
  assert.ok(b !== -1, to);
  return script.slice(a, b);
};
const READY = section(
  "# ── Orphaned-Planning rescue sweep",
  "# ── Plan Review sweep: in-place replan",
);
const REPLAN = section("# ── Plan Review sweep: in-place replan", "# ── --implement mode");

describe("plan_size_label (extracted, real bash, gh stubbed)", () => {
  // invocations: [[issue, labelsCsv, body?]]; body given = the replan sweep's
  // every-tick call with the plan it already read, omitted = read the plan
  // from the issue (after a plan run).
  function runLabel({ body, labelExists = true, threshold = 1500, invocations }) {
    const dir = mkdtempSync(join(tmpdir(), "plan-size-bash-"));
    const calls = join(dir, "calls");
    const comments = [
      {
        id: 500,
        authorAssociation: "OWNER",
        createdAt: "2026-11-16T10:00:00Z",
        body: `<!-- drafto-factory-plan -->\n## Plan\n${body}`,
      },
    ];
    try {
      const snippet = `
set -euo pipefail
${extract("plan_comment_jq")}
${extract("extract_plan_comment")}
${extract("fetch_comments_retry")}
${extract("oversize_label_ready")}
${extract("plan_size_label")}
log() { echo "[log] $*"; echo "[log] $*" >>"$LOG_FILE"; }
sleep() { :; }
fetch_issue_comments() { echo "[fetch] $1" >>${JSON.stringify(calls)}; printf '%s' ${JSON.stringify(JSON.stringify(comments))}; }
gh() {
  echo "[gh] $*" >>${JSON.stringify(calls)}
  case "\${1:-} \${2:-}" in
    "api repos/JakubAnderwald/drafto/labels/factory-oversize") ${labelExists ? ":" : "return 1"} ;;
  esac
  return 0
}
SCRIPT_DIR=${JSON.stringify(scriptsDir)}
LOG_FILE=${JSON.stringify(join(dir, "agent.log"))}
DRY_RUN=0
FACTORY_PLAN_OVERSIZE_LINES=${threshold}
OVERSIZE_LABEL=factory-oversize
OVERSIZE_LABEL_READY=""
PLAN_SIZE_LAST=""
${invocations
  .map(([n, csv, b]) =>
    b === undefined
      ? `plan_size_label ${n} ${JSON.stringify(csv)}`
      : `plan_size_label ${n} ${JSON.stringify(csv)} ${JSON.stringify(`<!-- drafto-factory-plan -->\n${b}`)}`,
  )
  .join("\n")}
`;
      const r = spawnSync("/bin/bash", ["-c", snippet], { encoding: "utf8" });
      assert.equal(r.status, 0, `bash failed: ${r.stderr}`);
      return {
        log: r.stdout,
        calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const xl = "<!-- drafto-factory-plan-size:XL:1800 -->";
  const m = "<!-- drafto-factory-plan-size:M:400 -->";

  it("adds the label after a plan run, in its own edit, once the repo is known to have it", () => {
    const out = runLabel({ body: xl, invocations: [[900, "status:plan-review"]] });
    assert.match(out.calls, /\[fetch\] 900/);
    assert.match(
      out.calls,
      /\[gh\] api repos\/JakubAnderwald\/drafto\/labels\/factory-oversize --silent/,
    );
    assert.match(
      out.calls,
      /\[gh\] issue edit 900 --repo JakubAnderwald\/drafto --add-label factory-oversize\n/,
    );
    assert.doesNotMatch(out.calls, /issue view/, "labels come from the board item");
    assert.match(
      out.log,
      /estimates ~1800 added lines \(XL\), at least 1500 → added factory-oversize/,
    );
  });

  it("checks the repo label once per tick", () => {
    const out = runLabel({
      body: xl,
      invocations: [
        [900, ""],
        [901, ""],
      ],
    });
    assert.equal((out.calls.match(/labels\/factory-oversize/g) || []).length, 1);
    assert.equal((out.calls.match(/--add-label factory-oversize/g) || []).length, 2);
  });

  it("leaves a card that already has it alone", () => {
    const out = runLabel({ body: xl, invocations: [[900, "status:planning,factory-oversize"]] });
    assert.doesNotMatch(out.calls, /issue edit|labels\/factory-oversize/);
  });

  it("removes it when a replan's estimate drops below the threshold", () => {
    const out = runLabel({ body: m, invocations: [[900, "factory-oversize"]] });
    assert.match(
      out.calls,
      /\[gh\] issue edit 900 --repo JakubAnderwald\/drafto --remove-label factory-oversize\n/,
    );
    assert.doesNotMatch(runLabel({ body: m, invocations: [[900, ""]] }).calls, /issue edit/);
  });

  it("syncs on every tick from the plan body it is handed, without reading the issue again", () => {
    const out = runLabel({ body: "unused", invocations: [[900, "", `## Plan\n${xl}`]] });
    assert.doesNotMatch(out.calls, /\[fetch\]/);
    assert.match(out.calls, /--add-label factory-oversize/);
  });

  it("remembers its own edit within the tick, so a later call with stale board labels still acts", () => {
    // The every-tick sync adds the label (XL); the replan then drops the
    // estimate (M), and the after-run call still holds the board's old labels.
    const out = runLabel({
      body: m,
      invocations: [
        [900, "", `## Plan\n${xl}`],
        [900, ""],
      ],
    });
    assert.match(out.calls, /--add-label factory-oversize[\s\S]*--remove-label factory-oversize/);
  });

  it("uses the threshold knob, and 0 turns the label off", () => {
    assert.match(
      runLabel({ body: m, threshold: 300, invocations: [[900, ""]] }).calls,
      /--add-label factory-oversize/,
    );
    assert.equal(runLabel({ body: xl, threshold: 0, invocations: [[900, ""]] }).calls, "");
  });

  it("adds nothing when the repo lacks the label, says how to create it, and logs that once", () => {
    const out = runLabel({
      body: xl,
      labelExists: false,
      invocations: [
        [900, ""],
        [901, ""],
      ],
    });
    assert.doesNotMatch(out.calls, /issue edit/);
    assert.equal((out.log.match(/run scripts\/setup-factory-labels\.sh/g) || []).length, 1);
  });

  it("leaves the label alone when the plan has no size marker, and logs that once", () => {
    const out = runLabel({
      body: "no marker",
      invocations: [
        [900, "factory-oversize"],
        [900, "factory-oversize", "## Plan without a marker"],
      ],
    });
    assert.doesNotMatch(out.calls, /issue edit/);
    assert.equal((out.log.match(/the plan has no size marker/g) || []).length, 1);
  });
});

describe("factory-agent.sh plan size: the threshold knob", () => {
  const block = script.match(
    /FACTORY_PLAN_OVERSIZE_LINES="\$\{FACTORY_PLAN_OVERSIZE_LINES:-1500\}"[\s\S]*?OVERSIZE_LABEL="factory-oversize"\n/,
  );
  const run = (env) => {
    assert.ok(block, "knob block");
    const r = spawnSync(
      "/bin/bash",
      ["-c", `set -euo pipefail\n${block[0]}\necho "L=$FACTORY_PLAN_OVERSIZE_LINES"`],
      { encoding: "utf8", env: { PATH: process.env.PATH, ...env } },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };

  it("defaults to 1500 lines; 0 turns the label off", () => {
    assert.equal(run({}), "L=1500");
    assert.equal(run({ FACTORY_PLAN_OVERSIZE_LINES: "0" }), "L=0");
    assert.equal(run({ FACTORY_PLAN_OVERSIZE_LINES: "2500" }), "L=2500");
  });

  it("falls back to the default on a bad value", () => {
    for (const bad of ["1.5k", "-1", "0100", "yes"]) {
      assert.equal(run({ FACTORY_PLAN_OVERSIZE_LINES: bad }), "L=1500", bad);
    }
  });

  it("splits only through /split (ADR-0102), never through the planner's run", () => {
    // ADR-0083 dropped a split the planner wrote out (FACTORY_PLAN_SPLIT, a
    // split dir, action=split). /split is bash's own step instead: a
    // separate, tool-less splitter run, and bash files what it checked.
    assert.doesNotMatch(script, /FACTORY_PLAN_SPLIT|splitDir|plan_split|plan-split\.mjs/);
    assert.match(script, /^split_card\(\) \{/m);
    assert.match(script, /lib\/factory-split\.mjs" bundle/);
  });
});

describe("factory-agent.sh plan size: --plan wiring", () => {
  it("leaves the directive regexes as they were: bash reads only action=", () => {
    const re = /grep -E '\^issue=\[0-9\]\+ action=\[a-z\]\+ plan-comment=\[\^ \]\+\$'/g;
    assert.equal((script.match(re) || []).length, 2);
  });

  it("labels after the case statement of both sweeps, never inside transition_status", () => {
    const ready = READY.indexOf(
      'case "$ACTION" in planned | noop) plan_size_label "$ISSUE_NUM" "$ITEM_LABELS" ;; esac',
    );
    assert.ok(ready !== -1 && ready > READY.lastIndexOf("    esac\n", ready), "Ready: after esac");
    const replan = REPLAN.indexOf(
      'case "$ACTION" in planned | replanned) plan_size_label "$ISSUE_NUM" "$ITEM_LABELS" ;; esac',
    );
    assert.ok(replan !== -1, "replan sweep calls it");
    assert.ok(replan > REPLAN.indexOf('plan_probe_finalize "$ISSUE_NUM" "$ACTION"'));
    assert.ok(replan > REPLAN.lastIndexOf("    esac\n", replan), "replan: after esac");
    const ts = script.match(/^transition_status\(\) \{[\s\S]*?\n\}/m);
    assert.ok(ts);
    assert.doesNotMatch(ts[0], /oversize|plan_size/i);
  });

  it("re-syncs the label on every replan-sweep tick, before a card with no new feedback is skipped", () => {
    const sync = REPLAN.indexOf('plan_size_label "$ISSUE_NUM" "$ITEM_LABELS" "$PLAN_BODY"');
    const skip = REPLAN.indexOf(
      'if [[ "$UNACKED_COUNT" -eq 0 && "$PROBE_FOLD_JSON" == "null" ]]; then',
    );
    assert.ok(sync !== -1 && skip !== -1 && sync < skip);
    assert.ok(sync > REPLAN.indexOf("PLAN_BODY=$(echo"));
  });
});
