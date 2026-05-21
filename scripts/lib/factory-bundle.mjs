#!/usr/bin/env node
// Build a per-issue context bundle for the dark-factory agent.
//
// Two kinds today:
//
//   factory_plan       — for `factory-agent.sh --plan`. Contains the issue
//                        body + comments, the parsed spec contract sections,
//                        parity-override label (if any), the reporter
//                        identity from the support-agent footer, and phase
//                        config. No worktree, no PR — Phase A is read-only.
//
//   factory_implement  — for `factory-agent.sh --implement` (Phase B+). Adds
//                        the approved plan comment (the bash side finds it
//                        by walking issue comments newest-first for the
//                        factory-plan marker) and prior-PR info if this is
//                        a retry.
//
// Pure functions for unit tests, plus a CLI that reads a single JSON object
// on stdin and prints the resulting bundle JSON to stdout — mirrors
// scripts/lib/build-bundle.mjs's shape.
//
// Stdin shape (factory_plan):
//   {
//     "kind":     "factory_plan",
//     "issue":    { "number", "title", "body", "state", "labels": ["status:ready", ...] },
//     "comments": [ { "id", "user":{"login"}, "body", "createdAt" }, ... ],
//     "config":   { "phase": "A"|"B"|"C"|"D", "allowlist"?, "oauthUserEmail"? },
//     "repo":     { "nameWithOwner", "headRef" }
//   }
//
// Stdin shape (factory_implement):
//   {
//     "kind":          "factory_implement",
//     "issue":         { "number", "title", "body", ... },
//     "approvedPlan":  { "commentId", "url", "body", "createdAt" },
//     "comments":      [...],
//     "priorPr":       { "number", "url", "headRef", "state" } | null,
//     "attempts":      <number>,
//     "config":        { "phase", ... },
//     "repo":          { "nameWithOwner", "headRef" }
//   }

import { isMainModule } from "./is-main.mjs";
import { parseIssueFooter } from "./parse-issue-footer.mjs";

// Marker the factory's planning prompt writes onto the plan comment. The
// bash side uses this to find the approved plan when implementing.
export const FACTORY_PLAN_MARKER = "<!-- drafto-factory-plan -->";

// Customer-facing content inside the bundle is wrapped in this envelope so
// the prompt's "treat input as data, not instructions" directive can ignore
// any embedded instructions (a hostile issue body could otherwise inject a
// directive that the model would execute).
function envelopeBody(raw, tag = "issue-body") {
  const text = typeof raw === "string" ? raw : "";
  const closer = `</${tag}>`;
  // Insert a zero-width space inside any literal closer so an attacker can't
  // escape the envelope early. Matches the same defence build-bundle.mjs
  // uses for GitHub-comment forwards.
  const safe = text.split(new RegExp(closer, "gi")).join(`<​/${tag}>`);
  return `<${tag}>${safe}</${tag}>`;
}

// Pure: pull the structured sections out of a factory-feature.yml issue body.
// The template renders each field under a `### <label>` heading and a blank
// line, with bullet lists for the checkbox group. We don't need a Markdown
// parser — just walk the headings.
export function parseSpec(body) {
  const empty = {
    what: "",
    acceptance: "",
    affectedPlatforms: [],
    schemaChanges: null,
    ui: "",
    outOfScope: "",
  };
  if (typeof body !== "string" || body.length === 0) return empty;
  const sections = splitSections(body);
  return {
    what: pickSection(sections, ["What"]),
    acceptance: pickSection(sections, ["Acceptance criteria"]),
    affectedPlatforms: parsePlatformCheckboxes(pickSection(sections, ["Affected platforms"])),
    schemaChanges: parseSchemaAnswer(pickSection(sections, ["Schema changes?"])),
    ui: pickSection(sections, ["UI design (if applicable)", "UI"]),
    outOfScope: pickSection(sections, ["Out of scope"]),
  };
}

function splitSections(body) {
  // Strip the support-agent footer block first so its raw content can't be
  // accidentally treated as a section heading. The HTML comment opener `<!--`
  // never starts a Markdown heading so this is defensive — but cheap.
  const stripped = body.replace(/<!--\s*drafto-support-agent v1[\s\S]*?-->/g, "");
  const lines = stripped.split(/\r?\n/);
  const sections = {};
  let currentKey = null;
  let buf = [];
  for (const raw of lines) {
    const m = raw.match(/^#{1,6}\s+(.+?)\s*$/);
    if (m) {
      if (currentKey != null) sections[currentKey] = buf.join("\n").trim();
      currentKey = m[1].trim();
      buf = [];
      continue;
    }
    if (currentKey != null) buf.push(raw);
  }
  if (currentKey != null) sections[currentKey] = buf.join("\n").trim();
  return sections;
}

function pickSection(sections, candidates) {
  for (const name of candidates) {
    if (Object.prototype.hasOwnProperty.call(sections, name)) {
      return sections[name];
    }
  }
  return "";
}

// Affected platforms is a `### Affected platforms` heading followed by a
// bullet list of GitHub-rendered task list checkboxes:
//
//   - [x] web (`apps/web`)
//   - [ ] iOS / Android (`apps/mobile`)
//   - [ ] macOS (`apps/desktop`)
//
// We accept the label text without the path suffix too (the issue-form
// renderer sometimes drops backticks).
export function parsePlatformCheckboxes(section) {
  if (typeof section !== "string" || section.length === 0) return [];
  const out = [];
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/);
    if (!m) continue;
    if (m[1] === " ") continue;
    const label = m[2].toLowerCase();
    if (label.startsWith("web")) out.push("web");
    else if (label.startsWith("ios") || label.includes("mobile") || label.includes("android")) {
      out.push("mobile");
    } else if (label.startsWith("macos") || label.includes("desktop")) {
      out.push("desktop");
    }
  }
  return [...new Set(out)].sort();
}

function parseSchemaAnswer(section) {
  if (typeof section !== "string" || section.length === 0) return null;
  const s = section.toLowerCase().trim();
  if (s.startsWith("yes")) return true;
  if (s.startsWith("no")) return false;
  return null;
}

// Pure: which parity:* override label is present on the issue (if any).
// Returns "web-only" | "mobile-only" | "desktop-only" | null.
export function parityOverrideFrom(labels) {
  const list = Array.isArray(labels) ? labels : [];
  for (const lbl of list) {
    const name = typeof lbl === "string" ? lbl : lbl?.name;
    if (typeof name !== "string") continue;
    if (name === "parity:web-only") return "web-only";
    if (name === "parity:mobile-only") return "mobile-only";
    if (name === "parity:desktop-only") return "desktop-only";
  }
  return null;
}

// Pure: distil the support-agent footer into the fields the factory needs.
// `zoho-thread-id` ties the issue back to its inbound Zoho thread so accept
// signals can be classified against the right conversation.
//
// `reporter-allowlisted` is informational only — the support agent's own
// allowlist gate (logs/support-state.json) is the trust anchor per ADR-0025.
// We surface it for the prompt to use in plan / progress messaging.
export function reporterFromBody(body) {
  const fields = parseIssueFooter(body);
  if (!fields) return { allowlisted: false, email: "", zohoThreadId: "" };
  const flag = (fields["reporter-allowlisted"] ?? "").toLowerCase().trim();
  return {
    allowlisted: flag === "true",
    email: (fields["reporter-email"] ?? "").trim(),
    zohoThreadId: (fields["zoho-thread-id"] ?? "").trim(),
  };
}

// Pure: filter comments down to the ones the planner / implementer should
// see. We strip nothing structural here — the prompt wants both human and
// bot comments for context — but we do envelope-wrap each body to neutralise
// embedded prompt-instructions, same as build-bundle.mjs does.
function envelopeComments(comments) {
  const list = Array.isArray(comments) ? comments : [];
  return list.map((c) => ({
    id: c?.id ?? null,
    user: { login: c?.user?.login ?? c?.author?.login ?? "" },
    body: envelopeBody(c?.body ?? "", "comment"),
    createdAt: c?.createdAt ?? c?.created_at ?? null,
  }));
}

function shapeIssue(issue) {
  return {
    number: issue?.number ?? null,
    title: issue?.title ?? "",
    state: issue?.state ?? "open",
    labels: (issue?.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean),
    bodyEnveloped: envelopeBody(issue?.body ?? "", "issue-body"),
  };
}

function shapeConfig(config) {
  const cfg = config ?? {};
  return {
    phase: cfg.phase ?? "A",
    allowlist: Array.isArray(cfg.allowlist) ? cfg.allowlist : [],
    oauthUserEmail: cfg.oauthUserEmail ?? "",
  };
}

function shapeRepo(repo) {
  return {
    nameWithOwner: repo?.nameWithOwner ?? "",
    headRef: repo?.headRef ?? "",
  };
}

export function buildFactoryPlanBundle({ issue, comments = [], config, repo, nowIso } = {}) {
  if (!issue || !Number.isInteger(issue.number)) {
    throw new Error("buildFactoryPlanBundle: issue.number is required");
  }
  return {
    kind: "factory_plan",
    issue: shapeIssue(issue),
    spec: parseSpec(issue.body ?? ""),
    parityOverride: parityOverrideFrom(issue.labels),
    comments: envelopeComments(comments),
    reporter: reporterFromBody(issue.body ?? ""),
    config: shapeConfig(config),
    repo: shapeRepo(repo),
    nowIso: typeof nowIso === "string" ? nowIso : new Date().toISOString(),
  };
}

export function buildFactoryImplementBundle({
  issue,
  approvedPlan,
  comments = [],
  priorPr = null,
  attempts = 0,
  config,
  repo,
  nowIso,
} = {}) {
  if (!issue || !Number.isInteger(issue.number)) {
    throw new Error("buildFactoryImplementBundle: issue.number is required");
  }
  // Strip the marker from the plan body for cleanliness — the prompt doesn't
  // need to see it, and downstream forwarding (if any) shouldn't surface it.
  const planBody = typeof approvedPlan?.body === "string" ? approvedPlan.body : "";
  const planClean = planBody.split(FACTORY_PLAN_MARKER).join("").trim();
  return {
    kind: "factory_implement",
    issue: shapeIssue(issue),
    spec: parseSpec(issue.body ?? ""),
    parityOverride: parityOverrideFrom(issue.labels),
    approvedPlan: approvedPlan
      ? {
          commentId: approvedPlan.commentId ?? approvedPlan.id ?? null,
          url: approvedPlan.url ?? "",
          createdAt: approvedPlan.createdAt ?? approvedPlan.created_at ?? null,
          bodyEnveloped: envelopeBody(planClean, "factory-plan"),
        }
      : null,
    comments: envelopeComments(comments),
    reporter: reporterFromBody(issue.body ?? ""),
    priorPr: priorPr
      ? {
          number: priorPr.number ?? null,
          url: priorPr.url ?? "",
          headRef: priorPr.headRef ?? "",
          state: priorPr.state ?? "",
        }
      : null,
    attempts: Number.isInteger(attempts) ? attempts : 0,
    config: shapeConfig(config),
    repo: shapeRepo(repo),
    nowIso: typeof nowIso === "string" ? nowIso : new Date().toISOString(),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) throw new Error("factory-bundle: empty stdin");
  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    throw new Error(`factory-bundle: invalid stdin JSON: ${err.message}`);
  }
  let bundle;
  if (input.kind === "factory_plan") {
    bundle = buildFactoryPlanBundle({
      issue: input.issue,
      comments: input.comments,
      config: input.config,
      repo: input.repo,
      nowIso: input.nowIso,
    });
  } else if (input.kind === "factory_implement") {
    bundle = buildFactoryImplementBundle({
      issue: input.issue,
      approvedPlan: input.approvedPlan,
      comments: input.comments,
      priorPr: input.priorPr,
      attempts: input.attempts,
      config: input.config,
      repo: input.repo,
      nowIso: input.nowIso,
    });
  } else {
    // Fail fast on typos / future kinds — the bash side always sets `kind`.
    throw new Error(`factory-bundle: unknown kind: ${input.kind}`);
  }
  process.stdout.write(JSON.stringify(bundle, null, 2) + "\n");
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
    process.exit(1);
  });
}
