#!/usr/bin/env node
// Build a per-issue context bundle for the dark-factory agent.
//
// Three kinds today:
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
//   factory_watch      — for `factory-agent.sh --watch` (Phase B+). The
//                        /push-style fix loop: approved plan + PR pointer +
//                        a CI failure summary + the unresolved review
//                        comments, so the model can make minimal in-scope
//                        fixes and re-push.
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
//     "repo":     { "nameWithOwner", "headRef" },
//     "replan"?:  { "planCommentId", "planCommentUrl", "planCommentBody",
//                   "triggerCommentIds": [<id>, ...] }
//   }
//
// `replan` is set only when the bash side detected unacked OWNER comments
// newer than the plan marker on a `status:plan-review` card. When present,
// the planner edits the existing plan comment in place instead of posting a
// new one. When absent, the bundle is identical to a first-plan run.
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

// Hosts GitHub serves issue/PR image attachments and repo raw images from. The
// planner is permitted to fetch ONLY URLs whose host is in this set (and, for
// github.com, only under the /user-attachments/ path). This allowlist is the
// SSRF/exfil control: it lives in code, not in the prompt, so a prompt-injected
// link to an arbitrary origin in the (enveloped, treated-as-data) issue body can
// never become an outbound fetch — only code-extracted, GitHub-hosted URLs ever
// reach `bundle.screenshots`, and the prompt tells the planner to fetch nothing
// else.
const SCREENSHOT_HOSTS = new Set([
  "user-images.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "camo.githubusercontent.com",
]);

// Cap the number of screenshots surfaced so a comment stuffed with image links
// can't balloon the bundle or the planner's fetch budget.
const MAX_SCREENSHOTS = 12;

function isAllowedScreenshotUrl(raw) {
  // curl and the WHATWG URL parser disagree on backslashes: `new URL` treats
  // "\" as an authority terminator while curl does not. So a string like
  // "https://user-images.githubusercontent.com\@evil.com/x" parses to a GitHub
  // host HERE but fetches evil.com UNDER curl — a parser-differential SSRF /
  // image-injection vector. Reject backslashes (and any embedded credentials)
  // outright so the host we validate is the host curl will reach.
  if (typeof raw !== "string" || raw.includes("\\")) return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false; // no userinfo — host must be the real target
  const host = u.hostname.toLowerCase();
  if (SCREENSHOT_HOSTS.has(host)) return true;
  // github.com itself only serves attachments under /user-attachments/<…>.
  return host === "github.com" && u.pathname.startsWith("/user-attachments/");
}

// An <img>/Markdown image is image-by-construction, but a BARE link is not —
// raw.githubusercontent.com/objects.githubusercontent.com serve arbitrary repo
// files too. Gate the bare-URL branch so a linked `turbo.json` isn't surfaced as
// a "screenshot" the planner then fetches and tries to Read as an image.
// github.com/user-attachments uploads are always media (and usually
// extension-less), so trust those regardless of extension.
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg|avif|heic)(?:[?#]|$)/i;
function isLikelyImageUrl(url) {
  if (/^https:\/\/github\.com\/user-attachments\//i.test(url)) return true;
  return IMAGE_EXT_RE.test(url);
}

// Strip trailing markdown/sentence punctuation a greedy bare-URL match can grab
// (e.g. a URL at the end of a sentence, or wrapped in parens).
function stripUrlTrailers(raw) {
  return String(raw).replace(/[)\].,;:'"]+$/, "");
}

function altFromImgTag(tag) {
  // `(?<![-\w])` so `data-alt=`/`x-alt=` don't masquerade as the real `alt`.
  const m = /(?<![-\w])alt\s*=\s*["']([^"']*)["']/i.exec(tag);
  return m ? m[1].trim() : "";
}

// Pure: collect image URLs the planner can actually look at. Scans the issue
// body and every comment for Markdown images, HTML <img> tags, and bare links,
// then keeps only GitHub-hosted URLs (see isAllowedScreenshotUrl), deduped in
// first-seen order and capped. Surfacing screenshots as a first-class field —
// rather than leaving them buried in the enveloped body the planner is told to
// treat as inert data — is what makes a screenshot-driven spec inspectable
// instead of invisible. Some specs ("see screenshots") carry their entire
// signal in images the planner would otherwise never see.
export function extractScreenshots(body, comments = []) {
  const sources = [typeof body === "string" ? body : ""];
  for (const c of Array.isArray(comments) ? comments : []) {
    if (typeof c?.body === "string") sources.push(c.body);
  }
  const seen = new Set();
  const out = [];
  const push = (rawUrl, alt) => {
    if (out.length >= MAX_SCREENSHOTS) return;
    const url = stripUrlTrailers(rawUrl);
    if (!isAllowedScreenshotUrl(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, alt: typeof alt === "string" ? alt.trim() : "" });
  };
  const mdImg = /!\[([^\]]*)\]\(\s*([^)\s]+)/g;
  // `(?<![-\w])src` so `data-src=` (a decoy attr) can't be read as the real src.
  const htmlImg = /<img\b[^>]*?(?<![-\w])src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const bareUrl = /https:\/\/[^\s"'<>)]+/gi;
  for (const text of sources) {
    for (const m of text.matchAll(mdImg)) push(m[2], m[1]);
    for (const m of text.matchAll(htmlImg)) push(m[1], altFromImgTag(m[0]));
    // Bare links aren't necessarily images — gate on image-likeness (above).
    for (const m of text.matchAll(bareUrl)) {
      if (isLikelyImageUrl(stripUrlTrailers(m[0]))) push(m[0], "");
    }
    if (out.length >= MAX_SCREENSHOTS) break;
  }
  return out;
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
    infraOnly: false,
    schemaChanges: null,
    ui: "",
    outOfScope: "",
  };
  if (typeof body !== "string" || body.length === 0) return empty;
  const sections = splitSections(body);
  const platformsSection = pickSection(sections, ["Affected platforms"]);
  return {
    what: pickSection(sections, ["What"]),
    acceptance: pickSection(sections, ["Acceptance criteria"]),
    affectedPlatforms: parsePlatformCheckboxes(platformsSection),
    infraOnly: parseInfraOnlyCheckbox(platformsSection),
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

// Pure: was the "None — no app platform" box ticked in the Affected platforms
// section? A ticked None box marks the issue infra-only (factory internals,
// docs, CI) — the form-native equivalent of the parity:infra-only label.
export function parseInfraOnlyCheckbox(section) {
  if (typeof section !== "string" || section.length === 0) return false;
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/);
    if (!m || m[1] === " ") continue;
    if (m[2].toLowerCase().startsWith("none")) return true;
  }
  return false;
}

function parseSchemaAnswer(section) {
  if (typeof section !== "string" || section.length === 0) return null;
  const s = section.toLowerCase().trim();
  if (s.startsWith("yes")) return true;
  if (s.startsWith("no")) return false;
  return null;
}

// Pure: which parity:* override label is present on the issue (if any).
// Returns "web-only" | "mobile-only" | "desktop-only" | "infra-only" | null.
// "infra-only" marks a change that touches no app platform (factory internals
// under scripts/, docs, CI); the others authorise single-platform app work.
export function parityOverrideFrom(labels) {
  const list = Array.isArray(labels) ? labels : [];
  for (const lbl of list) {
    const name = typeof lbl === "string" ? lbl : lbl?.name;
    if (typeof name !== "string") continue;
    if (name === "parity:web-only") return "web-only";
    if (name === "parity:mobile-only") return "mobile-only";
    if (name === "parity:desktop-only") return "desktop-only";
    if (name === "parity:infra-only") return "infra-only";
  }
  return null;
}

// Pure: the effective parity override for an issue — an explicit parity:* label
// wins; otherwise a ticked "None" box in the Affected platforms section implies
// infra-only. Same return vocabulary as parityOverrideFrom (plus null).
export function effectiveParityOverride(labels, spec) {
  return parityOverrideFrom(labels) ?? (spec?.infraOnly ? "infra-only" : null);
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

// Marker the prompt appends to the (edited) plan comment body to record
// which OWNER comment IDs have already been incorporated into the plan. The
// bash detector treats a Plan Review card as "needs replan" only if there
// is at least one OWNER comment newer than the plan whose ID is NOT yet
// present as an ack marker — stops the factory from looping on the same
// trigger comment after a successful replan.
export const FACTORY_REPLAN_ACK_PREFIX = "<!-- drafto-factory-replan-ack:";

function shapeReplan(replan) {
  if (!replan || typeof replan !== "object") return null;
  const planCommentId = replan.planCommentId ?? replan.commentId ?? null;
  if (planCommentId === null || planCommentId === undefined || planCommentId === "") {
    return null;
  }
  const triggerIds = Array.isArray(replan.triggerCommentIds)
    ? replan.triggerCommentIds.filter((id) => id !== null && id !== undefined && id !== "")
    : [];
  return {
    planCommentId,
    planCommentUrl: replan.planCommentUrl ?? "",
    // The plan body is enveloped so any injected instructions inside the
    // prior plan (e.g. an operator-supplied snippet that quotes a fake plan
    // directive) can't escape into the model's instruction stream.
    planCommentBodyEnveloped: envelopeBody(replan.planCommentBody ?? "", "prior-plan"),
    triggerCommentIds: triggerIds,
  };
}

export function buildFactoryPlanBundle({
  issue,
  comments = [],
  config,
  repo,
  nowIso,
  replan,
} = {}) {
  if (!issue || !Number.isInteger(issue.number)) {
    throw new Error("buildFactoryPlanBundle: issue.number is required");
  }
  const spec = parseSpec(issue.body ?? "");
  const bundle = {
    kind: "factory_plan",
    issue: shapeIssue(issue),
    spec,
    parityOverride: effectiveParityOverride(issue.labels, spec),
    // GitHub-hosted image URLs (host-validated) pulled from the body + comments
    // so the planner can fetch and actually look at screenshot-driven specs.
    screenshots: extractScreenshots(issue.body ?? "", comments),
    comments: envelopeComments(comments),
    reporter: reporterFromBody(issue.body ?? ""),
    config: shapeConfig(config),
    repo: shapeRepo(repo),
    nowIso: typeof nowIso === "string" ? nowIso : new Date().toISOString(),
  };
  const replanShape = shapeReplan(replan);
  if (replanShape) bundle.replan = replanShape;
  return bundle;
}

export function buildFactoryImplementBundle({
  issue,
  approvedPlan,
  comments = [],
  revisionComments = [],
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
  const spec = parseSpec(issue.body ?? "");
  return {
    kind: "factory_implement",
    issue: shapeIssue(issue),
    spec,
    parityOverride: effectiveParityOverride(issue.labels, spec),
    approvedPlan: approvedPlan
      ? {
          commentId: approvedPlan.commentId ?? approvedPlan.id ?? null,
          url: approvedPlan.url ?? "",
          createdAt: approvedPlan.createdAt ?? approvedPlan.created_at ?? null,
          bodyEnveloped: envelopeBody(planClean, "factory-plan"),
        }
      : null,
    comments: envelopeComments(comments),
    // Reporter change requests from the In Test preview, to apply on top of the
    // approved plan, on the existing PR branch. Empty on a first implementation.
    revisionComments: envelopeComments(revisionComments),
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

// Bundle for `factory-agent.sh --watch`. Built when an In Review PR has
// failing CI checks and/or unresolved review comments — the /push-style fix
// loop. Carries the approved plan (so fixes stay in scope), the PR pointer,
// a plain-text CI failure summary, and the unresolved review comments.
export function buildFactoryWatchBundle({
  issue,
  approvedPlan,
  priorPr = null,
  ciSummary = "",
  unresolvedComments = [],
  comments = [],
  attempts = 0,
  config,
  repo,
  nowIso,
} = {}) {
  if (!issue || !Number.isInteger(issue.number)) {
    throw new Error("buildFactoryWatchBundle: issue.number is required");
  }
  const planBody = typeof approvedPlan?.body === "string" ? approvedPlan.body : "";
  const planClean = planBody.split(FACTORY_PLAN_MARKER).join("").trim();
  const spec = parseSpec(issue.body ?? "");
  return {
    kind: "factory_watch",
    issue: shapeIssue(issue),
    spec,
    parityOverride: effectiveParityOverride(issue.labels, spec),
    approvedPlan: approvedPlan
      ? {
          commentId: approvedPlan.commentId ?? approvedPlan.id ?? null,
          url: approvedPlan.url ?? "",
          createdAt: approvedPlan.createdAt ?? approvedPlan.created_at ?? null,
          bodyEnveloped: envelopeBody(planClean, "factory-plan"),
        }
      : null,
    priorPr: priorPr
      ? {
          number: priorPr.number ?? null,
          url: priorPr.url ?? "",
          headRef: priorPr.headRef ?? "",
          state: priorPr.state ?? "",
        }
      : null,
    // The fix context. Both are enveloped — a hostile review comment or a CI
    // log line that quotes a fake directive must not escape into the model's
    // instruction stream.
    ciSummaryEnveloped: envelopeBody(typeof ciSummary === "string" ? ciSummary : "", "ci-summary"),
    unresolvedComments: envelopeComments(unresolvedComments),
    comments: envelopeComments(comments),
    reporter: reporterFromBody(issue.body ?? ""),
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
      replan: input.replan,
    });
  } else if (input.kind === "factory_implement") {
    bundle = buildFactoryImplementBundle({
      issue: input.issue,
      approvedPlan: input.approvedPlan,
      comments: input.comments,
      revisionComments: input.revisionComments,
      priorPr: input.priorPr,
      attempts: input.attempts,
      config: input.config,
      repo: input.repo,
      nowIso: input.nowIso,
    });
  } else if (input.kind === "factory_watch") {
    bundle = buildFactoryWatchBundle({
      issue: input.issue,
      approvedPlan: input.approvedPlan,
      priorPr: input.priorPr,
      ciSummary: input.ciSummary,
      unresolvedComments: input.unresolvedComments,
      comments: input.comments,
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
