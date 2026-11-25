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

function headingPlatforms(heading) {
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
 * @param {Record<string, string[]>} [input.flowTags]  a flow's Maestro tags, by
 *   repo-relative path (read by the lane; flows without an entry have none)
 * @returns {{applicable: boolean, platforms: {android?: {flows: string[]}, ios?: {flows: string[]}}, reasons: string[]}}
 */
export function deriveDevicePlan({ diffFiles = [], scenarioSections = [], flowTags = {} } = {}) {
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
      const tags = Array.isArray(flowTags?.[file]) ? flowTags[file] : [];
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
 * The Maestro tags in a flow file's header (the part before the first `---`).
 * Small and forgiving: `tags:` followed by `- name` lines.
 */
export function parseFlowTags(yamlText) {
  const header = String(yamlText ?? "").split(/^---\s*$/m)[0] ?? "";
  const m = /^tags:\s*\n((?:[ \t]+-[^\n]*\n?)+)/m.exec(header);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) => /^[ \t]+-\s*["']?([^"'#\s]+)["']?/.exec(l)?.[1])
    .filter(Boolean);
}
