#!/usr/bin/env node
// /split (ADR-0104): the operator comments `/split` on a Plan Review card, and
// the factory files the plan's **Proposed split** as sub-cards. A Claude run
// (scripts/factory-split-prompt.md, no tools at all) expands each part into a
// full issue-form body; everything else is bash and this module. Nothing the
// model writes reaches GitHub until it passes `parseSplitOutput`, and bash then
// runs every body through the same spec gate a Ready card meets
// (spec_missing_section) before it files a single issue.
//
// CLI (called from scripts/factory-agent.sh):
//   bundle                 stdin: {issue: {number, title, body}, planBody}
//                          Prints the splitter's bundle. Exits 3 when the plan
//                          has no Proposed split, so there is nothing to file.
//   parse --file <path>    The splitter's stdout. Prints {"ok":true,"cards":
//                          [{title, body, spec}]} or {"ok":false,"reason"}.
//                          Exits 1 only when the file can't be read.
//   compose --cards-file <path> --index <i> --parent <n> --plan-comment <id>
//           --total <n> [--depends-on <n>]
//                          Prints {title, body}: card <i> with the "Split from"
//                          section and the hidden child marker appended.
//   find-child --parent <n> --plan-comment <id> --index <i>
//                          stdin: a REST issues list. Prints the number of the
//                          OWNER issue that carries card <i>'s marker, or
//                          nothing. Finds a sub-card whose `gh issue create`
//                          reply was lost, so a retry doesn't file it twice.

import { readFileSync } from "node:fs";

import { envelopeBody, parseSpec } from "./factory-bundle.mjs";
import { isMainModule } from "./is-main.mjs";
import { defangMarkers } from "./issue-reply.mjs";

export const SPLIT_MIN = 2;
export const SPLIT_MAX = 4;
export const TITLE_MAX = 120;
export const BODY_MAX = 12_000;

// The issue form's headings (.github/ISSUE_TEMPLATE/factory-feature.yml), in
// its order. Every sub-card body has each one exactly once and no other
// heading: parseSpec splits on any Markdown heading, so a `#### Notes` inside
// Acceptance criteria would cut that section short.
export const SPEC_HEADINGS = Object.freeze([
  "What",
  "Acceptance criteria",
  "Affected platforms",
  "Schema changes?",
  "UI design (if applicable)",
  "Out of scope",
]);

export const SPLIT_BEGIN = "BEGIN DRAFTO SPLIT";
export const SPLIT_END = "END DRAFTO SPLIT";
export const SPLIT_CHILD_PREFIX = "drafto-factory-split-child:";

// Pure: the plan's **Proposed split** section, without its heading, or "" when
// the plan has none. It ends at the next heading or at the plan's hidden
// markers.
export function extractProposedSplit(planBody) {
  if (typeof planBody !== "string") return "";
  const lines = planBody.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{2,4}\s+Proposed split\s*$/i.test(l));
  if (start === -1) return "";
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line) || /^\s*<!--\s*drafto-factory/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

// Pure: the bundle the splitter reads. The spec, the plan and its Proposed
// split are all enveloped: they are data (the spec is a public issue body),
// never instructions.
export function buildSplitBundle({ issue, planBody } = {}) {
  if (!issue || !Number.isInteger(issue.number)) {
    throw new Error("buildSplitBundle: issue.number is required");
  }
  const proposedSplit = extractProposedSplit(planBody);
  return {
    kind: "factory_split",
    parent: { number: issue.number, title: typeof issue.title === "string" ? issue.title : "" },
    spec: parseSpec(issue.body ?? ""),
    specBodyEnveloped: envelopeBody(issue.body ?? "", "issue-body"),
    planEnveloped: envelopeBody(planBody ?? "", "plan"),
    proposedSplitEnveloped: envelopeBody(proposedSplit, "proposed-split"),
    hasProposedSplit: proposedSplit !== "",
    limits: { min: SPLIT_MIN, max: SPLIT_MAX, titleMax: TITLE_MAX, bodyMax: BODY_MAX },
    headings: [...SPEC_HEADINGS],
  };
}

// Neutralise @mentions: GitHub notifies the account a new issue body names,
// and these bodies are filed under the operator's identity from model output.
// An address like a@b.com (a word character before the @) is not a mention and
// stays as it is.
export function defangMentions(text) {
  return String(text ?? "").replace(/(^|[^\w`])@([A-Za-z0-9])/g, "$1@\u200b$2");
}

// One line for a public comment: model text, markers and mentions broken,
// whitespace collapsed, cut at 300 characters.
function oneLine(text) {
  const flat = defangMentions(defangMarkers(String(text ?? "")))
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

// The last BEGIN/END block in the splitter's output, or null. Lines are
// compared trimmed, so a CRLF or an indented sentinel still counts.
function lastBlock(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === SPLIT_END) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  for (let i = end - 1; i >= 0; i--) {
    if (lines[i].trim() === SPLIT_BEGIN) return lines.slice(i + 1, end).join("\n");
  }
  return null;
}

const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;
// parseSpec's own heading test (splitSections in factory-bundle.mjs).
const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/;

function checkBody(body, label) {
  if (typeof body !== "string" || body.trim() === "") return `${label} has no body`;
  if (body.length > BODY_MAX) return `${label}'s body is over ${BODY_MAX} characters`;
  if (/drafto-factory|drafto-support/i.test(body)) {
    return `${label}'s body carries a factory or support marker`;
  }
  if (body.includes("<!--")) return `${label}'s body has an HTML comment`;
  const headings = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(HEADING_RE);
    if (m) headings.push(m[1]);
  }
  for (const h of headings) {
    if (!SPEC_HEADINGS.includes(h))
      return `${label}'s body has a heading the issue form lacks: ${h}`;
  }
  for (const h of SPEC_HEADINGS) {
    const n = headings.filter((x) => x === h).length;
    if (n !== 1) return `${label}'s body needs exactly one "### ${h}" heading (it has ${n})`;
  }
  const order = SPEC_HEADINGS.map((h) => headings.indexOf(h));
  if (order.some((v, i) => i > 0 && v < order[i - 1])) {
    return `${label}'s headings are not in the issue form's order`;
  }
  return null;
}

// Pure: what the splitter printed → the sub-cards bash may file, or the reason
// it may not. The output's last `BEGIN DRAFTO SPLIT` … `END DRAFTO SPLIT` block
// is JSON: an array of 2–4 {title, body}, or {"refused": "<why>"} when the plan
// can't be split. Bodies get their @mentions broken; anything else that is off
// (a marker, an HTML comment, a heading the form lacks, a repeated title) fails
// the whole split, since a public issue can't be unfiled.
export function parseSplitOutput(text) {
  const block = lastBlock(text);
  if (block === null) {
    return { ok: false, reason: `the splitter printed no ${SPLIT_BEGIN} … ${SPLIT_END} block` };
  }
  let data;
  try {
    data = JSON.parse(
      block
        .trim()
        .replace(/^```(?:json)?\s*\n/, "")
        .replace(/\n```\s*$/, ""),
    );
  } catch {
    return { ok: false, reason: "the splitter's block is not valid JSON" };
  }
  if (data && !Array.isArray(data) && typeof data === "object" && "refused" in data) {
    return { ok: false, reason: `the splitter declined: ${oneLine(data.refused) || "no reason"}` };
  }
  if (!Array.isArray(data))
    return { ok: false, reason: "the splitter's block is not a JSON array" };
  if (data.length < SPLIT_MIN || data.length > SPLIT_MAX) {
    return {
      ok: false,
      reason: `the splitter wrote ${data.length} sub-card(s); a split has ${SPLIT_MIN}–${SPLIT_MAX}`,
    };
  }
  const cards = [];
  const seen = new Set();
  for (let i = 0; i < data.length; i++) {
    const label = `sub-card ${i + 1}`;
    const entry = data[i];
    if (!entry || typeof entry !== "object")
      return { ok: false, reason: `${label} is not an object` };
    const title = typeof entry.title === "string" ? entry.title.trim() : "";
    if (title === "" || title.length > TITLE_MAX || CONTROL_RE.test(title)) {
      return { ok: false, reason: `${label} needs a one-line title of 1–${TITLE_MAX} characters` };
    }
    // bash passes it as `--title "$title"`: never let it read as a flag.
    if (!/^[A-Za-z0-9]/.test(title)) {
      return { ok: false, reason: `${label}'s title must start with a letter or a digit` };
    }
    if (/drafto-factory|drafto-support/i.test(title)) {
      return { ok: false, reason: `${label}'s title carries a factory or support marker` };
    }
    const key = title.toLowerCase();
    if (seen.has(key))
      return { ok: false, reason: `two sub-cards have the title "${oneLine(title)}"` };
    seen.add(key);
    const problem = checkBody(entry.body, label);
    if (problem) return { ok: false, reason: problem };
    const body = defangMentions(entry.body.replace(/\r\n/g, "\n").trim());
    cards.push({ title: defangMentions(title), body, spec: parseSpec(body) });
  }
  return { ok: true, cards };
}

export function childMarker(parent, planCommentId, index) {
  return `<!-- ${SPLIT_CHILD_PREFIX}${parent}:${planCommentId}:${index} -->`;
}

// Pure: card <index> (0-based) as bash files it. The "Split from" section is
// a heading of its own, so parseSpec still reads Out of scope as the model
// wrote it; the hidden marker lets find-child recognise the issue later.
export function composeChildBody(card, { parent, planCommentId, index, total, dependsOn }) {
  const lines = [
    card.body.trim(),
    "",
    "### Split from",
    "",
    `Part ${index + 1} of ${total} of #${parent}, filed by the factory when the operator commented \`/split\` on that card's plan.`,
  ];
  if (dependsOn) {
    lines.push(
      "",
      `Depends on #${dependsOn}. This card waits in **Backlog**: drag it to **Ready** once #${dependsOn} has merged, so its plan is written against that code.`,
    );
  } else {
    lines.push("", "This is the first part, so the factory moved it to **Ready**.");
  }
  lines.push("", childMarker(parent, planCommentId, index));
  return lines.join("\n");
}

// Pure: the OWNER issue (not a pull request) that carries card <index>'s
// marker, by number, lowest first; null when there is none. The repo is
// public, so an issue anyone else opened with the marker doesn't count.
export function findChildIssue(issues, { parent, planCommentId, index }) {
  const marker = childMarker(parent, planCommentId, index);
  const hits = (Array.isArray(issues) ? issues : [])
    .filter(
      (it) =>
        it &&
        !it.pull_request &&
        it.author_association === "OWNER" &&
        Number.isInteger(it.number) &&
        typeof it.body === "string" &&
        it.body.split(/\r?\n/).some((l) => l.trim() === marker),
    )
    .map((it) => it.number)
    .sort((a, b) => a - b);
  return hits.length ? hits[0] : null;
}

function flagsOf(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return flags;
}

function posInt(value, name, { zero = false } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < (zero ? 0 : 1) || !/^\d+$/.test(String(value))) {
    throw new Error(`${name} must be a ${zero ? "non-negative" : "positive"} integer`);
  }
  return n;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = flagsOf(rest);
  switch (cmd) {
    case "bundle": {
      const input = JSON.parse(readFileSync(0, "utf8"));
      const bundle = buildSplitBundle(input);
      process.stdout.write(`${JSON.stringify(bundle)}\n`);
      return bundle.hasProposedSplit ? 0 : 3;
    }
    case "parse": {
      if (!flags.file) throw new Error("parse requires --file <path>");
      let text;
      try {
        text = readFileSync(flags.file, "utf8");
      } catch (err) {
        process.stderr.write(`factory-split: can't read ${flags.file}: ${err.message}\n`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify(parseSplitOutput(text))}\n`);
      return 0;
    }
    case "compose": {
      const cards = JSON.parse(readFileSync(flags["cards-file"], "utf8"));
      const index = posInt(flags.index, "--index", { zero: true });
      const card = Array.isArray(cards) ? cards[index] : null;
      if (!card || typeof card.title !== "string" || typeof card.body !== "string") {
        throw new Error(`compose: no card ${index}`);
      }
      const body = composeChildBody(card, {
        parent: posInt(flags.parent, "--parent"),
        planCommentId: posInt(flags["plan-comment"], "--plan-comment"),
        index,
        total: posInt(flags.total, "--total"),
        dependsOn: flags["depends-on"] ? posInt(flags["depends-on"], "--depends-on") : null,
      });
      process.stdout.write(`${JSON.stringify({ title: card.title, body })}\n`);
      return 0;
    }
    case "find-child": {
      const issues = JSON.parse(readFileSync(0, "utf8"));
      const n = findChildIssue(issues, {
        parent: posInt(flags.parent, "--parent"),
        planCommentId: posInt(flags["plan-comment"], "--plan-comment"),
        index: posInt(flags.index, "--index", { zero: true }),
      });
      if (n !== null) process.stdout.write(`${n}\n`);
      return 0;
    }
    default:
      process.stderr.write(
        "usage: factory-split.mjs bundle|parse --file <f>|compose …|find-child …\n",
      );
      return 2;
  }
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ error: err.message })}\n`);
    process.exitCode = 1;
  }
}
