import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DRIVER_LABEL, LOG_STEPS, PR_MARKER, SCENARIO_MARKERS } from "../drive-issue.mjs";
import { FACTORY_PLAN_MARKER } from "../lib/factory-bundle.mjs";

// The /drive-issue skill (ADR-0090) points the session at named sections of
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
