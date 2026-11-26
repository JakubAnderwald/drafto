// What the factory's device lane (ADR-0099) should run for a PR. Pure: no IO.
//
// The lane builds a dev-backed mobile app from the PR head and runs the
// repo's Maestro flows on a headless Android emulator and an iOS simulator.
// This module decides, from the PR's changed files and the test scenario's
// section headings, whether that is worth doing at all and, per platform,
// which flows to run.
//
//   - Applicable only when the diff touches the mobile app (apps/mobile/**,
//     except its store listing assets and docs) or the shared package.
//   - A change to one platform's own flows (`<platform>-all.yaml`,
//     `<platform>-only/**`) selects that platform; anything else applicable
//     selects both. A scenario section headed for iOS or Android adds that
//     platform; a generic mobile heading adds both.
//   - Each platform always runs its combined smoke flow, `<platform>-all.yaml`,
//     plus the standalone flows the PR changed for it, minus the ones the lane
//     must never run unattended (DESTRUCTIVE_FLOWS) and the ones it can't run
//     (a web-seeded flow, a flow tagged for a host that goes offline).

import { MOBILE_HEADING } from "./verify-report.mjs";

export { MOBILE_HEADING };
export const IOS_HEADING = /\b(ios|iphone|ipad)\b/i;
export const ANDROID_HEADING = /\bandroid\b/i;

export const PLATFORMS = Object.freeze(["android", "ios"]);
export const E2E_DIR = "apps/mobile/e2e";

// Never run by the lane. 07 opens the account-deletion dialog of the shared
// account and 05 edits a note a web test seeds; the runner scripts drive web
// tests and the host; helpers are subflows, not flows.
export const DESTRUCTIVE_FLOWS = Object.freeze([
  `${E2E_DIR}/07-delete-account.yaml`,
  `${E2E_DIR}/05-cross-platform-sync.yaml`,
  `${E2E_DIR}/run-*.sh`,
  `${E2E_DIR}/helpers/**`,
]);

// Runnable only through their runner scripts, which seed data first.
export const RUNNER_ONLY_FLOWS = Object.freeze([`${E2E_DIR}/08-nested-lists.yaml`]);

// A flow with one of these tags needs the host itself (the Mac goes offline,
// sudo), which an unattended lane never does.
export const HOST_TAGS = Object.freeze(["requires-host-offline"]);

const MOBILE_PREFIX = "apps/mobile/";
const SHARED_PREFIX = "packages/shared/";
const NOT_APP = [/^apps\/mobile\/store\//, /^apps\/mobile\/(?:.*\/)?__tests__\//, /\.md$/i];

function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${esc
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, ".*")}$`,
  );
}

const DESTRUCTIVE_RES = DESTRUCTIVE_FLOWS.map(globToRe);

/** Whether <file> (repo-relative) is a flow the lane must never run. */
export function isDestructiveFlow(file) {
  return DESTRUCTIVE_RES.some((re) => re.test(file));
}

/** The flow's name as device-output.json shows it: its path under apps/mobile/e2e. */
export function flowName(file) {
  return String(file).startsWith(`${E2E_DIR}/`) ? file.slice(E2E_DIR.length + 1) : String(file);
}

export function smokeFlow(platform) {
  return `${E2E_DIR}/${platform}-all.yaml`;
}

function isAppFile(file) {
  if (file.startsWith(SHARED_PREFIX)) return !/\.md$/i.test(file);
  return file.startsWith(MOBILE_PREFIX) && !NOT_APP.some((re) => re.test(file));
}

/**
 * Which platforms a changed file selects, and whether it is a standalone flow
 * (one the lane may add to that platform's run). Only called for app files.
 */
function classifyFile(file) {
  if (!file.startsWith(`${E2E_DIR}/`)) return { platforms: PLATFORMS, flow: false };
  const rel = flowName(file);
  for (const p of PLATFORMS) {
    if (rel === `${p}-all.yaml`) return { platforms: [p], flow: false };
    if (rel.startsWith(`${p}-only/`)) return { platforms: [p], flow: /\.ya?ml$/.test(rel) };
  }
  if (rel.startsWith("helpers/")) return { platforms: PLATFORMS, flow: false };
  // A numbered flow (or search.yaml) at the e2e root runs on both platforms.
  if (!rel.includes("/") && /\.ya?ml$/.test(rel)) return { platforms: PLATFORMS, flow: true };
  // Runner scripts, fixtures: they change no app and no flow the lane runs.
  return { platforms: [], flow: false };
}

/** The platforms a scenario section's heading names: iOS, Android, both, or none. */
export function headingPlatforms(heading) {
  const h = String(heading ?? "");
  if (!MOBILE_HEADING.test(h)) return [];
  const ios = IOS_HEADING.test(h);
  const android = ANDROID_HEADING.test(h);
  if (ios && !android) return ["ios"];
  if (android && !ios) return ["android"];
  return [...PLATFORMS];
}

/**
 * @param {object} input
 * @param {string[]} input.diffFiles         repo-relative paths the PR changes
 * @param {{heading: string, text?: string}[]} [input.scenarioSections]
 * @param {Record<string, string[]|null>} [input.flowTags]  a flow's Maestro tags,
 *   by repo-relative path (read by the lane; flows without an entry have none;
 *   null means its header couldn't be read, and the flow isn't run)
 * @param {string[]} [input.deletedFiles]  files the PR deletes: they still make
 *   the PR applicable, but a deleted flow is never run
 * @returns {{applicable: boolean, platforms: {android?: {flows: string[], unavailable?: string}, ios?: {flows: string[], unavailable?: string}}, reasons: string[]}}
 *   A platform whose smoke flow the PR deletes has no flows and
 *   `unavailable: "no-smoke-flow"` (or "smoke-flow-needs-host" /
 *   "smoke-flow-unreadable" when its tags make it ineligible): the lane
 *   reports it without building.
 */
export function deriveDevicePlan({
  diffFiles = [],
  scenarioSections = [],
  flowTags = {},
  deletedFiles = [],
} = {}) {
  const deleted = new Set((Array.isArray(deletedFiles) ? deletedFiles : []).map(String));
  const files = [...new Set((Array.isArray(diffFiles) ? diffFiles : []).map(String))].sort();
  const reasons = [];
  const appFiles = files.filter(isAppFile);
  if (appFiles.length === 0) {
    reasons.push("no change to the mobile app or the shared package");
    return { applicable: false, platforms: {}, reasons };
  }
  const selected = new Set();
  const extra = { android: [], ios: [] };
  for (const file of appFiles) {
    const c = classifyFile(file);
    for (const p of c.platforms) selected.add(p);
    if (c.platforms.length) reasons.push(`${file} → ${c.platforms.join(" + ")}`);
    if (!c.flow) continue;
    if (deleted.has(file)) {
      reasons.push(`${flowName(file)} is deleted by the PR: not run`);
      continue;
    }
    for (const p of c.platforms) extra[p].push(file);
  }
  for (const section of Array.isArray(scenarioSections) ? scenarioSections : []) {
    const ps = headingPlatforms(section?.heading);
    for (const p of ps) selected.add(p);
    if (ps.length)
      reasons.push(`scenario section "${String(section.heading).trim()}" → ${ps.join(" + ")}`);
  }
  if (selected.size === 0) {
    reasons.push("the change touches no flow or app code either platform runs");
    return { applicable: false, platforms: {}, reasons };
  }
  const platforms = {};
  for (const p of PLATFORMS) {
    if (!selected.has(p)) continue;
    if (deleted.has(smokeFlow(p))) {
      reasons.push(`${flowName(smokeFlow(p))} is deleted by the PR: nothing to run on ${p}`);
      platforms[p] = { flows: [], unavailable: "no-smoke-flow" };
      continue;
    }
    // The smoke flow must be eligible too: a PR can tag it for a host step
    // or leave a header the lane can't read.
    const smokeTags = flowTags?.[smokeFlow(p)];
    const smokeHost = Array.isArray(smokeTags) && smokeTags.find((t) => HOST_TAGS.includes(t));
    if (smokeTags === null || smokeHost) {
      const why = smokeHost ? `is tagged ${smokeHost}` : "has tags that couldn't be read";
      reasons.push(`${flowName(smokeFlow(p))} ${why}: nothing to run on ${p}`);
      platforms[p] = {
        flows: [],
        unavailable: smokeHost ? "smoke-flow-needs-host" : "smoke-flow-unreadable",
      };
      continue;
    }
    const flows = [smokeFlow(p)];
    for (const file of extra[p]) {
      if (flows.includes(file)) continue;
      if (isDestructiveFlow(file)) {
        reasons.push(`${flowName(file)} skipped on ${p}: never run unattended`);
        continue;
      }
      if (RUNNER_ONLY_FLOWS.includes(file)) {
        reasons.push(`${flowName(file)} skipped on ${p}: needs its runner script's seeded data`);
        continue;
      }
      const raw = flowTags?.[file];
      if (raw === null) {
        reasons.push(`${flowName(file)} skipped on ${p}: its tags couldn't be read`);
        continue;
      }
      const tags = Array.isArray(raw) ? raw : [];
      const hostTag = tags.find((t) => HOST_TAGS.includes(t));
      if (hostTag) {
        reasons.push(`${flowName(file)} skipped on ${p}: tagged ${hostTag}`);
        continue;
      }
      flows.push(file);
    }
    platforms[p] = { flows };
  }
  return { applicable: true, platforms, reasons };
}

/**
 * The Maestro tags in a flow file's header (the part before the first `---`):
 * a block list (`tags:` then `- name` lines) or a flow sequence
 * (`tags: [a, "b"]`). [] when the header has no `tags:` key; null when it has
 * one this can't read, which the plan treats as "don't run it".
 */
export function parseFlowTags(yamlText) {
  const header = String(yamlText ?? "").split(/^---\s*$/m)[0] ?? "";
  const lines = header.split("\n");
  const at = lines.findIndex((l) => /^tags\s*:/.test(l));
  if (at === -1) return [];
  const unquote = (t) => t.trim().replace(/^(["'])(.*)\1$/, "$2");
  const valid = (t) => /^[A-Za-z0-9._-]+$/.test(t);
  const inline = stripComment(lines[at].replace(/^tags\s*:/, "")).trim();
  if (inline) {
    const m = /^\[(.*)\]$/.exec(inline);
    if (!m) return null;
    const tags = m[1].trim() ? m[1].split(",").map(unquote) : [];
    return tags.every(valid) ? tags : null;
  }
  const tags = [];
  for (const line of lines.slice(at + 1)) {
    const l = stripComment(line);
    if (!l.trim()) continue;
    const m = /^[ \t]*-\s*(.+)$/.exec(l);
    if (!m) {
      if (/^\S/.test(l)) break; // the next key
      return null;
    }
    const tag = unquote(m[1]);
    if (!valid(tag)) return null;
    tags.push(tag);
  }
  return tags;
}

/** <line> without a YAML comment: a `#` outside quotes, at the start or after a space. */
export function stripComment(line) {
  let quote = null;
  const s = String(line ?? "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

// A flow starts from a clean, signed-out app when it clears the keychain in
// its first commands (01, 06, 09, 10, 12, …), and signs itself in when it
// types the E2E password (the combined flows, the host-check flows). Every
// other flow (02, 03, 04, 11, search, …) assumes a signed-in app, which the
// lane provides by running its sign-in helper first. A flow can say so
// itself with a `# device-lane: needs-sign-in` or `# device-lane: no-sign-in`
// comment.
const SIGN_IN_MARK = /^\s*#\s*device-lane:\s*(needs-sign-in|no-sign-in)\s*$/m;
const OWN_PASSWORD = /^\s*-?\s*inputText:.*\b(?:MAESTRO_)?E2E_TEST_PASSWORD\b/m;

/** Whether the lane must sign in before running a flow with this text. */
export function flowNeedsSignIn(yamlText) {
  const text = String(yamlText ?? "");
  const mark = SIGN_IN_MARK.exec(text)?.[1];
  if (mark) return mark === "needs-sign-in";
  const body = text
    .split(/^---\s*$/m)
    .slice(1)
    .join("\n");
  const first = body
    .split("\n")
    .filter((l) => /^- /.test(l))
    .slice(0, 3);
  if (first.some((l) => /^-\s*clearKeychain\b/.test(l))) return false;
  // Comments out first, whole-line and trailing: `- inputText: "x" # E2E_TEST_PASSWORD`
  // types no password.
  const code = body.split("\n").map(stripComment).join("\n");
  return !OWN_PASSWORD.test(code);
}
