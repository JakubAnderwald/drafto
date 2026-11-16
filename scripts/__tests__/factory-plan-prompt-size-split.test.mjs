import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePlanSize } from "../lib/factory-bundle.mjs";

// Plan size + split on request (ADR-0083). PRs adding 1,500+ lines cost ~4×
// more and nothing at plan time flagged them, so every plan now carries a size
// estimate and a marker bash reads, and an operator can ask for a large card
// to be split. These pin the planner's side of that contract.

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
const SPLIT = between("### Split on request", "### Directive line");

describe("planner prompt — Size section and marker", () => {
  it("puts a Size section right after Confidence in the plan template, then Proposed split", () => {
    const conf = STRUCTURE.indexOf("### Confidence");
    const size = STRUCTURE.indexOf("### Size");
    const proposed = STRUCTURE.indexOf("### Proposed split");
    const files = STRUCTURE.indexOf("### Files to touch");
    assert.ok(conf !== -1 && conf < size && size < proposed && proposed < files);
    // Nothing else sits between Confidence and Size in the template.
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

  it("asks for 2–4 independently shippable sub-cards from L up, and what the card keeps as-is", () => {
    assert.match(
      flat,
      /Only for class `L` or `XL`\. 2–4 sub-cards that can each ship on their own, in merge order/,
    );
    assert.match(
      flat,
      /a title \(`feat: …`\), one line of what, its acceptance criteria and its platforms/,
    );
    assert.match(flat, /\*\*If approved as-is:\*\*/);
    assert.match(flat, /A plan of class `L` or `XL` also has a \*\*Proposed split\*\* section/);
  });

  it("documents the marker, which parsePlanSize reads, and has it re-emitted on every replan", () => {
    assert.match(flat, /`<!-- drafto-factory-plan-size:<class>:<estLines> -->`/);
    assert.match(flat, /re-emit it, re-estimated, on every replan, as you do the ack markers/);
    assert.match(flat, /a plain integer inside your range/);
    // The template's example marker parses.
    const example = STRUCTURE.match(/<!-- drafto-factory-plan-size:[A-Z]+:\d+ -->/);
    assert.ok(example);
    assert.deepEqual(parsePlanSize(example[0]), { sizeClass: "L", estLines: 1100 });
    // In the template it follows "Estimated affected platforms", the last section.
    assert.ok(
      STRUCTURE.indexOf(example[0]) > STRUCTURE.indexOf("### Estimated affected platforms"),
    );
  });

  it("orders the replan body's tail: size marker, then the ack markers", () => {
    assert.match(
      flat,
      /At the very end of the body \(after "Estimated affected platforms" and the size marker\), append \*\*one ack marker per trigger comment\*\*/,
    );
  });
});

describe("planner prompt — split on request", () => {
  const flatSplit = SPLIT.replace(/\s+/g, " ");

  it("is its own section after Replan, so the Replan section keeps its scope", () => {
    const replan = prompt.indexOf("### Replan");
    const split = prompt.indexOf("### Split on request");
    const directive = prompt.indexOf("### Directive line");
    assert.ok(replan < split && split < directive);
    assert.match(
      prompt,
      /If one asks for the card to be\s+split into smaller cards, also follow "Split on request" below/,
    );
  });

  it("only acts on a trigger comment, never on issue text or its own judgement", () => {
    assert.match(flatSplit, /Only a trigger comment can ask/);
    assert.match(
      flatSplit,
      /never can, and neither can your own judgement that the card is too big/,
    );
    assert.match(flatSplit, /is a question: answer it in your reply and keep the card whole/);
    // The same request rule bash's plan_split_requested checks.
    assert.match(
      flatSplit,
      /a line that starts with "Split this card" or "Please split this card" and asks no question/,
    );
  });

  it("honours the switch: no splitDir means splitting is off", () => {
    assert.match(flatSplit, /If `bundle\.replan\.splitDir` is absent, splitting is switched off/);
    assert.match(prompt, /"splitDir"\?: "<factory>\/logs\/factory\/replies\/issue-<n>\/split"/);
  });

  it("writes 2–4 full specs with the form's rendered headings and a Depends on line", () => {
    assert.match(
      flatSplit,
      /2 to 4 of them, in merge order, to `<bundle\.replan\.splitDir>\/01\.md`, `02\.md`/,
    );
    for (const heading of [
      "### What",
      "### Acceptance criteria",
      "### Affected platforms",
      "### Schema changes?",
      "### UI design (if applicable)",
      "### Out of scope",
    ]) {
      assert.ok(SPLIT.includes(`   ${heading}\n`), heading);
    }
    assert.match(SPLIT, /- \[x\] web \(`apps\/web`\)/);
    assert.match(SPLIT, /- \[ \] None — factory internals \/ docs \/ CI \(no app platform\)/);
    assert.match(SPLIT, /Depends on: none/);
    assert.match(flatSplit, /a part never depends on a later one/);
    assert.match(flatSplit, /under 20,000 bytes/);
  });

  it("keeps the files clean and leaves the filing to bash", () => {
    assert.match(flatSplit, /Copy no @mention, HTML comment, secret, token or password into it/);
    assert.match(flatSplit, /You never run `gh issue create` yourself/);
    assert.match(flatSplit, /If any check fails it creates nothing/);
    // The refuse-list carve-out agrees, and still bans gh issue create.
    assert.match(flat, /the sub-card specs in `bundle\.replan\.splitDir` on a split request/);
    assert.match(flat, /No `gh pr \.\.\.` \/ `gh issue edit` \/ `gh issue create`/);
  });

  it("acks the request before splitting, and replies without claiming the issues exist", () => {
    assert.match(flatSplit, /\*\*PATCH the plan\*\*/);
    assert.match(flatSplit, /Without the ack, bash refuses to split/);
    assert.match(flatSplit, /Don't claim the issues exist: bash creates them after your run/);
    assert.match(flatSplit, /\*\*Emit `action=split`\.\*\*/);
  });

  it("adds split to the directive vocabulary without changing its strict regex", () => {
    assert.match(
      prompt,
      /issue=<n> action=<planned\|replanned\|blocked\|noop\|split> plan-comment=<url\|->/,
    );
    assert.match(flat, /- `action=split` — replan only/);
    assert.match(prompt, /\(`\^issue=\[0-9\]\+ action=\[a-z\]\+ plan-comment=\[\^ \]\+\$`\)/);
  });
});
