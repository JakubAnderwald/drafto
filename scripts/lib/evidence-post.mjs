#!/usr/bin/env node
// Posts a macOS In-Test harness run (ADR-0043) on its issue, with the run's
// screenshots (ADR-0072). An operator command, never run by the factory.
//
// Why it is manual: the harness is started by a person in Terminal, against
// PRODUCTION, with a throwaway account. Its shots capture only the Drafto
// window, but a run starts by signing the operator's own account out, so an
// early shot can show the operator's own notes. So this command first lists
// exactly what it would publish and stops; only `--yes` publishes. It also
// refuses while the run's `state.env` exists (the throwaway account is still
// live: run the scenario's `--cleanup-only` first), when `report.md` has no
// `Run:` line (the report wasn't finished), when the report matches a secret
// pattern, and in an unattended session (DRAFTO_UNATTENDED=1).
//
// Publishing goes through evidence-upload.mjs (the same selftest gate, ref
// layout, idempotency and OCR secret scan as the browser runner's
// screenshots), and the comment is composed here: the report, defanged, then
// each step's screenshots, mapped from `results.jsonl` and the shot names
// `NN-step-<id>-<STATUS>.png` (shots with other labels go under "Other
// screenshots"). The comment carries `<!-- drafto-factory-macos-run-report -->`
// and is posted once per run: `posted.json` in the run dir records it, and a
// retry first looks for the run's comment on the issue (a post that timed out
// after GitHub created it), recording it instead of posting a second.
//
// CLI:
//   node scripts/lib/evidence-post.mjs macos --run-dir <dir> --issue <n>
//        [--sha <40-hex>] [--yes] [--log-dir <dir>] [--repo-root <dir>] [--ocr <bin>]
//     --sha: the commit the run tested; default, the commit an earlier --yes
//     of this run recorded in its upload.json, else the newest scenario-sha
//     marker on the issue's own (OWNER) comments. --log-dir: where the
//     factory keeps evidence-selftest.json (default <repo-root>/logs/factory).
//     --ocr: default <log-dir>/bin/ocr, else the harness's
//     apps/desktop/e2e/in-test/bin/ocr. Exit 0 on a listing or a post; 1 on a
//     refusal or a failure; 2 on a usage error.

import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMMENT_MAX_CHARS, defangReport } from "./browser-report.mjs";
import { evidenceSection, readUpload } from "./evidence-embed.mjs";
import { macosManifest, ocrAvailable } from "./evidence-images.mjs";
import {
  REPO,
  RUN_ID_RE,
  UPLOAD_FILE,
  evidenceRef,
  prepareRun,
  priorUpload,
  uploadGate,
  uploadRun,
} from "./evidence-upload.mjs";
import { ghTimeoutMs } from "./gh-timeout.mjs";
import { isMainModule } from "./is-main.mjs";
import { closeFences, truncateFenced } from "./markdown-fence.mjs";
import { parseFlags } from "./parse-flags.mjs";
import { scanLaneText } from "./verify-report.mjs";

export const MACOS_REPORT_MARKER = "<!-- drafto-factory-macos-run-report -->";
export const POSTED_FILE = "posted.json";
const HEADER = "🏭 **macOS run — the In-Test harness on this Mac mini**";
const SHA_RE = /^[0-9a-f]{40}$/;
const ISSUE_RE = /^[1-9][0-9]{0,6}$/;
const SCENARIO_SHA_RE = /drafto-factory-scenario-sha:([0-9a-f]{40})/g;
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

class Refusal extends Error {}
class UsageError extends Error {}

// ── inputs ──────────────────────────────────────────────────────────────────

/** results.jsonl → [{step, name, status}], skipping lines that aren't JSON. */
export function readResults(file, { fs = nodeFs } = {}) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object" && typeof r.step === "string") {
        out.push({
          step: r.step,
          name: typeof r.name === "string" ? r.name : "",
          status: typeof r.status === "string" ? r.status : "",
        });
      }
    } catch {
      // not a result line
    }
  }
  return out;
}

/** The newest scenario-sha marker on the factory's own comments, or null. */
export function scenarioShaFrom(comments) {
  let sha = null;
  for (const c of Array.isArray(comments) ? comments : []) {
    if (c?.author_association !== "OWNER" && c?.authorAssociation !== "OWNER") continue;
    for (const m of String(c.body ?? "").matchAll(SCENARIO_SHA_RE)) sha = m[1];
  }
  return sha;
}

/**
 * The commit an earlier --yes of this run resolved, from the run's own upload
 * record (upload.json): its issue, run id and ref must all match, or null.
 * A retry keeps it, so a scenario-sha marker posted since (a newer head)
 * can't change which commit the run says it tested.
 */
export function recordedSha(record, { issue, runId }) {
  if (record === null || typeof record !== "object") return null;
  if (record.issue !== issue || record.runId !== runId) return null;
  const sha = typeof record.sha === "string" ? record.sha : "";
  return SHA_RE.test(sha) && record.ref === evidenceRef(issue, sha, runId) ? sha : null;
}

// The comment's line that names its run (composeComment's head).
const runLine = (runId) =>
  `Run \`${String(runId).replace(/[^A-Za-z0-9_-]/g, "")}\`, posted by the operator. ` +
  "It never moves the card.";

/**
 * This run's comment, if it is already on the issue: the factory's own
 * (OWNER) comment with the macOS report marker and the run's line. A post
 * whose `gh` call failed or timed out may still have landed.
 */
export function postedCommentFor(comments, runId) {
  const line = runLine(runId);
  for (const c of Array.isArray(comments) ? comments : []) {
    if (c?.author_association !== "OWNER" && c?.authorAssociation !== "OWNER") continue;
    const body = String(c.body ?? "");
    if (body.includes(MACOS_REPORT_MARKER) && body.split(/\r?\n/).includes(line)) return c;
  }
  return null;
}

/**
 * Every comment on <issue>, all pages (`--slurp`: one array of pages, so
 * the parse never depends on how gh joins them), or null when gh fails or
 * its output isn't a page list.
 */
export function readIssueComments(gh, issue) {
  const r = gh([
    "api",
    `repos/${REPO}/issues/${issue}/comments?per_page=100`,
    "--paginate",
    "--slurp",
  ]);
  if (r.code !== 0) return null;
  try {
    const pages = JSON.parse(r.stdout);
    return Array.isArray(pages) && pages.every(Array.isArray) ? pages.flat() : null;
  } catch {
    return null;
  }
}

function defaultGh(args) {
  const r = spawnSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: ghTimeoutMs(),
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Why the run can't be posted, or null. Checked before anything is read. */
export function runProblem(runDir, { env = process.env, fs = nodeFs } = {}) {
  if (env.DRAFTO_UNATTENDED === "1") {
    return "this is an unattended session (DRAFTO_UNATTENDED=1): a macOS run is posted by a person";
  }
  let st;
  try {
    st = fs.statSync(runDir);
  } catch {
    return `no run directory at ${runDir}`;
  }
  if (!st.isDirectory()) return `${runDir} is not a directory`;
  if (fs.existsSync(path.join(runDir, "state.env"))) {
    return (
      "the run's throwaway production account is still live (state.env exists): " +
      "run the scenario with --cleanup-only first"
    );
  }
  return null;
}

/** The run's report.md, checked: finished (a Run: line) and secret-free. */
export function readReport(runDir, { fs = nodeFs } = {}) {
  let text;
  try {
    text = fs.readFileSync(path.join(runDir, "report.md"), "utf8");
  } catch {
    throw new Refusal("the run has no report.md");
  }
  if (!/^Run: /m.test(text)) {
    throw new Refusal("report.md has no Run: line, so the run didn't finish writing its report");
  }
  const hits = scanLaneText(text, {});
  if (hits.length) {
    throw new Refusal(`report.md matched a secret pattern (${hits.join(", ")}); nothing published`);
  }
  return text;
}

// ── the comment ─────────────────────────────────────────────────────────────

// The report as it goes into the comment: its `# …` title as bold, defanged,
// no <details>/<summary> it could open or close, fences closed.
function reportText(report) {
  const lines = String(report).replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (/^#\s+/.test(lines[0] ?? ""))
    lines[0] = `**${lines[0].replace(/^#\s+/, "").replace(/\*/g, "")}**`;
  return closeFences(
    defangReport(lines.join("\n")).replace(/<(\/?)(details|summary)/gi, "&lt;$1$2"),
  );
}

/**
 * The comment for one run: the report, its screenshots, the footer and the
 * marker. Within COMMENT_MAX_CHARS: the report text is cut first.
 */
export function composeComment({ report, upload, results, shotsDir, runId }) {
  const ev = evidenceSection({
    upload,
    withheld: false,
    evidenceDir: shotsDir,
    mode: "macos",
    results,
    isSafe: (lines) => scanLaneText(lines.join("\n"), {}).length === 0,
  });
  const head = [HEADER, "", runLine(runId), ""];
  const tail = [
    ...(ev.block.length ? ["", ...ev.block] : []),
    "",
    ev.footer,
    "",
    MACOS_REPORT_MARKER,
  ];
  const text = reportText(report);
  const assemble = (middle) => [...head, middle, ...tail].join("\n");
  const full = assemble(text);
  if (full.length <= COMMENT_MAX_CHARS) return { body: full, embedded: ev.embedded };
  const note = `\n\n_…report truncated; the full report is in the run directory._`;
  // The cut closes the fence it leaves open (```, ~~~, ````…) within the
  // room, so the screenshots and the marker after it never render as code.
  const room = COMMENT_MAX_CHARS - assemble("").length - note.length;
  return { body: assemble(truncateFenced(text, room) + note), embedded: ev.embedded };
}

// ── the command ─────────────────────────────────────────────────────────────

function defaultOcr(logDir, repoRoot) {
  for (const p of [
    path.join(logDir, "bin", "ocr"),
    path.join(repoRoot, "apps", "desktop", "e2e", "in-test", "bin", "ocr"),
  ]) {
    if (ocrAvailable(p)) return p;
  }
  return "";
}

/**
 * List what a run would publish, or (yes) publish and post it. Returns a
 * result object; throws Refusal for anything that stops it.
 */
export function postMacosRun({
  runDir: givenRunDir,
  issue,
  sha = "",
  yes = false,
  logDir,
  repoRoot,
  ocrBin = "",
  env = process.env,
  gh = defaultGh,
  git,
  deps = {},
  print = (s) => process.stdout.write(`${s}\n`),
}) {
  const problem = runProblem(givenRunDir, { env });
  if (problem) throw new Refusal(problem);
  // The run's own directory, links resolved: its name is the run id, so a
  // link to it (the harness's `latest`) must never become the id. Otherwise
  // every run posted through that link would share one ref and one comment.
  let runDir;
  try {
    runDir = nodeFs.realpathSync(givenRunDir);
  } catch {
    throw new Refusal(`no run directory at ${givenRunDir}`);
  }
  if (nodeFs.existsSync(path.join(runDir, POSTED_FILE))) {
    const prior = readUpload(path.join(runDir, POSTED_FILE));
    throw new Refusal(`this run was already posted${prior?.url ? `: ${prior.url}` : ""}`);
  }
  const report = readReport(runDir);
  const results = readResults(path.join(runDir, "results.jsonl"));
  const shotsDir = path.join(runDir, "shots");
  const runId = `macos-${path.basename(runDir).replace(/[^0-9A-Za-z_-]/g, "")}`.slice(0, 54);
  if (!RUN_ID_RE.test(runId))
    throw new Refusal(`can't make a run id from ${path.basename(runDir)}`);

  if (sha && !SHA_RE.test(sha)) throw new Refusal("the run's commit isn't a 40-hex SHA");
  // The issue's comments: for the run's commit (without --sha), and for the
  // run's own comment, which a post that failed or timed out may have left.
  const comments = readIssueComments(gh, issue);
  if (comments === null)
    throw new Refusal(`reading #${issue}'s comments failed (gh api): run again`);
  const out = path.join(runDir, UPLOAD_FILE);
  // The commit an earlier --yes of this run resolved comes before the issue's
  // newest marker, so priorUpload and the comment keep naming the commit the
  // run tested even after a newer head's scenario was posted.
  const commit = sha || recordedSha(readUpload(out), { issue, runId }) || scenarioShaFrom(comments);
  if (!commit) {
    throw new Refusal(`no scenario-sha marker on #${issue}'s comments: pass --sha <40-hex>`);
  }

  // Already on the issue: --yes only records it, never posts a second one.
  // Before the upload gate: recording publishes nothing, so a gate closed
  // since the post (the switch off, a failed selftest) must not block it.
  const landed = postedCommentFor(comments, runId);
  const landedUrl = typeof landed?.html_url === "string" ? landed.html_url : "";
  if (landed && !yes) {
    print(`This run's comment is already on #${issue}${landedUrl ? `: ${landedUrl}` : ""}.`);
    print(`Running again with --yes only records it in ${POSTED_FILE}; nothing is published`);
    print(`or posted again. To withdraw a screenshot, follow the factory runbook's`);
    print(`"Taking a screenshot down".`);
    return { listed: true, posted: true, url: landedUrl };
  }
  if (landed) {
    const uploaded = readUpload(out)?.ok === true;
    recordPosted(runDir, { issue, sha: commit, runId, url: landedUrl, upload: uploaded });
    print(
      `Already posted on #${issue}${landedUrl ? `: ${landedUrl}` : ""} (recorded; nothing posted again)`,
    );
    return { posted: true, url: landedUrl, upload: uploaded, reason: null, already: true };
  }

  const gate = uploadGate({ env, withheld: false, logDir });
  if (gate) throw new Refusal(`screenshots can't be published: ${gate}`);

  // What an earlier --yes published is what this one posts, whatever shots/
  // holds now: the listing shows it, and --yes posts that very record.
  const prior = priorUpload({ issue, sha: commit, runId, out, repoRoot, ...(git ? { git } : {}) });
  if (prior && prior.ok !== true) {
    throw new Refusal(
      yes
        ? `publishing the screenshots failed (${prior.reason}); nothing was posted: run again to retry`
        : `GitHub couldn't be asked whether this run's screenshots are already published ` +
            `(${prior.reason}): run again`,
    );
  }
  const ocr = ocrBin || defaultOcr(logDir, repoRoot);

  if (!yes) {
    if (prior) {
      listPrior({ prior, runDir, issue, commit, report, out, print });
      return {
        listed: true,
        publish: prior.images.length,
        keep: prior.overflow.length,
        published: true,
      };
    }
    const selection = prepareRun({
      source: "macos",
      evidenceDir: shotsDir,
      ocrBin: ocr,
      secrets: {},
      deps,
    });
    if (!selection.ok) throw new Refusal(`screenshots can't be published: ${selection.reason}`);
    print(`Would post the report of ${runDir} on #${issue} (commit ${commit.slice(0, 12)}), with:`);
    for (const u of selection.upload) print(`  publish  ${u.path}`);
    for (const o of selection.overflow) print(`  keep     ${o.path} (${o.why})`);
    if (!selection.upload.length) print("  (no screenshot to publish)");
    print("");
    print("Look at each file first: an early shot can show your own account's notes");
    print("(a run starts by signing it out). The report as it would be posted:");
    print("");
    print(reportText(report));
    print("");
    print("Run again with --yes to publish the screenshots and post the comment.");
    return { listed: true, publish: selection.upload.length, keep: selection.overflow.length };
  }

  // Published first. A failed upload posts nothing, so the operator can
  // simply retry, and the retry reuses what got published (priorUpload).
  const upload = prior
    ? withShotLabels(prior, shotsDir)
    : uploadRun({
        issue,
        sha: commit,
        runId,
        source: "macos",
        evidenceDir: shotsDir,
        out,
        logDir,
        repoRoot,
        withheld: false,
        ocrBin: ocr,
        env,
        ...(git ? { git } : {}),
        deps,
      });
  if (upload.ok !== true) {
    throw new Refusal(
      `publishing the screenshots failed (${upload.reason ?? "error"}); nothing was posted: run again to retry`,
    );
  }
  const { body } = composeComment({ report, upload, results, shotsDir, runId });
  const hits = scanLaneText(body, {});
  if (hits.length)
    throw new Refusal(`the composed comment matched a secret pattern (${hits.join(", ")})`);
  const tmp = nodeFs.mkdtempSync(path.join(os.tmpdir(), "factory-macos-post-"));
  try {
    const file = path.join(tmp, "comment.md");
    nodeFs.writeFileSync(file, body, { mode: 0o600 });
    const r = gh(["issue", "comment", issue, "--repo", REPO, "--body-file", file]);
    if (r.code !== 0) {
      throw new Refusal(
        "posting the comment failed (gh issue comment): run again to retry " +
          "(it checks the issue first, so a comment that did land isn't posted twice)",
      );
    }
    const url = (r.stdout.trim().split("\n").at(-1) ?? "").trim();
    recordPosted(runDir, { issue, sha: commit, runId, url, upload: upload.ok === true });
    print(`Posted on #${issue}${url ? `: ${url}` : ""}`);
    return { posted: true, url, upload: upload.ok === true, reason: upload.reason ?? null };
  } finally {
    nodeFs.rmSync(tmp, { recursive: true, force: true });
  }
}

// A record read back from the ref has no labels (its tree holds only
// NN.png): take each one's from the run's own shot of that number, so the
// comment still puts it under its step, as publishRun's reuse does. A number
// with two shots gets no label: the ref doesn't say which of them was
// published, so the image goes under "Other screenshots", never under a step
// it may not show.
function withShotLabels(record, shotsDir) {
  const labels = new Map();
  for (const e of macosManifest(shotsDir)) {
    labels.set(e.slot, labels.has(e.slot) ? null : e.label);
  }
  return {
    ...record,
    images: record.images.map((i) => {
      const label = labels.get(i.n);
      return i.label || !label ? i : { ...i, label };
    }),
  };
}

function recordPosted(runDir, record) {
  nodeFs.writeFileSync(path.join(runDir, POSTED_FILE), `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  });
}

// The listing once an earlier --yes has published the run's screenshots.
function listPrior({ prior, runDir, issue, commit, report, out, print }) {
  print(
    `Would post the report of ${runDir} on #${issue} (commit ${commit.slice(0, 12)}), with ` +
      `what an earlier --yes already published${prior.commit ? ` on ${prior.ref}` : ""}:`,
  );
  for (const i of prior.images) print(`  published  ${i.local ?? i.url}`);
  for (const o of prior.overflow) print(`  kept     ${o.path} (${o.why})`);
  if (prior.images.length === 0) print("  (no screenshot was published)");
  print("");
  print("Moving a file out of shots/ no longer changes what is posted. To withdraw one, take");
  print(`it down first (the factory runbook's "Taking a screenshot down"), delete ${out},`);
  print("and list again. The report as it would be posted:");
  print("");
  print(reportText(report));
  print("");
  print("Run again with --yes to post the comment.");
}

export function main(argv, deps = {}) {
  const [cmd, ...rest] = argv;
  if (cmd !== "macos") {
    throw new UsageError(
      "usage: evidence-post.mjs macos --run-dir <dir> --issue <n> [--sha <40-hex>] [--yes]",
    );
  }
  // --yes takes no value; parseFlags needs one for every flag.
  const yes = rest.includes("--yes");
  const { flags } = parseFlags(rest.filter((a) => a !== "--yes"));
  const runDir = flags["run-dir"];
  if (!runDir) throw new UsageError("--run-dir required");
  const issue = flags.issue;
  if (!ISSUE_RE.test(issue ?? "")) throw new UsageError("--issue <n> required");
  const repoRoot = path.resolve(flags["repo-root"] ?? DEFAULT_REPO_ROOT);
  const logDir = path.resolve(flags["log-dir"] ?? path.join(repoRoot, "logs", "factory"));
  return postMacosRun({
    runDir: path.resolve(runDir),
    issue,
    sha: flags.sha ?? "",
    yes,
    logDir,
    repoRoot,
    ocrBin: flags.ocr ? path.resolve(flags.ocr) : "",
    ...deps,
  });
}

if (isMainModule(import.meta.url)) {
  try {
    main(process.argv.slice(2));
    process.exit(0);
  } catch (err) {
    process.stderr.write(`evidence-post: ${err.message}\n`);
    process.exit(err instanceof UsageError || /^Missing value for --/.test(err.message) ? 2 : 1);
  }
}
