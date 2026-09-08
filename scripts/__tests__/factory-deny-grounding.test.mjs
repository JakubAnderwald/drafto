// Tool-deny enforcement for the factory's Claude stages.
//
// Every stage runs `claude --dangerously-skip-permissions`, so until ADR-0034
// the prompts' prose "Refuse:" lists were enforced by model compliance alone.
// `--disallowedTools` composes with that flag and actually removes a tool or
// command prefix. These tests pin two things:
//
//   1. each stage denies what its prompt says it refuses, and
//   2. no stage denies something it demonstrably NEEDS — the failure mode that
//      would brick the pipeline overnight, and the reason the UNSAFE table
//      below exists.
//
// A malformed pattern is silently ignored by the CLI (probed: `Bash(ls:*` with
// an unclosed paren let `ls` run, no error), so the syntax of every pattern is
// validated here rather than trusted.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const agentPath = resolve(HERE, "..", "factory-agent.sh");
const libDir = resolve(HERE, "..", "lib");
const script = readFileSync(agentPath, "utf8");

// Evaluate the deny block out of the real script, with the two variables it
// interpolates stubbed, and print each resolved set.
const denySets = (() => {
  const snippet = `
set -euo pipefail
SCRIPT_DIR=/stub/scripts
REPO_ROOT=/stub
eval "$(sed -n '/^# ── Tool denies/,/^FACTORY_DENY_INTEST="\\$FACTORY_DENY_INTEST,Bash(gh pr review/p' "${agentPath}")"
for v in CORE IMPLEMENT WATCH PLAN INTEST; do
  name="FACTORY_DENY_\${v}"
  printf '%s\\t%s\\n' "\${v}" "\${!name}"
done
`;
  const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
  assert.equal(r.status, 0, `deny block failed to evaluate: ${r.stderr}`);
  const out = {};
  for (const line of r.stdout.trim().split("\n")) {
    const [name, value] = line.split("\t");
    out[name] = (value ?? "").split(",").filter(Boolean);
  }
  return out;
})();

const STAGES = ["IMPLEMENT", "WATCH", "PLAN", "INTEST"];

// Patterns that would remove a capability the stage provably needs. Denying any
// of these is the difference between "hardened" and "the factory stops working
// at 03:00 and nobody knows why".
const UNSAFE = {
  IMPLEMENT: [
    "Bash(git push:*)", // the implementation has to land
    "Bash(git:*)",
    "Bash(gh:*)",
    "Bash(gh pr:*)", // needs pr create / view / edit
    "Bash(gh issue:*)", // posts the blocking comment
    "Bash(pnpm:*)", // the whole verification matrix
    "Bash(curl:*)", // the bundle.screenshots carve-out
    "Bash(mkdir:*)",
    "Bash(gh pr edit:*)", // required by the revision-run instructions
    "Write",
    "Task",
  ],
  WATCH: [
    "Bash(git push:*)",
    "Bash(git:*)",
    "Bash(gh:*)",
    "Bash(gh pr:*)",
    "Bash(gh issue:*)",
    "Bash(pnpm:*)",
    "Bash(curl:*)",
    "Write",
    "Task",
  ],
  // The read-only stages may deny git/pnpm wholesale, but still need to read
  // the repo, fetch screenshots, and post exactly one comment.
  PLAN: [
    "Bash(gh:*)",
    "Bash(gh issue:*)",
    "Bash(curl:*)",
    "Bash(mkdir:*)",
    "Read",
    "Grep",
    "Glob",
    "Write",
  ],
  INTEST: [
    "Bash(gh:*)",
    "Bash(gh issue:*)",
    "Bash(curl:*)",
    "Bash(mkdir:*)",
    "Read",
    "Grep",
    "Glob",
  ],
};

describe("factory tool denies", () => {
  it("passes bash -n", () => {
    const r = spawnSync("bash", ["-n", agentPath], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  it("resolves a non-empty deny set for every stage", () => {
    for (const stage of STAGES) {
      assert.ok(denySets[stage]?.length > 10, `${stage} deny set looks empty: ${denySets[stage]}`);
    }
  });

  it("uses only well-formed patterns (a malformed one is silently ignored)", () => {
    // Bare tool name, or Tool(spec) with balanced parens. The CLI does not
    // report a bad pattern, so a typo here would mean zero enforcement.
    const ok = /^[A-Za-z][A-Za-z0-9_]*(\(.*\))?$/;
    for (const stage of STAGES) {
      for (const pat of denySets[stage]) {
        assert.match(pat, ok, `${stage}: malformed deny pattern ${JSON.stringify(pat)}`);
        const opens = (pat.match(/\(/g) ?? []).length;
        const closes = (pat.match(/\)/g) ?? []).length;
        assert.equal(opens, closes, `${stage}: unbalanced parens in ${JSON.stringify(pat)}`);
      }
    }
  });

  for (const stage of STAGES) {
    it(`never denies something ${stage} needs`, () => {
      for (const unsafe of UNSAFE[stage]) {
        assert.ok(
          !denySets[stage].includes(unsafe),
          `${stage} must not deny ${unsafe} — it needs that capability`,
        );
      }
    });
  }

  it("denies the release and host-control verbs everywhere", () => {
    const required = [
      "Bash(gh pr merge:*)",
      "Bash(gh release create:*)",
      "Bash(gh workflow run:*)",
      "Bash(fastlane:*)",
      "Bash(bundle exec fastlane:*)",
      "Bash(xcodebuild:*)",
      "Bash(launchctl:*)",
      "Bash(claude:*)",
    ];
    for (const stage of STAGES) {
      for (const pat of required) {
        assert.ok(denySets[stage].includes(pat), `${stage} should deny ${pat}`);
      }
    }
  });

  it("denies history-rewriting git verbs on the coding stages only", () => {
    for (const stage of ["IMPLEMENT", "WATCH"]) {
      for (const pat of ["Bash(git push --force:*)", "Bash(git reset:*)", "Bash(git rebase:*)"]) {
        assert.ok(denySets[stage].includes(pat), `${stage} should deny ${pat}`);
      }
    }
    // The read-only stages deny git wholesale instead, which is stricter.
    for (const stage of ["PLAN", "INTEST"]) {
      assert.ok(denySets[stage].includes("Bash(git:*)"), `${stage} should deny git wholesale`);
    }
  });

  it("locks the read-only stages out of the write tools they must not use", () => {
    // factory-intest-prompt.md: "You post one comment; that is your entire
    // write surface." --plan keeps Write for /tmp/factory-replan-body.md.
    assert.ok(denySets.INTEST.includes("Write"));
    assert.ok(denySets.INTEST.includes("Edit"));
    assert.ok(denySets.PLAN.includes("Edit"));
    assert.ok(!denySets.PLAN.includes("Write"), "replan writes /tmp/factory-replan-body.md");
  });

  it("stops an agent from driving the factory's own CLIs", () => {
    // The two that matter most: state-cli would let it reset its own retry
    // budget; factory-project would let it set its own board Status, which is
    // the loop guard the whole pipeline depends on.
    for (const stage of STAGES) {
      assert.ok(denySets[stage].includes("Bash(node scripts/lib/state-cli.mjs:*)"));
      assert.ok(denySets[stage].includes("Bash(node scripts/lib/factory-project.mjs:*)"));
      assert.ok(denySets[stage].includes("Bash(node /stub/scripts/lib/state-cli.mjs:*)"));
    }
  });

  it("covers every dangerous lib CLI, so a new one cannot be forgotten", () => {
    // Allow-by-omission is the cost of enumerating: a NEW CLI added under
    // scripts/lib/ is permitted by default until it is listed here. This turns
    // "someone added one and forgot" into a red CI run.
    const PURE_MODULES = new Set([
      "factory-bundle.mjs",
      "factory-state.mjs",
      "is-main.mjs",
      "parse-flags.mjs",
      "parse-issue-footer.mjs",
      "policy.mjs",
      "run-with-timeout.mjs",
      "session-limit.mjs",
      "state.mjs",
      "zoho-auth.mjs",
    ]);
    const missing = readdirSync(libDir)
      .filter((f) => f.endsWith(".mjs") && !PURE_MODULES.has(f))
      .filter((f) => !denySets.CORE.includes(`Bash(node scripts/lib/${f}:*)`));
    assert.deepEqual(
      missing,
      [],
      `these scripts/lib CLIs are not denied — add them to FACTORY_DENY_CORE ` +
        `or to PURE_MODULES if they have no CLI: ${missing.join(", ")}`,
    );
  });

  it("passes a deny set to every claude invocation", () => {
    const calls = script.match(/run-claude\.mjs[^\n]*--dangerously-skip-permissions[^\n]*/g) ?? [];
    assert.equal(calls.length, 5, "expected the five claude invocations");
    for (const call of calls) {
      assert.match(call, /--disallowedTools "\$FACTORY_DENY_[A-Z]+"/, `no deny set: ${call}`);
    }
  });

  it("logs the deny set so a silently-ignored typo is still auditable", () => {
    const logs = script.match(/log "Tool denies \(/g) ?? [];
    assert.equal(logs.length, 5, "each stage should log the deny set it passed");
  });

  it("never passes --allowedTools, which is inert here", () => {
    // Probed: ignored entirely under --dangerously-skip-permissions, and merely
    // additive without it. Passing it would imply a guarantee it cannot give.
    // Scoped to executable lines — the deny block's comment explains why it is
    // not used, and that mention is not a usage.
    const executable = script
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    assert.doesNotMatch(executable, /--allowedTools/);
  });
});

describe("prompts stay consistent with what is enforced", () => {
  const implement = readFileSync(resolve(HERE, "..", "factory-prompt.md"), "utf8");
  const watch = readFileSync(resolve(HERE, "..", "factory-watch-prompt.md"), "utf8");

  it("offers git restore now that checkout/reset are blocked", () => {
    for (const [name, text] of [
      ["implement", implement],
      ["watch", watch],
    ]) {
      assert.match(text, /git restore/, `${name} prompt should offer git restore`);
    }
  });

  it("lists gh pr edit, which the revision-run instructions require", () => {
    assert.match(implement, /gh pr edit/);
  });
});
