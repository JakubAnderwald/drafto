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
// and is posted once per run: `posted.json` in the run dir records it.
//
// CLI:
//   node scripts/lib/evidence-post.mjs macos --run-dir <dir> --issue <n>
//        [--sha <40-hex>] [--yes] [--log-dir <dir>] [--repo-root <dir>] [--ocr <bin>]
//     --sha: the commit the run tested; default, the newest scenario-sha
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

import { COMMENT_MAX_CHARS, defangReport, truncateReport } from "./browser-report.mjs";
import { evidenceSection, readUpload } from "./evidence-embed.mjs";
import { ocrAvailable } from "./evidence-images.mjs";
import {
  REPO,
  RUN_ID_RE,
  UPLOAD_FILE,
  prepareRun,
  uploadGate,
  uploadRun,
} from "./evidence-upload.mjs";
import { ghTimeoutMs } from "./gh-timeout.mjs";
import { isMainModule } from "./is-main.mjs";
import { closeFences } from "./markdown-fence.mjs";
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
  const head = [
    HEADER,
    "",
    `Run \`${String(runId).replace(/[^A-Za-z0-9_-]/g, "")}\`, posted by the operator. ` +
      "It never moves the card.",
    "",
  ];
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
  const room = COMMENT_MAX_CHARS - assemble("").length - note.length - 4;
  return { body: assemble(truncateReport(text, room) + note), embedded: ev.embedded };
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
  runDir,
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
  const problem = runProblem(runDir, { env });
  if (problem) throw new Refusal(problem);
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

  let commit = sha;
  if (!commit) {
    const r = gh(["api", `repos/${REPO}/issues/${issue}/comments`, "--paginate"]);
    let comments = [];
    try {
      comments = r.code === 0 ? JSON.parse(r.stdout) : [];
    } catch {
      comments = [];
    }
    commit = scenarioShaFrom(comments) ?? "";
    if (!commit) {
      throw new Refusal(`no scenario-sha marker on #${issue}'s comments: pass --sha <40-hex>`);
    }
  }
  if (!SHA_RE.test(commit)) throw new Refusal("the run's commit isn't a 40-hex SHA");

  const gate = uploadGate({ env, withheld: false, logDir });
  if (gate) throw new Refusal(`screenshots can't be published: ${gate}`);
  const ocr = ocrBin || defaultOcr(logDir, repoRoot);

  if (!yes) {
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

  // Published first (idempotent: a retry reuses the run's upload.json or its
  // ref). A failed upload posts nothing, so the operator can simply retry.
  const upload = uploadRun({
    issue,
    sha: commit,
    runId,
    source: "macos",
    evidenceDir: shotsDir,
    out: path.join(runDir, UPLOAD_FILE),
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
    if (r.code !== 0) throw new Refusal("posting the comment failed (gh issue comment)");
    const url = (r.stdout.trim().split("\n").at(-1) ?? "").trim();
    nodeFs.writeFileSync(
      path.join(runDir, POSTED_FILE),
      `${JSON.stringify({ issue, sha: commit, runId, url, upload: upload.ok === true })}\n`,
      { mode: 0o600 },
    );
    print(`Posted on #${issue}${url ? `: ${url}` : ""}`);
    return { posted: true, url, upload: upload.ok === true, reason: upload.reason ?? null };
  } finally {
    nodeFs.rmSync(tmp, { recursive: true, force: true });
  }
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
