import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePlanSize } from "../lib/factory-bundle.mjs";

// The plan size estimate (ADR-0083). PRs adding 1,500+ lines cost ~4× more and
// nothing at plan time flagged them, so every plan carries a size estimate and
// a marker bash reads to label the card. A large plan proposes a split, as
// advice: the planner never files issues. The operator files the sub-cards by
// hand, or comments `/split` and the factory files them (ADR-0104).

const promptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "factory-plan-prompt.md");
const prompt = readFileSync(promptPath, "utf8");
const flat = prompt.replace(/\s+/g, " ");

const between = (from, to) => {
  const a = prompt.indexOf(from);
  assert.notEqual(a, -1, from);
  const b = prompt.indexOf(to, a + from.length);
  assert.notEqual(b, -1, to);
  return prompt.slice(a, b);
};
const STRUCTURE = between("## Plan structure", "## Browser probe");

describe("planner prompt — Size section and marker", () => {
  it("puts a Size section right after Confidence in the plan template, then Proposed split", () => {
    const conf = STRUCTURE.indexOf("### Confidence");
    const size = STRUCTURE.indexOf("### Size");
    const proposed = STRUCTURE.indexOf("### Proposed split");
    const files = STRUCTURE.indexOf("### Files to touch");
    assert.ok(conf !== -1 && conf < size && size < proposed && proposed < files);
    assert.doesNotMatch(STRUCTURE.slice(conf + 5, size), /\n### /);
  });

  it("asks for a line range, files, platforms and an S/M/L/XL class with fixed bounds", () => {
    assert.match(flat, /added lines as a range/);
    assert.match(flat, /the number of files, the platforms, and a class/);
    assert.match(
      flat,
      /`S` \(under 200 lines\), `M` \(200–699\), `L` \(700–1,499\) or `XL` \(1,500 and up\)/,
    );
  });

  it("documents the marker, which parsePlanSize reads, and has it re-emitted on every replan", () => {
    assert.match(flat, /`<!-- drafto-factory-plan-size:<class>:<estLines> -->`/);
    assert.match(flat, /re-emit it, re-estimated, on every replan, as you do the ack markers/);
    assert.match(flat, /a plain integer inside your range/);
    const example = STRUCTURE.match(/<!-- drafto-factory-plan-size:[A-Z]+:\d+ -->/);
    assert.ok(example);
    assert.deepEqual(parsePlanSize(example[0]), { sizeClass: "L", estLines: 1100 });
    assert.ok(
      STRUCTURE.indexOf(example[0]) > STRUCTURE.indexOf("### Estimated affected platforms"),
    );
  });

  it("counts the churn estimates miss, and asks for estLines near the top of the range (ADR-0103)", () => {
    assert.match(
      flat,
      /count every line the diff will add: code, tests and their fixtures, docs and ADRs, new helpers, migrations, and edits to prompts and the runbook/,
    );
    assert.match(flat, /past factory PRs added 1\.1–2\.4× the top of their plan's range/);
    assert.match(flat, /put `<estLines>` near the top of your range, not its middle/);
  });

  it("says an XL card is held until it is split or carries oversize-approved (ADR-0103)", () => {
    assert.match(
      flat,
      /An `XL` card is held\. When the estimate is at or above the factory's oversize threshold \(1,500 lines by default\), an approved card goes back to Plan Review instead of being implemented, until it is split or the operator adds the `oversize-approved` label/,
    );
    // Telling the planner about the hold mustn't invite a lowered estimate.
    assert.match(flat, /Never lower `<estLines>` to stay under the threshold/);
  });

  it("orders the replan body's tail: size marker, then the ack markers", () => {
    assert.match(
      flat,
      /At the very end of the body \(after "Estimated affected platforms" and the size marker\), append \*\*one ack marker per trigger comment\*\*/,
    );
  });
});

describe("planner prompt — Proposed split is advice only", () => {
  it("asks for 2–4 independently shippable sub-cards from L up, and what the card keeps as-is", () => {
    assert.match(
      flat,
      /Only for class `L` or `XL`\. Advice for the operator: 2–4 sub-cards that can each ship on their own, in merge order/,
    );
    assert.match(
      flat,
      /a title \(`feat: …`\), one line of what, its acceptance criteria and its platforms/,
    );
    assert.match(flat, /\*\*If approved as-is:\*\*/);
  });

  it("tells the planner it never files issues, and that /split has the factory file them", () => {
    assert.match(
      flat,
      /You never file issues\. The operator either files the sub-cards by hand or comments `\/split`, and then the factory files one sub-card per part from this section \(ADR-0104\)/,
    );
    assert.match(flat, /give each part a concrete title/);
    assert.match(
      flat,
      /It is advice only: never file an issue for a part \(`gh issue create` stays refused\)/,
    );
    assert.match(
      flat,
      /reply that a comment of just `\/split` has the factory file the sub-cards from the \*\*Proposed split\*\*, or that the operator can file them by hand/,
    );
    assert.match(flat, /No `gh pr \.\.\.` \/ `gh issue edit` \/ `gh issue create`/);
  });

  it("has no split-on-request contract left: no split action, split dir or split section", () => {
    assert.match(
      prompt,
      /issue=<n> action=<planned\|replanned\|blocked\|noop> plan-comment=<url\|->/,
    );
    assert.doesNotMatch(prompt, /action=split|splitDir|Split on request|Split this card/);
    // The strict directive regex is unchanged.
    assert.match(prompt, /\(`\^issue=\[0-9\]\+ action=\[a-z\]\+ plan-comment=\[\^ \]\+\$`\)/);
  });
});
