import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DRIVER_LABEL, LOG_STEPS, PR_MARKER, SCENARIO_MARKERS } from "../drive-issue.mjs";
import { FACTORY_PLAN_MARKER } from "../lib/factory-bundle.mjs";

// The /drive-issue skill (ADR-0091) points the session at named sections of
// the factory's prompt files instead of copying their standards, so both
// drivers follow one set of rules. This test keeps those pointers live: every
// `scripts/factory-*.md` § <section> the skill cites must exist as a heading
// there, and the markers the CLI writes must be the ones the factory reads.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

const skill = read(".claude/skills/drive-issue/SKILL.md");
const manual = read("docs/features/interactive-driving.md");
const agent = read("scripts/factory-agent.sh");

function headingsOf(file) {
  return new Set(
    read(file)
      .split("\n")
      .map((l) => /^#{2,4}\s+(.+?)\s*$/.exec(l)?.[1])
      .filter(Boolean),
  );
}

// Each citation: the last `scripts/factory-*.md` named on the line before a
// `§ **Section**` (or a plain `§ Section`, ended by punctuation or "and").
function citations(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const re =
      /`(scripts\/factory-[a-z-]+\.md)`|§ \*\*([^*]+)\*\*|§ ([A-Z][A-Za-z ()]*?[A-Za-z)])(?=[,;.]| and |$)/g;
    let file = null;
    for (const m of line.matchAll(re)) {
      if (m[1]) file = m[1];
      else if (file) out.push({ file, section: (m[2] ?? m[3]).trim() });
    }
  }
  return out;
}

describe("/drive-issue skill grounding", () => {
  const cited = citations(skill);

  it("cites the factory prompts at every stage", () => {
    const files = new Set(cited.map((c) => c.file));
    for (const f of [
      "scripts/factory-plan-prompt.md",
      "scripts/factory-prompt.md",
      "scripts/factory-review-prompt.md",
      "scripts/factory-watch-prompt.md",
      "scripts/factory-intest-prompt.md",
      "scripts/factory-verify-prompt.md",
    ]) {
      assert.ok(files.has(f), `the skill should cite ${f}`);
    }
    assert.ok(cited.length >= 12, `expected the skill's section citations, found ${cited.length}`);
  });

  // A citation may use a heading's short name: "Tools" for "Tools
  // (allow-listed; refuse anything else)".
  const hasHeading = (file, section) =>
    [...headingsOf(file)].some((h) => h === section || h.startsWith(`${section} (`));

  for (const { file, section } of citations(skill)) {
    it(`${file} has § ${section}`, () => {
      assert.ok(hasHeading(file, section), `${file} has no "${section}" heading`);
    });
  }

  it("writes the markers the factory reads", () => {
    assert.equal(FACTORY_PLAN_MARKER, "<!-- drafto-factory-plan -->");
    // The PR marker and the scenario markers are spelled out in the factory's
    // own prompts; the CLI must write exactly those.
    assert.ok(read("scripts/factory-prompt.md").includes(PR_MARKER));
    const intest = read("scripts/factory-intest-prompt.md");
    for (const m of SCENARIO_MARKERS) assert.ok(intest.includes(m), m);
    // The session marker stays inside the family the feedback sweeps skip.
    assert.match(agent, /<!-- drafto-factory/);
  });

  it("names the claim label the factory skips", () => {
    assert.ok(agent.includes(`*",${DRIVER_LABEL},"*`));
    assert.ok(skill.includes(DRIVER_LABEL) && manual.includes(DRIVER_LABEL));
  });

  it("lists every log step in the skill and the manual", () => {
    for (const step of Object.keys(LOG_STEPS)) {
      assert.ok(skill.includes(`\`${step}\``), `skill is missing log step \`${step}\``);
      assert.ok(manual.includes(`\`${step}\``), `manual is missing log step \`${step}\``);
    }
  });

  it("stays user-invoked only", () => {
    assert.match(skill, /^disable-model-invocation: true$/m);
  });
});

// Stage 2 step 6 runs the free CodeRabbit CLI review on its own when the PR bot
// skipped the head (issue #911). These pins keep the step on the tool's real
// surface: its subcommands, flags, reason strings and per-card cap.
describe("/drive-issue CodeRabbit gap-fill step", () => {
  const cliSrc = read("scripts/lib/coderabbit-cli.mjs");
  const stateSrc = read("scripts/lib/factory-state.mjs");
  const reviewSrc = read("scripts/lib/coderabbit-review.mjs");
  // Built by concatenation: coderabbit-no-use-credits.test.mjs fails on any
  // file under scripts/ that spells the paid flag out.
  const PAID_FLAG = "--use-" + "credits";
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Every shell invocation of the tool in the skill: the line naming it plus
  // any `\` continuation lines.
  function invocations(sub) {
    const lines = skill.split("\n");
    const out = [];
    lines.forEach((line, i) => {
      if (!line.includes(`coderabbit-cli.mjs ${sub} `)) return;
      let text = line;
      for (let j = i; lines[j].trimEnd().endsWith("\\") && j + 1 < lines.length; j++) {
        text += `\n${lines[j + 1]}`;
      }
      out.push(text);
    });
    return out;
  }

  // The flags USAGE lists for one subcommand.
  function usageFlags(sub) {
    const usage = /const USAGE =([\s\S]*?);/.exec(cliSrc)?.[1] ?? "";
    const segment = new RegExp(`"${sub} ([^|"]*)`).exec(usage)?.[1] ?? "";
    return new Set(segment.match(/--[a-z-]+/g) ?? []);
  }

  it("cites the tool's real coverage and review subcommands", () => {
    for (const sub of ["coverage", "review"]) {
      assert.ok(skill.includes(`coderabbit-cli.mjs ${sub} --pr`), `skill should run \`${sub}\``);
      assert.ok(cliSrc.includes(`case "${sub}":`), `coderabbit-cli.mjs has no \`${sub}\``);
    }
  });

  it("passes only flags the tool's USAGE lists", () => {
    for (const sub of ["coverage", "review"]) {
      const known = usageFlags(sub);
      assert.ok(known.has("--pr"), `USAGE should list ${sub} --pr`);
      const calls = invocations(sub);
      assert.ok(calls.length > 0, `the skill should invoke ${sub}`);
      for (const call of calls) {
        for (const flag of call.match(/--[a-z-]+/g) ?? []) {
          assert.ok(known.has(flag), `\`${sub}\` has no ${flag} flag: ${call}`);
        }
      }
    }
    assert.ok(
      invocations("review").some((c) => c.includes("--state-file")),
      "the review run should share the lane's ledger via --state-file",
    );
  });

  it("never runs the review with the paid flag, and says so", () => {
    for (const call of invocations("review")) {
      assert.ok(!call.includes(PAID_FLAG), `paid flag in: ${call}`);
    }
    assert.match(skill, new RegExp(`[Nn]ever pass \`${esc(PAID_FLAG)}\``));
  });

  it("names only reasons and coverage kinds the tool emits", () => {
    // Reason / coverage tokens, backticked or quoted, in the skill's tables.
    const tokens = new Set(
      [...skill.matchAll(/[`"]((?:cli|bot)-[a-z_-]+|reviewed|head-moved|post-failed)[`"]/g)].map(
        (m) => m[1],
      ),
    );
    for (const must of ["reviewed", "bot-covered", "bot-in-progress", "cli-already-ran"]) {
      assert.ok(tokens.has(must), `the skill's outcome table should name \`${must}\``);
    }
    for (const must of ["cli-budget", "cli-rate_limited", "cli-partial", "cli-empty"]) {
      assert.ok(tokens.has(must), `the skill's outcome table should name \`${must}\``);
    }

    const emitted = (token) => {
      // A literal the tool returns, alone or with a detail after it.
      if (new RegExp(`["\`]${esc(token)}(?=["\`: (])`).test(cliSrc)) return true;
      const rest = /^cli-(.+)$/.exec(token)?.[1];
      if (!rest) return false;
      // `cli-${reservation.reason}`: the ledger refused the manual run.
      if (
        cliSrc.includes("`cli-${reservation.reason}") &&
        new RegExp(`reason: "${esc(rest)}"`).test(stateSrc)
      ) {
        return true;
      }
      // `cli-${outcome}: …`: the vendor run's classified outcome.
      return (
        cliSrc.includes("`cli-${outcome}: ") &&
        new RegExp(`outcome: "${esc(rest)}"`).test(reviewSrc)
      );
    };
    for (const token of tokens) {
      assert.ok(emitted(token), `coderabbit-cli.mjs never reports \`${token}\``);
    }
  });

  it("caps itself at the lane's per-card default", () => {
    const lane = /FACTORY_CR_CLI_MAX_RUNS_PER_CARD, ([0-9]+)\)/.exec(cliSrc)?.[1];
    assert.ok(lane, "coderabbit-cli.mjs should default FACTORY_CR_CLI_MAX_RUNS_PER_CARD");
    assert.match(skill, new RegExp(`at most ${lane} CLI reviews per In Review stint`));
  });

  it("runs the review without asking the operator", () => {
    assert.ok(!skill.includes("offer the operator the free CLI review"));
    assert.match(skill, /Don't ask the operator first/);
  });

  it("describes the step in the manual", () => {
    const inReview = manual.split("\n").find((l) => /^\| In Review\s+\|/.test(l)) ?? "";
    assert.match(inReview, /CodeRabbit CLI review/);
    assert.match(inReview, /without asking/);
    assert.doesNotMatch(inReview, /\boffers?\b/);
    const rule = manual.split("\n").find((l) => /^\| CodeRabbit gap-fill\s+\|/.test(l)) ?? "";
    assert.match(rule, /coderabbit-cli\.mjs review/);
    assert.match(rule, /never a block/);
  });
});
