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

// #718: the planner wrote a real answer to the operator's question, but the
// replan contract allowed no comment, so the answer stayed in the log and the
// only trace on the issue was a silently edited plan. The plan body stays
// standalone; the conversation goes in one reply per trigger comment, which
// the planner writes to a file and bash posts with its marker.
describe("factory-plan-prompt replan replies (#718)", () => {
  const section = replanSection(prompt);
  const flatSection = section.replace(/\s+/g, " ");
  const flatPrompt = prompt.replace(/\s+/g, " ");

  it("documents one reply marker per trigger, and the reply directory, in the bundle", () => {
    assert.match(
      prompt,
      /"replyMarkers": \[ \{ "commentId": "111", "marker": "drafto-factory-plan-reply-111" \}, \.\.\. \]/,
    );
    assert.match(prompt, /"replyDir": "<factory>\/logs\/factory\/replies\/issue-<n>"/);
  });

  it("requires one reply file per trigger, posted by bash with the marker", () => {
    assert.match(flatSection, /\*\*Reply to each trigger comment\.\*\*/);
    assert.match(
      flatSection,
      /Write \*\*one reply per entry in `bundle\.replan\.replyMarkers`\*\*/,
    );
    assert.match(flatSection, /to `<bundle\.replan\.replyDir>\/<commentId>\.md`\. Don't post it/);
    assert.match(flatSection, /bash posts each file as its own comment and adds the marker/);
    assert.match(flatSection, /Add no marker or HTML comment/);
    assert.match(flatSection, /Every entry gets a reply, whatever the action/);
    assert.match(
      flatSection,
      /A trigger comment with no entry \(a bare thank-you\) needs no reply/,
    );
    // Bash holds a reply back until the plan acks its comment.
    assert.match(
      flatSection,
      /Bash posts a reply only once the plan acks its comment, or when the card goes to Blocked/,
    );
  });

  it("answers the questions and says what changed, or why not", () => {
    assert.match(flatSection, /Answer every question in the comment directly/);
    assert.match(flatSection, /Say what changed in the plan and why/);
    assert.match(flatSection, /If you didn't follow a suggestion, say why/);
  });

  it("writes no reply for a comment an earlier attempt already answered", () => {
    assert.match(
      flatSection,
      /If a comment from the factory \(`OWNER`\) already carries an entry's marker/,
    );
    assert.match(flatSection, /write no file for it/);
  });

  it("still never posts anything itself on a replan: the PATCH is the only mutation", () => {
    assert.match(
      flatSection,
      /This PATCH is the only GitHub write a replan run makes: your replies \(step 5\) are files that bash posts/,
    );
    assert.match(flatSection, /Never post the plan as a new comment/);
    assert.match(flatPrompt, /\*\*Do NOT use this on replan runs\*\*/);
    assert.match(flatPrompt, /`<bundle\.replan\.replyDir>\/<commentId>\.md` per reply/);
    // Still reply on a noop, so a thank-you or a question with no plan change
    // isn't met with silence.
    assert.match(flatSection, /and still reply \(step 5\)/);
  });
});
