#!/usr/bin/env node
// Publishes one factory test run's screenshots where a public GitHub comment
// can show them, so the person at Testing / In Test sees each step without
// logging in to the Mac mini (ADR-0072, which supersedes ADR-0051's "never
// attached to GitHub").
//
// GitHub has no API for comment attachments, so the images become git objects
// in this repo: one parentless commit per run, holding
// `<issue>/<sha12>/<run-id>/NN.png|jpg`, on a ref outside refs/heads and
// refs/tags: `refs/factory-evidence/<issue>/<sha12>/<run-id>`. No workflow
// triggers on it, Vercel only builds branches, and a default clone or fetch
// never downloads it. Comments embed the images by
// `https://raw.githubusercontent.com/<repo>/<commit>/<path>`, pinned to the
// evidence commit, so a later push can't change what a report shows. The ref
// name is the idempotency key: a retry for the same issue + head + run reuses
// the run's upload.json, or the commit already on the ref, and never pushes
// twice.
//
// This runs in the factory's own node, after the runner has exited and after
// the report's secret scan has passed — never inside a claude session (the
// browser runner still has no gh, and no Bash but ADR-0073's dev-inspect).
// The commit is built with git plumbing on a temp index (no checkout, no
// hooks, no filters, a fixed message) and pushed with a create-only lease,
// like plan-probe.mjs's probe branch. Each image has been through evidence-images.mjs first (provenance,
// file checks, an OCR secret scan, the per-comment cap).
//
// Nothing is published until `selftest` has shown, on the real repo, that
// GitHub accepts the ref, serves the image to an anonymous request with an
// image content type, and that Vercel started no deployment for it (a check
// that couldn't ask GitHub doesn't count). Every
// failure is a reason, never a thrown error: the report is then posted as
// before, saying the screenshots stayed on the Mac mini and why. Evidence,
// never a gate: nothing here moves a card.
//
// CLI (each command prints one JSON line):
//   node evidence-upload.mjs selftest --log-dir <dir> --repo-root <dir> [--status 1]
//     Pushes a parentless commit with a small PNG to
//     refs/factory-evidence/selftest/<epoch>, fetches its raw URL with no
//     credentials, checks status, content type and bytes, and asks the
//     Deployments API whether Vercel started a build for it. Writes
//     <log-dir>/evidence-selftest.json {ok, commit, ref, url, served,
//     deployment, at[, reason]}. --status 1 re-checks the recorded commit's
//     deployments and updates the record (a deployment found turns ok off).
//     Exit 0 iff ok.
//   node evidence-upload.mjs upload --issue <n> --sha <40-hex> --run-id <id>
//        --evidence-dir <dir> --source browser --guard-log <session.jsonl|"">
//        | --source macos   (shots/NN-<label>.png in --evidence-dir)
//        --render-json <file> --account-file <f|""> --ocr <bin|"">
//        [--bypass-file <f>] [--signin-key-file <f>]
//        --log-dir <dir> --repo-root <dir> --out <upload.json>
//     Refuses (ok false, nothing pushed) when FACTORY_EVIDENCE_UPLOAD=0, when
//     --render-json says the report (or its browser lane, or the composed
//     body) was withheld or can't be read, when the selftest hasn't passed, or
//     when the OCR helper or a given secret file can't be used (each image's
//     OCR text is scanned for the password, the bypass secret and the dev
//     service-role key it names, as well as the patterns). Writes
//     --out (mode 600): {ok, issue, sha, runId, ref, commit, images: [{n,
//     url, local, name[, label]}], overflow: [{n, path, why}]} or {ok: false,
//     reason}. Exit 0 either way; 2 on a usage error.

import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  browserManifest,
  helperOcr,
  macosManifest,
  ocrAvailable,
  selectImages,
} from "./evidence-images.mjs";
import { isMainModule } from "./is-main.mjs";
import { parseFlags } from "./parse-flags.mjs";
import { REPO, previewStateForSha, pushRef, remoteRefSha } from "./plan-probe.mjs";
import { readSecretValue } from "./verify-report.mjs";

export { REPO };
export const EVIDENCE_REF_PREFIX = "refs/factory-evidence/";
export const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/`;
export const SELFTEST_FILE = "evidence-selftest.json";
export const UPLOAD_FILE = "upload.json";
export const SWITCH_ENV = "FACTORY_EVIDENCE_UPLOAD";
// <kind>-<stamp>: intest-20261110T051950, verify-…, macos-20261110-051950.
export const RUN_ID_RE = /^[a-z][a-z0-9]*-[0-9A-Za-z][0-9A-Za-z_-]{0,47}$/;
export const SOURCES = Object.freeze(["browser", "macos"]);

// A 1×1 PNG: the selftest's image.
export const SELFTEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const SHA_RE = /^[0-9a-f]{40}$/;
const ISSUE_RE = /^[1-9][0-9]{0,6}$/;
const FETCH_TRIES = 6;
const FETCH_WAIT_MS = 5000;
const DEPLOY_CHECKS = 4;
const DEPLOY_WAIT_MS = 15_000;

export const commitMessage = (issue) =>
  `chore(factory): test-run screenshots for #${issue} (evidence, not for merge)`;
export const SELFTEST_MESSAGE = "chore(factory): evidence upload self-test (not for merge)";

export function evidenceRef(issue, sha, runId) {
  return `${EVIDENCE_REF_PREFIX}${issue}/${sha.slice(0, 12)}/${runId}`;
}

export function imagePath(issue, sha, runId, slot, ext) {
  return `${issue}/${sha.slice(0, 12)}/${runId}/${String(slot).padStart(2, "0")}.${ext}`;
}

export function rawUrl(commit, rel) {
  return `${RAW_BASE}${commit}/${rel}`;
}

// ── git ─────────────────────────────────────────────────────────────────────

/** git in <repoRoot>, never prompting: {code, stdout, stderr}. */
export function defaultGit(repoRoot) {
  return (args, { input, env } = {}) => {
    const r = spawnSync("git", args, {
      cwd: repoRoot,
      input,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

// Never quotes git's stderr: a push error can echo the remote's URL.
function gitOk(git, args, opts, what) {
  const r = git(args, opts);
  if (r.code !== 0) throw new Error(`${what} failed`);
  return r.stdout.trim();
}

/**
 * A parentless commit holding exactly <files> ([{path, data}]), built on a
 * temp index: nothing is checked out, no hook or .gitattributes filter runs,
 * and the message is fixed.
 */
export function buildEvidenceCommit({ git, files, message, tmpRoot = os.tmpdir() }) {
  const dir = nodeFs.mkdtempSync(path.join(tmpRoot, "factory-evidence-index-"));
  const env = { GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    gitOk(git, ["read-tree", "--empty"], { env }, "read-tree");
    for (const f of files) {
      const blob = gitOk(
        git,
        ["hash-object", "-w", "--no-filters", "--stdin"],
        { input: f.data, env },
        "hash-object",
      );
      gitOk(
        git,
        ["update-index", "--add", "--cacheinfo", `100644,${blob},${f.path}`],
        { env },
        "update-index",
      );
    }
    const tree = gitOk(git, ["write-tree"], { env }, "write-tree");
    return gitOk(git, ["commit-tree", tree, "-m", message], { env }, "commit-tree");
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The paths in <commit>'s tree, fetching <ref> once if it isn't local. null on error. */
export function commitPaths(git, commit, ref) {
  const list = () => git(["ls-tree", "-r", "--name-only", commit]);
  let r = list();
  if (r.code !== 0) {
    git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", ref]);
    r = list();
  }
  if (r.code !== 0) return null;
  return r.stdout.split("\n").filter(Boolean);
}

// ── files ───────────────────────────────────────────────────────────────────

function readJson(file) {
  try {
    return JSON.parse(nodeFs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writePrivate(file, value) {
  nodeFs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  nodeFs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  nodeFs.chmodSync(tmp, 0o600);
  nodeFs.renameSync(tmp, file);
}

export function selftestFile(logDir) {
  return path.join(logDir, SELFTEST_FILE);
}

/** Whether a render's JSON line says its report must not carry images. */
export function renderWithheld(json) {
  if (json === null || typeof json !== "object") return true;
  if (json.withheld === true) return true;
  if (json.withheld && typeof json.withheld === "object" && json.withheld.browser === true) {
    return true;
  }
  const hits = Array.isArray(json.secretHits) ? json.secretHits : [];
  return hits.some((h) => typeof h === "string" && h.startsWith("body:"));
}

// ── selftest ────────────────────────────────────────────────────────────────

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchServed(url, expected, { fetchImpl, sleep, tries, waitMs }) {
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(waitMs);
    try {
      const res = await fetchImpl(url, {
        redirect: "follow",
        credentials: "omit",
        signal: AbortSignal.timeout(20_000),
      });
      const type = String(res.headers.get("content-type") ?? "").toLowerCase();
      if (res.status !== 200) continue;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!type.startsWith("image/")) return { served: false, why: "content-type" };
      return bytes.equals(expected) ? { served: true } : { served: false, why: "bytes" };
    } catch {
      // try again
    }
  }
  return { served: false, why: "status" };
}

// "none" (no Vercel deployment for the commit), "found:<state>", or "unknown".
function deploymentOf(commit, gh) {
  const st = previewStateForSha(commit, gh ? { gh } : undefined);
  if (st.state === "pending") return "none";
  if (st.state === "unknown") return "unknown";
  return `found:${st.state}`;
}

/**
 * The one-time check that publishing works on the real repo. Never throws:
 * every outcome is recorded.
 */
export async function selftest({
  logDir,
  repoRoot,
  git = defaultGit(repoRoot),
  gh,
  fetchImpl = globalThis.fetch,
  sleep = sleepDefault,
  now = () => new Date(),
  fetchTries = FETCH_TRIES,
  fetchWaitMs = FETCH_WAIT_MS,
  deployChecks = DEPLOY_CHECKS,
  deployWaitMs = DEPLOY_WAIT_MS,
}) {
  const at = now().toISOString();
  const epoch = String(Math.floor(now().getTime() / 1000));
  const ref = `${EVIDENCE_REF_PREFIX}selftest/${epoch}`;
  const rel = `selftest/${epoch}.png`;
  const record = { ok: false, commit: null, ref, url: null, served: false, deployment: null, at };
  try {
    const commit = buildEvidenceCommit({
      git,
      files: [{ path: rel, data: SELFTEST_PNG }],
      message: SELFTEST_MESSAGE,
    });
    record.commit = commit;
    record.url = rawUrl(commit, rel);
    if (!pushRef(git, ref, commit, "") || remoteRefSha(git, ref) !== commit) {
      record.reason = "push";
    } else {
      const served = await fetchServed(record.url, SELFTEST_PNG, {
        fetchImpl,
        sleep,
        tries: fetchTries,
        waitMs: fetchWaitMs,
      });
      record.served = served.served;
      if (!served.served) record.reason = `not-served:${served.why}`;
      let deployment = "unknown";
      for (let i = 0; i < deployChecks; i++) {
        if (i > 0) await sleep(deployWaitMs);
        deployment = deploymentOf(commit, gh);
        if (deployment.startsWith("found:")) break;
      }
      record.deployment = deployment;
      if (deployment.startsWith("found:")) record.reason = "vercel-deployment";
      else if (deployment !== "none") record.reason = record.reason ?? "deployment-unknown";
      // Only a check that saw no deployment counts: "unknown" fails closed
      // (selftest --status can clear it later).
      record.ok = record.served && deployment === "none";
    }
  } catch {
    record.reason = record.reason ?? "error";
  }
  writePrivate(selftestFile(logDir), record);
  return record;
}

/**
 * Re-check the recorded selftest commit's deployments. ok is recomputed: the
 * image was served and this check saw no deployment. A deployment found
 * turns it off for good (the operator decides what to do, see the runbook).
 */
export function selftestStatus({ logDir, gh, now = () => new Date() }) {
  const record = readJson(selftestFile(logDir));
  if (!record || typeof record !== "object") return { ok: false, reason: "selftest-missing" };
  if (!SHA_RE.test(String(record.commit ?? ""))) return record;
  const deployment = deploymentOf(record.commit, gh);
  const next = { ...record, deployment, statusAt: now().toISOString() };
  const seenBefore = String(record.deployment ?? "").startsWith("found:");
  if (deployment.startsWith("found:") || seenBefore) {
    next.ok = false;
    next.reason = "vercel-deployment";
    if (seenBefore && !deployment.startsWith("found:")) next.deployment = record.deployment;
  } else if (deployment === "none" && record.served === true) {
    next.ok = true;
    delete next.reason;
  } else {
    next.ok = false;
    next.reason = record.served === true ? "deployment-unknown" : (record.reason ?? "not-served");
  }
  writePrivate(selftestFile(logDir), next);
  return next;
}

// ── upload ──────────────────────────────────────────────────────────────────

/**
 * The gates every upload passes first, in order: the switch, the report's
 * scan, the selftest. null when the upload may go ahead, else the reason.
 */
export function uploadGate({ env = process.env, withheld, logDir }) {
  // Unset or "1" is on; anything else is off, as factory-agent.sh reads it.
  const sw = env[SWITCH_ENV];
  if (sw !== undefined && sw !== "1") return "off";
  if (withheld) return "withheld";
  const record = readJson(selftestFile(logDir));
  if (!record) return "selftest-missing";
  if (record.ok !== true) return "selftest-failed";
  return null;
}

/** The run's screenshots, picked and checked (evidence-images.mjs). */
export function prepareRun({ source, evidenceDir, guardLog, ocrBin, secrets, deps = {} }) {
  let entries;
  if (source === "browser") {
    let text;
    try {
      text = nodeFs.readFileSync(guardLog, "utf8");
    } catch {
      return { ok: false, reason: "no-session" };
    }
    entries = browserManifest(text);
  } else {
    entries = macosManifest(evidenceDir);
  }
  const ocr = deps.ocr ?? (ocrAvailable(ocrBin) ? helperOcr(ocrBin) : null);
  // A browser run's screenshots are published unattended, so one showing an
  // email address stays on the Mac mini. A macOS run's aren't held for that:
  // the desktop sidebar shows the signed-in account's email on every screen,
  // and evidence-post.mjs publishes only after the operator looked at each.
  const holdEmails = source !== "macos";
  return selectImages({ root: evidenceDir, entries, ocr, secrets, holdEmails });
}

function overflowOut(selection) {
  return (selection.overflow ?? []).map((o) => ({ n: o.slot, path: o.path, why: o.why }));
}

/**
 * Commit and push a prepared selection on its run's ref, or reuse what is
 * already there. Returns the upload record ({ok: true, …} or {ok: false,
 * reason}).
 */
export function publishRun({ issue, sha, runId, selection, git }) {
  const ref = evidenceRef(issue, sha, runId);
  const base = { issue, sha, runId, ref };
  const overflow = overflowOut(selection);
  const bySlot = new Map(selection.upload.map((u) => [u.slot, u]));
  const record = (commit, paths) => {
    const images = [];
    for (const rel of paths) {
      const m = /\/([0-9]{2,3})\.(png|jpg)$/.exec(rel);
      if (!m) continue;
      const n = Number(m[1]);
      const local = bySlot.get(n);
      images.push({
        n,
        url: rawUrl(commit, rel),
        local: local?.path ?? null,
        name: local?.name ?? null,
        ...(local?.label ? { label: local.label } : {}),
      });
    }
    images.sort((a, b) => a.n - b.n);
    return { ok: true, ...base, commit, images, overflow };
  };
  if (selection.upload.length === 0)
    return { ok: true, ...base, commit: null, images: [], overflow };

  const reuse = (commit) => {
    const paths = commitPaths(git, commit, ref);
    return paths ? record(commit, paths) : { ok: false, ...base, reason: "remote", overflow };
  };
  const existing = remoteRefSha(git, ref);
  if (existing === null) return { ok: false, ...base, reason: "remote", overflow };
  if (SHA_RE.test(existing)) return reuse(existing);

  const files = selection.upload.map((u) => ({
    path: imagePath(issue, sha, runId, u.slot, u.ext),
    data: u.data,
  }));
  const commit = buildEvidenceCommit({ git, files, message: commitMessage(issue) });
  if (!pushRef(git, ref, commit, "")) {
    // Lost a race, or the push failed: only a commit already on the ref counts.
    const after = remoteRefSha(git, ref);
    if (after && SHA_RE.test(after)) return reuse(after);
    return { ok: false, ...base, reason: "push", overflow };
  }
  return record(
    commit,
    files.map((f) => f.path),
  );
}

/** Whether <record> is a successful upload record of this very run. */
function isRunRecord(record, { issue, sha, runId }) {
  return (
    record?.ok === true &&
    record.ref === evidenceRef(issue, sha, runId) &&
    record.issue === issue &&
    record.sha === sha &&
    record.runId === runId
  );
}

/**
 * What this run already published, which a retry posts again instead of the
 * files now in its evidence dir: the run's own upload.json (<out>), else the
 * commit already on its ref. The record ({ok: true, …, reused: true}) as
 * uploadRun returns it; images from the ref's tree carry no local path or
 * label. null when nothing is published for the run yet; {ok: false, reason:
 * "remote"} when GitHub can't be asked, or the ref's commit can't be read:
 * then nobody can say what is published, so a caller must not guess.
 */
export function priorUpload({ issue, sha, runId, out, repoRoot, git = defaultGit(repoRoot) }) {
  const ref = evidenceRef(issue, sha, runId);
  const base = { issue, sha, runId, ref };
  const prior = readJson(out);
  if (isRunRecord(prior, { issue, sha, runId })) {
    const list = (v) => (Array.isArray(v) ? v : []);
    return { ...prior, images: list(prior.images), overflow: list(prior.overflow), reused: true };
  }
  const existing = remoteRefSha(git, ref);
  if (existing === null) return { ok: false, ...base, reason: "remote", overflow: [] };
  if (!SHA_RE.test(existing)) return null;
  const paths = commitPaths(git, existing, ref);
  if (paths === null) return { ok: false, ...base, reason: "remote", overflow: [] };
  // The image paths, as publishRun's record reads them back.
  const images = paths.flatMap((rel) => {
    const m = /\/([0-9]{2,3})\.(?:png|jpg)$/.exec(rel);
    return m ? [{ n: Number(m[1]), url: rawUrl(existing, rel), local: null, name: null }] : [];
  });
  images.sort((a, b) => a.n - b.n);
  return { ok: true, ...base, commit: existing, images, overflow: [], reused: true };
}

/**
 * A run with nothing published yet: pick, check and OCR-scan its screenshots,
 * then publish them (publishRun). The literals each image's text is scanned
 * for are read like the report's own scan (verify-report.mjs): a file that is
 * given but can't be read fails closed, a file not given was never held.
 */
function selectAndPublish({
  issue,
  sha,
  runId,
  source,
  evidenceDir,
  guardLog,
  accountFile,
  bypassFile,
  signinKeyFile,
  ocrBin,
  git,
  deps,
}) {
  const literal = (file, key) => (file ? readSecretValue(file, key) : "");
  const password = literal(accountFile, "FACTORY_BROWSER_PASSWORD");
  const bypass = literal(bypassFile, "VERCEL_AUTOMATION_BYPASS_SECRET");
  const signinKey = literal(signinKeyFile, "DEV_SUPABASE_SERVICE_ROLE_KEY");
  if (password === null) return { ok: false, reason: "account-file" };
  if (bypass === null || signinKey === null) return { ok: false, reason: "secret-file" };
  const secrets = {};
  if (password) secrets.password = password;
  if (bypass) secrets.bypass = bypass;
  if (signinKey) secrets.signinKey = signinKey;
  const selection = prepareRun({ source, evidenceDir, guardLog, ocrBin, secrets, deps });
  return selection.ok
    ? publishRun({ issue, sha, runId, selection, git })
    : { ok: false, reason: selection.reason };
}

/**
 * The whole upload: gates, then what the run already published (its
 * upload.json, else its ref), else selection and publish.
 * Never throws for an expected failure; writes and returns the record.
 */
export function uploadRun({
  issue,
  sha,
  runId,
  source,
  evidenceDir,
  guardLog = "",
  out,
  logDir,
  repoRoot,
  withheld,
  accountFile = "",
  bypassFile = "",
  signinKeyFile = "",
  ocrBin = "",
  env = process.env,
  git = defaultGit(repoRoot),
  deps = {},
}) {
  const ref = evidenceRef(issue, sha, runId);
  let result;
  try {
    const gate = uploadGate({ env, withheld, logDir });
    const prior = readJson(out);
    if (gate) {
      result = { ok: false, reason: gate };
    } else if (isRunRecord(prior, { issue, sha, runId })) {
      // Already published by an earlier attempt: nothing is pushed again.
      return { ...prior, reused: true };
    } else {
      // Not in upload.json, but maybe on the run's ref (an attempt that pushed
      // and then lost its record). What is published is what a retry posts,
      // and it needs nothing local: the screenshots, the guard log, the OCR
      // helper or a secret file may be gone since. GitHub not answering fails
      // closed (reason "remote"), as publishRun does.
      result =
        priorUpload({ issue, sha, runId, out, repoRoot, git }) ??
        selectAndPublish({
          issue,
          sha,
          runId,
          source,
          evidenceDir,
          guardLog,
          accountFile,
          bypassFile,
          signinKeyFile,
          ocrBin,
          git,
          deps,
        });
    }
  } catch {
    result = { ok: false, reason: "error" };
  }
  try {
    writePrivate(out, result);
  } catch {
    // The caller reads the returned record; a missing file is a failed upload.
  }
  return result;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

class UsageError extends Error {}

function required(flags, name) {
  const v = flags[name];
  if (v == null || v === "") throw new UsageError(`--${name} required`);
  return v;
}

function present(flags, name) {
  if (!(name in flags)) throw new UsageError(`--${name} required (may be "")`);
  return flags[name];
}

async function cmdSelftest(flags, deps) {
  const logDir = required(flags, "log-dir");
  if (flags.status === "1") return selftestStatus({ logDir, gh: deps.gh });
  return selftest({ logDir, repoRoot: required(flags, "repo-root"), ...deps });
}

function cmdUpload(flags, deps) {
  const issue = required(flags, "issue");
  if (!ISSUE_RE.test(issue)) throw new UsageError(`invalid --issue: ${issue}`);
  const sha = required(flags, "sha");
  if (!SHA_RE.test(sha)) throw new UsageError("invalid --sha (40 hex)");
  const runId = required(flags, "run-id");
  if (!RUN_ID_RE.test(runId)) throw new UsageError(`invalid --run-id: ${runId}`);
  const source = required(flags, "source");
  if (!SOURCES.includes(source)) throw new UsageError(`invalid --source: ${source}`);
  const evidenceDir = path.resolve(required(flags, "evidence-dir"));
  // "" when the run left no session id: no manifest, so nothing is published.
  const guardLog = source === "browser" ? present(flags, "guard-log") : "";
  // A render whose JSON can't be read counts as withheld: fail closed.
  const withheld = renderWithheld(readJson(required(flags, "render-json")));
  const result = uploadRun({
    issue,
    sha,
    runId,
    source,
    evidenceDir,
    guardLog,
    out: required(flags, "out"),
    logDir: required(flags, "log-dir"),
    repoRoot: required(flags, "repo-root"),
    withheld,
    accountFile: present(flags, "account-file"),
    // Optional: the verification lanes' other secrets, scanned for when given.
    bypassFile: flags["bypass-file"] ?? "",
    signinKeyFile: flags["signin-key-file"] ?? "",
    ocrBin: present(flags, "ocr"),
    ...deps,
  });
  return {
    ok: result.ok,
    reason: result.reason ?? null,
    commit: result.commit ?? null,
    images: result.images?.length ?? 0,
    overflow: result.overflow?.length ?? 0,
    reused: result.reused === true,
  };
}

export async function main(argv, deps = {}) {
  const [cmd, ...rest] = argv;
  const { flags } = parseFlags(rest);
  if (cmd === "selftest") return cmdSelftest(flags, deps);
  if (cmd === "upload") return cmdUpload(flags, deps);
  throw new UsageError("usage: evidence-upload.mjs <selftest|upload> [flags]");
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((out) => {
      process.stdout.write(JSON.stringify(out) + "\n");
      const failedSelftest = process.argv[2] === "selftest" && out?.ok !== true;
      process.exit(failedSelftest ? 1 : 0);
    })
    .catch((err) => {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(err instanceof UsageError || /^Missing value for --/.test(err.message) ? 2 : 1);
    });
}
