import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Regression test for issue #451 (observation 1). When the operator comments
// on a plan in Plan Review, the factory revises the plan IN PLACE. The old
// prompt told the planner to "Revise minimally … Do NOT rewrite sections the
// operator didn't object to", which produced reviewer-reactive delta prose
// (e.g. "Server-side is the right call here because …"). The implementer reads
// ONLY the plan comment and never sees the thread, so that framing is
// under-specified. The replan section must now ask for a COMPLETE, STANDALONE
// plan with no reviewer-reactive phrasing — while preserving the mechanical
// contract (in-place PATCH, ack markers, directive line) and the anti-churn
// intent.

const promptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "factory-plan-prompt.md");
const prompt = readFileSync(promptPath, "utf8");

// Scope assertions to the Replan section (from its heading to the next "### ").
function replanSection(text) {
  const start = text.indexOf("### Replan");
  assert.notEqual(start, -1, "expected a '### Replan' section in the planner prompt");
  const rest = text.slice(start + "### Replan".length);
  const nextHeading = rest.indexOf("\n### ");
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

describe("factory-plan-prompt replan section (#451)", () => {
  const section = replanSection(prompt);

  it("preserves the mechanical replan contract", () => {
    assert.match(section, /<!-- drafto-factory-plan -->/, "plan marker must still be required");
    assert.match(
      section,
      /bundle\.replan\.planCommentId/,
      "must still PATCH the existing plan comment by id",
    );
    assert.match(
      section,
      /drafto-factory-replan-ack/,
      "ack markers must still be appended so the detector stops re-firing",
    );
    assert.match(
      section,
      /action=replanned/,
      "replanned directive action must still be documented",
    );
  });

  it("asks for a complete, standalone plan (not a minimal delta)", () => {
    assert.match(section, /standalone/i, "replan must request a standalone plan");
    assert.match(
      section,
      /self-contained design/i,
      "replan must require a self-contained design the implementer can follow alone",
    );
    assert.match(
      section,
      /reads ONLY this comment and never sees the thread/i,
      "replan must state the implementer never sees the comment thread",
    );
  });

  it("bans reviewer-reactive phrasing", () => {
    assert.match(
      section,
      /Do NOT mention the feedback, the comment, the operator, or the\s+reviewer/i,
      "replan must forbid referencing the reviewer/feedback in the plan body",
    );
    // Lock the representative banned examples too, so a regression that drops
    // the explicit list (not just the sentence) still fails.
    assert.match(section, /as requested/i, 'replan must ban "as requested" framing');
    assert.match(section, /per your comment/i, 'replan must ban "per your comment" framing');
    assert.match(section, /now uses/i, 'replan must ban "now uses" delta framing');
  });

  it("keeps the anti-churn guardrail", () => {
    assert.match(
      section,
      /keep every\s+already-approved decision/i,
      "replan must still preserve already-approved decisions (no gratuitous churn)",
    );
    assert.match(
      section,
      /Out of scope/,
      "replan must still guard against scope creep past spec/phase",
    );
  });

  it("does not reintroduce the minimal-delta instruction that caused #451", () => {
    assert.doesNotMatch(
      section,
      /Revise minimally/,
      '"Revise minimally" framing must not return — it produced reviewer-reactive delta plans',
    );
    assert.doesNotMatch(
      section,
      /Do NOT rewrite sections the operator/i,
      "the no-rewrite instruction must not return",
    );
  });
});
