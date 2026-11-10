// evidence-upload.mjs is the only path from a factory test run's screenshots
// to the public repo (ADR-0072), so these tests lock in that it fails closed:
// the switch, a withheld or unreadable render, a missing or failed selftest,
// an unusable OCR helper and an unreadable account file each refuse before
// anything is pushed, and each refusal is written to upload.json as a reason
// instead of thrown (a failed upload never blocks a report or moves a card).
// They lock in the hosting shape the ADR's risk analysis rests on, too: one
// parentless commit with a fixed message, on a ref outside refs/heads and
// refs/tags (so Vercel never builds it and a default clone never fetches it),
// holding only slot-numbered images, embedded by raw URLs pinned to that
// commit, never a branch tip. A retry for the same issue + head + run never
// pushes twice. The selftest is held to the same bar: the image served to an
// anonymous request, as an image, byte for byte, and no Vercel deployment.
//
// No network and no OCR helper: origin is a temp bare repo, and fetch, gh,
// sleep and the OCR scan are stubs (CI runs these on Ubuntu).

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evidenceSection, localFooter } from "../lib/evidence-embed.mjs";
import { CAP_WHY, MAX_IMAGES, OFF_ORIGIN_WHY } from "../lib/evidence-images.mjs";
import {
  EVIDENCE_REF_PREFIX,
  RAW_BASE,
  SELFTEST_FILE,
  SELFTEST_MESSAGE,
  SELFTEST_PNG,
  SWITCH_ENV,
  UPLOAD_FILE,
  commitMessage,
  evidenceRef,
  imagePath,
  main,
  priorUpload,
  rawUrl,
  renderWithheld,
  selftest,
  selftestStatus,
  uploadGate,
  uploadRun,
} from "../lib/evidence-upload.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "..", "lib", "evidence-upload.mjs");

const ISSUE = "797";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA12 = "0123456789ab";
const RUN_ID = "intest-20261110T051950";
const RAW = "https://raw.githubusercontent.com/JakubAnderwald/drafto/";
const NOW = new Date("2026-11-10T05:19:50.000Z");
const EPOCH = String(Math.floor(NOW.getTime() / 1000));
const PASSWORD = "Corr3ct-Horse-Battery";
const DK_KEY = `dk_${"0123456789abcdef".repeat(3)}`;
const CLEAN_RENDER = { status: "completed", verdict: "pass", withheld: false, secretHits: [] };

const PNG = (tag) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`png:${tag}`),
  ]);
const JPG = (tag) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jpg:${tag}`)]);

// ── fixtures ────────────────────────────────────────────────────────────────

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "evidence-upload-"));
  roots.push(root);
  return root;
}

// The caller's git state (a hook's GIT_DIR, a global config that signs
// commits) and the upload switch never reach these repos.
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || k === SWITCH_ENV) continue;
    env[k] = v;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}

function gitIn(cwd, args, { input, env, buffer = false } = {}) {
  const r = spawnSync("git", args, {
    cwd,
    input,
    env: cleanEnv(env),
    ...(buffer ? {} : { encoding: "utf8" }),
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A work repo (identity configured) whose origin is <origin>, with a counting git runner. */
function workRepo(root, origin, name = "work") {
  const work = join(root, name);
  gitIn(root, ["init", "-q", work]);
  gitIn(work, ["config", "user.name", "Factory Test"]);
  gitIn(work, ["config", "user.email", "factory-test@example.com"]);
  gitIn(work, ["remote", "add", "origin", origin]);
  const calls = [];
  const git = (args, { input, env } = {}) => {
    calls.push(args);
    return gitIn(work, args, { input, env });
  };
  return { work, git, calls, pushes: () => calls.filter((a) => a.includes("push")).length };
}

function makeRepos(root = tempRoot()) {
  const origin = join(root, "origin.git");
  gitIn(root, ["init", "-q", "--bare", origin]);
  return { root, origin, ...workRepo(root, origin) };
}

/** Refs on origin: [{sha, ref}], all of them or those under <patterns>. */
function originRefs(origin, ...patterns) {
  return gitIn(origin, ["for-each-ref", "--format=%(objectname) %(refname)", ...patterns])
    .stdout.split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, ref] = l.split(" ");
      return { sha, ref };
    });
}
const evidenceRefs = (origin) => originRefs(origin, EVIDENCE_REF_PREFIX);

function commitOf(origin, commit) {
  const raw = gitIn(origin, ["cat-file", "-p", commit]).stdout;
  const cut = raw.indexOf("\n\n");
  const headers = raw.slice(0, cut).split("\n");
  return {
    parents: headers.filter((l) => l.startsWith("parent ")),
    message: raw.slice(cut + 2).trim(),
    paths: gitIn(origin, ["ls-tree", "-r", "--name-only", commit])
      .stdout.split("\n")
      .filter(Boolean),
  };
}

const blobOf = (origin, commit, rel) =>
  gitIn(origin, ["cat-file", "blob", `${commit}:${rel}`], { buffer: true }).stdout;

const modeOf = (file) => statSync(file).mode & 0o777;
const readJsonFile = (file) => JSON.parse(readFileSync(file, "utf8"));

/** One guard-copied screenshot: the name copyEvidence gives slot <n>. */
const shot = (n, ext = "png") => ({
  name: `screenshot-1731215990${String(n).padStart(3, "0")}-${n}.${ext}`,
  data: ext === "png" ? PNG(n) : JPG(n),
});

/**
 * A browser run: the evidence dir the guard copied into, and its session's
 * decision log. <shots>: a shot() for a copy (with offOrigin: true, one the
 * guard didn't see taken on the preview), {copyFailed: true} or
 * {rejected: true} for a slot the guard has no file for. The dir also holds
 * the runner's output and an image the log never mentions: neither may ever
 * be published.
 */
function browserRun(root, shots) {
  const evidenceDir = join(root, "run", "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "runner-output.txt"), "| 1 | Open /login | pass |\n");
  writeFileSync(join(evidenceDir, "screenshot-1731215999999-99.png"), PNG("unlisted"));
  const at = NOW.toISOString();
  const lines = [JSON.stringify({ at, event: "sessionStart" })];
  for (const s of shots) {
    let e;
    if (s.name) {
      writeFileSync(join(evidenceDir, s.name), s.data);
      e = { copied: s.name, onOrigin: !s.offOrigin };
    } else if (s.copyFailed) {
      e = { copyFailed: "ENOENT: no such file" };
    } else {
      e = { screenshotRejected: "the tab isn't on the preview origin" };
    }
    lines.push(JSON.stringify({ at, event: "pre", tool: "computer", allow: true, reason: "ok" }));
    lines.push(
      JSON.stringify({
        at,
        event: "post",
        tool: "computer",
        allow: null,
        reason: "ok",
        events: [e],
      }),
    );
  }
  const guardLog = join(root, "browser-guard", "0b7c6a51-3e4f-4a2b-9c1d-2e3f4a5b6c7d.jsonl");
  mkdirSync(dirname(guardLog), { recursive: true });
  writeFileSync(guardLog, `${lines.join("\n")}\n`);
  return { evidenceDir, guardLog };
}

function writeSelftest(logDir, over = {}) {
  mkdirSync(logDir, { recursive: true });
  const record = {
    ok: true,
    commit: "f".repeat(40),
    ref: `${EVIDENCE_REF_PREFIX}selftest/${EPOCH}`,
    url: `${RAW}${"f".repeat(40)}/selftest/${EPOCH}.png`,
    served: true,
    deployment: "none",
    at: NOW.toISOString(),
    ...over,
  };
  writeFileSync(join(logDir, SELFTEST_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** An OCR stub: every image reads as <textOf(data, ext)>; records what it scanned. */
function ocrStub(textOf = () => "Notebooks\nNew note\nSaved") {
  const seen = [];
  const ocr = (data, ext) => {
    seen.push({ data: Buffer.from(data), ext });
    return { ok: true, text: textOf(Buffer.from(data), ext) };
  };
  return { ocr, seen };
}

/**
 * Everything an upload needs: repos, a browser run, a log dir with a passing
 * selftest record (selftest: null for none), the render's JSON line (render:
 * an object, a raw string, or null for no file) and an OCR stub.
 */
function uploadFixture({
  shots = [shot(1), shot(2)],
  selftestRecord = {},
  render = CLEAN_RENDER,
  textOf,
} = {}) {
  const repos = makeRepos();
  const run = browserRun(repos.root, shots);
  const logDir = join(repos.root, "logs");
  mkdirSync(logDir, { recursive: true });
  if (selftestRecord) writeSelftest(logDir, selftestRecord);
  const renderJson = join(repos.root, "run", "render.json");
  if (render !== null) {
    writeFileSync(renderJson, typeof render === "string" ? render : `${JSON.stringify(render)}\n`);
  }
  return {
    ...repos,
    ...run,
    logDir,
    renderJson,
    out: join(repos.root, "run", UPLOAD_FILE),
    ocr: ocrStub(textOf),
  };
}

/** The upload CLI's argv; an override of undefined drops the flag. */
function uploadArgv(fx, over = {}) {
  const flags = {
    issue: ISSUE,
    sha: SHA,
    "run-id": RUN_ID,
    "evidence-dir": fx.evidenceDir,
    source: "browser",
    "guard-log": fx.guardLog,
    "render-json": fx.renderJson,
    "account-file": "",
    ocr: "",
    "log-dir": fx.logDir,
    "repo-root": fx.work,
    out: fx.out,
    ...over,
  };
  const argv = ["upload"];
  for (const [k, v] of Object.entries(flags)) if (v !== undefined) argv.push(`--${k}`, String(v));
  return argv;
}

function upload(fx, over = {}, { git = fx.git, env = {}, ocr = fx.ocr.ocr } = {}) {
  return main(uploadArgv(fx, over), { git, env, deps: ocr ? { ocr } : {} });
}

function assertNothingPushed(fx) {
  assert.deepEqual(evidenceRefs(fx.origin), []);
  assert.deepEqual(originRefs(fx.origin), []);
  assert.equal(fx.pushes(), 0);
}

// ── stubs for the selftest ──────────────────────────────────────────────────

const SERVED = { status: 200, type: "image/png", bytes: SELFTEST_PNG };

/** fetch: the i-th call gets responses[i] (the last one repeats); an Error is thrown. */
function fetchStub(responses = [SERVED]) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    const bytes = Buffer.from(r.bytes ?? []);
    return {
      status: r.status,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? (r.type ?? null) : null) },
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  return { fetchImpl, calls };
}

const VERCEL_DEPLOYMENT = {
  id: 41,
  creator: { login: "vercel[bot]" },
  created_at: "2026-11-10T05:20:10Z",
};

/**
 * gh: the Deployments API. <lists>: what the i-th deployments list returns
 * (the last one repeats); <statuses>: every deployment's statuses. fail: every
 * call fails, as when gh has no network.
 */
function ghStub({ lists = [[]], statuses = [], fail = false } = {}) {
  const calls = [];
  const listCalls = () => calls.filter((a) => /\/deployments\?/.test(a[1] ?? ""));
  const gh = (args) => {
    calls.push(args);
    if (fail) return { code: 1, stdout: "", stderr: "HTTP 502" };
    if (/\/statuses\?/.test(args[1] ?? "")) return { code: 0, stdout: JSON.stringify(statuses) };
    const n = listCalls().length;
    return { code: 0, stdout: JSON.stringify(lists[Math.min(n - 1, lists.length - 1)]) };
  };
  return { gh, calls, listCalls };
}

function selftestFixture() {
  const repos = makeRepos();
  return { ...repos, logDir: join(repos.root, "logs") };
}

function runSelftest(fx, { fetch = fetchStub(), gh = ghStub(), git = fx.git, ...more } = {}) {
  const sleeps = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
  };
  const result = main(["selftest", "--log-dir", fx.logDir, "--repo-root", fx.work], {
    git,
    gh: gh.gh,
    fetchImpl: fetch.fetchImpl,
    sleep,
    now: () => NOW,
    deployChecks: 3,
    ...more,
  });
  return { result, fetch, gh, sleeps };
}

const isUsageError = (re) => (err) => {
  assert.equal(err.constructor.name, "UsageError");
  assert.match(err.message, re);
  return true;
};

// ── names and URLs ──────────────────────────────────────────────────────────

describe("evidence names and URLs", () => {
  it("names the run's ref outside refs/heads and refs/tags, keyed by issue, short head and run", () => {
    const ref = evidenceRef(ISSUE, SHA, RUN_ID);
    assert.equal(ref, `refs/factory-evidence/797/${SHA12}/${RUN_ID}`);
    assert.ok(ref.startsWith(EVIDENCE_REF_PREFIX));
    assert.doesNotMatch(ref, /^refs\/(heads|tags)\//);
  });

  it("numbers each image by its slot, two digits", () => {
    assert.equal(imagePath(ISSUE, SHA, RUN_ID, 3, "jpg"), `797/${SHA12}/${RUN_ID}/03.jpg`);
    assert.equal(imagePath(ISSUE, SHA, RUN_ID, 12, "png"), `797/${SHA12}/${RUN_ID}/12.png`);
  });

  it("pins every URL to a commit of this repo on raw.githubusercontent.com", () => {
    const commit = "a".repeat(40);
    assert.equal(RAW_BASE, RAW);
    assert.equal(rawUrl(commit, "797/x/01.png"), `${RAW}${commit}/797/x/01.png`);
  });

  it("uses a fixed commit message that says the commit is not for merge", () => {
    assert.equal(
      commitMessage(ISSUE),
      "chore(factory): test-run screenshots for #797 (evidence, not for merge)",
    );
  });
});

// ── renderWithheld ──────────────────────────────────────────────────────────

describe("renderWithheld", () => {
  it("fails closed on a render JSON it can't read", () => {
    assert.equal(renderWithheld(null), true);
    assert.equal(renderWithheld(undefined), true);
    assert.equal(renderWithheld("withheld"), true);
    assert.equal(renderWithheld(0), true);
  });

  it("withholds a report the browser render withheld", () => {
    assert.equal(renderWithheld({ withheld: true, secretHits: ["jwt"] }), true);
    assert.equal(renderWithheld({ withheld: false, secretHits: [] }), false);
    assert.equal(renderWithheld({}), false);
  });

  it("withholds a verification report whose Web lane or composed body was withheld", () => {
    assert.equal(renderWithheld({ withheld: { shell: false, browser: true } }), true);
    assert.equal(
      renderWithheld({ withheld: { shell: false, browser: false }, secretHits: ["body:jwt"] }),
      true,
    );
  });

  it("doesn't withhold the Web lane's images for the shell lane's hits", () => {
    assert.equal(
      renderWithheld({ withheld: { shell: true, browser: false }, secretHits: ["shell:jwt"] }),
      false,
    );
  });

  it("ignores a secretHits that isn't a list of strings", () => {
    assert.equal(renderWithheld({ withheld: false, secretHits: "body:jwt" }), false);
    assert.equal(renderWithheld({ withheld: false, secretHits: [{ body: "jwt" }] }), false);
  });
});

// ── uploadGate ──────────────────────────────────────────────────────────────

describe("uploadGate", () => {
  it("checks the switch, then the render, then the selftest", () => {
    const logDir = join(tempRoot(), "logs");
    assert.equal(uploadGate({ env: { [SWITCH_ENV]: "0" }, withheld: true, logDir }), "off");
    assert.equal(uploadGate({ env: {}, withheld: true, logDir }), "withheld");
    assert.equal(uploadGate({ env: {}, withheld: false, logDir }), "selftest-missing");
    writeSelftest(logDir, { ok: false, reason: "not-served:status" });
    assert.equal(uploadGate({ env: {}, withheld: false, logDir }), "selftest-failed");
    writeSelftest(logDir);
    assert.equal(uploadGate({ env: {}, withheld: false, logDir }), null);
    assert.equal(uploadGate({ env: { [SWITCH_ENV]: "1" }, withheld: false, logDir }), null);
  });

  it("only counts a selftest whose ok is literally true", () => {
    const logDir = join(tempRoot(), "logs");
    writeSelftest(logDir, { ok: "true" });
    assert.equal(uploadGate({ env: {}, withheld: false, logDir }), "selftest-failed");
    writeFileSync(join(logDir, SELFTEST_FILE), "{not json");
    assert.equal(uploadGate({ env: {}, withheld: false, logDir }), "selftest-missing");
  });

  it("treats a switch value other than 0 or 1 as off, as factory-agent.sh does", () => {
    const logDir = join(tempRoot(), "logs");
    writeSelftest(logDir);
    for (const v of ["no", "false", "off", "", " 1"]) {
      assert.equal(uploadGate({ env: { [SWITCH_ENV]: v }, withheld: false, logDir }), "off", v);
    }
    assert.equal(uploadGate({ env: { [SWITCH_ENV]: "1" }, withheld: false, logDir }), null);
    assert.equal(uploadGate({ env: {}, withheld: false, logDir }), null, "unset is on");
  });
});

// ── selftest ────────────────────────────────────────────────────────────────

describe("selftest", () => {
  it("passes when the image is served anonymously, as an image, byte for byte, and Vercel built nothing", async () => {
    const fx = selftestFixture();
    const { result, fetch, gh } = runSelftest(fx);
    const record = await result;
    const ref = `refs/factory-evidence/selftest/${EPOCH}`;
    assert.match(record.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(record, {
      ok: true,
      commit: record.commit,
      ref,
      url: `${RAW}${record.commit}/selftest/${EPOCH}.png`,
      served: true,
      deployment: "none",
      at: NOW.toISOString(),
    });

    // The record: mode 600, at <log-dir>/evidence-selftest.json.
    const file = join(fx.logDir, "evidence-selftest.json");
    assert.deepEqual(readJsonFile(file), record);
    assert.equal(modeOf(file), 0o600);

    // On origin: only the selftest ref, at a parentless commit holding the PNG.
    assert.deepEqual(originRefs(fx.origin), [{ sha: record.commit, ref }]);
    const c = commitOf(fx.origin, record.commit);
    assert.deepEqual(c.parents, []);
    assert.equal(c.message, SELFTEST_MESSAGE);
    assert.deepEqual(c.paths, [`selftest/${EPOCH}.png`]);
    assert.ok(blobOf(fx.origin, record.commit, `selftest/${EPOCH}.png`).equals(SELFTEST_PNG));

    // Fetched once, by the pinned URL, with no credentials of any kind.
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].url, record.url);
    assert.equal(fetch.calls[0].opts.credentials, "omit");
    assert.equal(new Headers(fetch.calls[0].opts.headers ?? {}).has("authorization"), false);
    assert.equal(new Headers(fetch.calls[0].opts.headers ?? {}).has("cookie"), false);

    // Asked the Deployments API about this commit, every check.
    assert.equal(gh.listCalls().length, 3);
    for (const args of gh.listCalls()) {
      assert.match(args[1], new RegExp(`deployments\\?sha=${record.commit}&`));
    }
  });

  for (const [what, responses, why] of [
    [
      "different bytes",
      [{ status: 200, type: "image/png", bytes: Buffer.concat([SELFTEST_PNG, Buffer.from("x")]) }],
      "bytes",
    ],
    [
      "a text/plain content type",
      [{ status: 200, type: "text/plain", bytes: SELFTEST_PNG }],
      "content-type",
    ],
    ["no content type", [{ status: 200, bytes: SELFTEST_PNG }], "content-type"],
    [
      "404 on every try",
      [{ status: 404, type: "text/plain", bytes: Buffer.from("404") }],
      "status",
    ],
    ["a network error on every try", [new Error("ECONNRESET")], "status"],
  ]) {
    it(`fails when raw.githubusercontent.com answers with ${what}`, async () => {
      const fx = selftestFixture();
      const record = await runSelftest(fx, { fetch: fetchStub(responses) }).result;
      assert.equal(record.ok, false);
      assert.equal(record.served, false);
      assert.equal(record.reason, `not-served:${why}`);
      // The deployment is still checked and recorded.
      assert.equal(record.deployment, "none");
      assert.deepEqual(readJsonFile(join(fx.logDir, SELFTEST_FILE)), record);
      assert.equal(modeOf(join(fx.logDir, SELFTEST_FILE)), 0o600);
    });
  }

  it("retries a URL that isn't served yet, waiting between tries", async () => {
    const fx = selftestFixture();
    const fetch = fetchStub([{ status: 404 }, new Error("ETIMEDOUT"), SERVED]);
    const { result, sleeps } = runSelftest(fx, { fetch, fetchWaitMs: 1234 });
    const record = await result;
    assert.equal(record.ok, true);
    assert.equal(fetch.calls.length, 3);
    assert.deepEqual(
      sleeps.filter((ms) => ms === 1234),
      [1234, 1234],
    );
  });

  it("gives up after its tries on a URL that is never served", async () => {
    const fx = selftestFixture();
    const fetch = fetchStub([{ status: 404 }]);
    const record = await runSelftest(fx, { fetch, fetchTries: 4 }).result;
    assert.equal(record.reason, "not-served:status");
    assert.equal(fetch.calls.length, 4);
  });

  it("fails when Vercel started a deployment for the commit", async () => {
    const fx = selftestFixture();
    const gh = ghStub({ lists: [[VERCEL_DEPLOYMENT]], statuses: [] });
    const record = await runSelftest(fx, { gh }).result;
    assert.equal(record.ok, false);
    assert.equal(record.served, true);
    assert.equal(record.deployment, "found:building");
    assert.equal(record.reason, "vercel-deployment");
    // A deployment found ends the checks.
    assert.equal(gh.listCalls().length, 1);
    assert.deepEqual(readJsonFile(join(fx.logDir, SELFTEST_FILE)), record);
  });

  it("records a failed Vercel build as a deployment too", async () => {
    const fx = selftestFixture();
    const gh = ghStub({ lists: [[VERCEL_DEPLOYMENT]], statuses: [{ state: "failure" }] });
    const record = await runSelftest(fx, { gh }).result;
    assert.equal(record.ok, false);
    assert.equal(record.deployment, "found:failed");
    assert.equal(record.reason, "vercel-deployment");
  });

  it("keeps checking for a deployment Vercel starts late", async () => {
    const fx = selftestFixture();
    const gh = ghStub({ lists: [[], [VERCEL_DEPLOYMENT]] });
    const { result, sleeps } = runSelftest(fx, { gh, deployWaitMs: 999 });
    const record = await result;
    assert.equal(record.ok, false);
    assert.equal(record.deployment, "found:building");
    assert.equal(gh.listCalls().length, 2);
    assert.ok(sleeps.includes(999));
  });

  it("ignores deployments that aren't Vercel's", async () => {
    const fx = selftestFixture();
    const gh = ghStub({
      lists: [[{ ...VERCEL_DEPLOYMENT, creator: { login: "github-actions[bot]" } }]],
    });
    const record = await runSelftest(fx, { gh }).result;
    assert.equal(record.ok, true);
    assert.equal(record.deployment, "none");
  });

  it('records "unknown" when the Deployments API can\'t be asked', async () => {
    const fx = selftestFixture();
    const record = await runSelftest(fx, { gh: ghStub({ fail: true }) }).result;
    assert.equal(record.deployment, "unknown");
    assert.equal(record.served, true);
    assert.deepEqual(readJsonFile(join(fx.logDir, SELFTEST_FILE)), record);
  });

  it("doesn't pass when it never learnt whether Vercel deployed the commit", async () => {
    const fx = selftestFixture();
    const record = await runSelftest(fx, { gh: ghStub({ fail: true }) }).result;
    assert.equal(record.ok, false);
    assert.equal(record.served, true);
    assert.equal(record.deployment, "unknown");
    assert.equal(record.reason, "deployment-unknown");
    // selftest --status clears it once a check sees no deployment.
    const status = selftestStatus({ logDir: fx.logDir, gh: ghStub().gh });
    assert.equal(status.ok, true);
    assert.equal(status.deployment, "none");
    assert.equal(status.reason, undefined);
  });

  it("fails without fetching anything when the push is rejected", async () => {
    const fx = selftestFixture();
    const git = (args, opts) =>
      args.includes("push") ? { code: 1, stdout: "", stderr: "rejected" } : fx.git(args, opts);
    const { result, fetch, gh } = runSelftest(fx, { git });
    const record = await result;
    assert.equal(record.ok, false);
    assert.equal(record.reason, "push");
    assert.equal(record.served, false);
    assert.equal(record.deployment, null);
    assert.equal(fetch.calls.length, 0);
    assert.equal(gh.calls.length, 0);
    assert.deepEqual(originRefs(fx.origin), []);
    assert.equal(modeOf(join(fx.logDir, SELFTEST_FILE)), 0o600);
  });

  it("records a git failure instead of throwing", async () => {
    const fx = selftestFixture();
    const git = (args, opts) =>
      args[0] === "write-tree" ? { code: 128, stdout: "", stderr: "boom" } : fx.git(args, opts);
    const record = await runSelftest(fx, { git }).result;
    assert.equal(record.ok, false);
    assert.equal(record.reason, "error");
    assert.equal(record.commit, null);
    assert.deepEqual(readJsonFile(join(fx.logDir, SELFTEST_FILE)), record);
  });

  it("can be called directly as well as through main", async () => {
    const fx = selftestFixture();
    const record = await selftest({
      logDir: fx.logDir,
      repoRoot: fx.work,
      git: fx.git,
      gh: ghStub().gh,
      fetchImpl: fetchStub().fetchImpl,
      sleep: async () => {},
      now: () => NOW,
    });
    assert.equal(record.ok, true);
    assert.equal(record.ref, `refs/factory-evidence/selftest/${EPOCH}`);
  });
});

describe("selftestStatus", () => {
  it("says selftest-missing, and writes nothing, when there is no record", async () => {
    const logDir = join(tempRoot(), "logs");
    const gh = ghStub();
    assert.deepEqual(selftestStatus({ logDir, gh: gh.gh }), {
      ok: false,
      reason: "selftest-missing",
    });
    assert.deepEqual(
      await main(["selftest", "--log-dir", logDir, "--status", "1"], { gh: gh.gh }),
      {
        ok: false,
        reason: "selftest-missing",
      },
    );
    assert.equal(existsSync(join(logDir, SELFTEST_FILE)), false);
    assert.equal(gh.calls.length, 0);
  });

  it("turns a passed selftest off when a Vercel deployment appears, and uploads then refuse", async () => {
    const fx = selftestFixture();
    const first = await runSelftest(fx).result;
    assert.equal(first.ok, true);

    const gh = ghStub({ lists: [[VERCEL_DEPLOYMENT]] });
    const status = await main(["selftest", "--log-dir", fx.logDir, "--status", "1"], {
      gh: gh.gh,
    });
    assert.equal(status.ok, false);
    assert.equal(status.reason, "vercel-deployment");
    assert.equal(status.deployment, "found:building");
    assert.equal(status.commit, first.commit);
    assert.equal(typeof status.statusAt, "string");
    assert.match(gh.listCalls()[0][1], new RegExp(`sha=${first.commit}&`));

    const file = join(fx.logDir, SELFTEST_FILE);
    assert.deepEqual(readJsonFile(file), status);
    assert.equal(modeOf(file), 0o600);
    assert.equal(uploadGate({ env: {}, withheld: false, logDir: fx.logDir }), "selftest-failed");
  });

  it("keeps a passed selftest on while there is still no deployment", async () => {
    const fx = selftestFixture();
    const first = await runSelftest(fx).result;
    const later = new Date("2026-11-11T08:00:00.000Z");
    const status = selftestStatus({ logDir: fx.logDir, gh: ghStub().gh, now: () => later });
    assert.deepEqual(status, { ...first, deployment: "none", statusAt: later.toISOString() });
    assert.equal(uploadGate({ env: {}, withheld: false, logDir: fx.logDir }), null);
  });

  it("returns a record without a commit as it is, asking nothing", () => {
    const logDir = join(tempRoot(), "logs");
    writeSelftest(logDir, { ok: false, commit: null, reason: "error" });
    const gh = ghStub();
    const status = selftestStatus({ logDir, gh: gh.gh });
    assert.equal(status.ok, false);
    assert.equal(status.reason, "error");
    assert.equal(gh.calls.length, 0);
  });
});

// ── upload: gates ───────────────────────────────────────────────────────────

describe("upload refuses, and pushes nothing, until every gate is open", () => {
  const cases = [
    ["selftest-missing", "there is no selftest record", { selftestRecord: null }, {}],
    [
      "selftest-failed",
      "the selftest failed",
      { selftestRecord: { ok: false, reason: "not-served:status" } },
      {},
    ],
    ["off", "FACTORY_EVIDENCE_UPLOAD=0", {}, { env: { [SWITCH_ENV]: "0" } }],
    [
      "withheld",
      "the render says withheld: true",
      { render: { withheld: true, secretHits: ["jwt"] } },
      {},
    ],
    [
      "withheld",
      "the render says the browser lane was withheld",
      { render: { withheld: { shell: false, browser: true }, secretHits: ["browser:jwt"] } },
      {},
    ],
    [
      "withheld",
      "the composed body matched a secret pattern",
      { render: { withheld: { shell: false, browser: false }, secretHits: ["body:jwt"] } },
      {},
    ],
    ["withheld", "the render JSON file is missing", { render: null }, {}],
    ["withheld", "the render JSON file is unreadable", { render: "{not json\n" }, {}],
  ];
  for (const [reason, when, fixture, opts] of cases) {
    it(`says ${reason} when ${when}`, async () => {
      const fx = uploadFixture(fixture);
      const summary = await upload(fx, {}, opts);
      assert.deepEqual(summary, {
        ok: false,
        reason,
        commit: null,
        images: 0,
        overflow: 0,
        reused: false,
      });
      assert.deepEqual(readJsonFile(fx.out), { ok: false, reason });
      assert.equal(modeOf(fx.out), 0o600);
      assertNothingPushed(fx);
      // Refused before a single image was read for the OCR scan.
      assert.equal(fx.ocr.seen.length, 0);
    });
  }

  it("refuses a run it published before once the switch is off, and says so in upload.json", async () => {
    const fx = uploadFixture();
    assert.equal((await upload(fx)).ok, true);
    const pushes = fx.pushes();
    const summary = await upload(fx, {}, { env: { [SWITCH_ENV]: "0" } });
    assert.equal(summary.reason, "off");
    assert.deepEqual(readJsonFile(fx.out), { ok: false, reason: "off" });
    assert.equal(fx.pushes(), pushes);
  });

  it("publishes on a retry once the selftest has passed", async () => {
    const fx = uploadFixture({ selftestRecord: null });
    assert.equal((await upload(fx)).reason, "selftest-missing");
    writeSelftest(fx.logDir);
    const summary = await upload(fx);
    assert.equal(summary.ok, true);
    assert.equal(summary.reused, false);
    assert.equal(evidenceRefs(fx.origin).length, 1);
  });
});

// ── upload: what is published ───────────────────────────────────────────────

describe("upload publishes one parentless commit on the run's own ref", () => {
  it("holds exactly the guard-copied screenshots, slot-numbered, embedded by URLs pinned to the commit", async () => {
    const one = shot(1);
    const three = shot(3, "jpg");
    const fx = uploadFixture({ shots: [one, { copyFailed: true }, three, { rejected: true }] });
    const summary = await upload(fx);
    assert.equal(summary.ok, true);
    assert.equal(summary.reason, null);
    assert.equal(summary.images, 2);
    assert.equal(summary.reused, false);
    const commit = summary.commit;
    assert.match(commit, /^[0-9a-f]{40}$/);

    // Origin: the run's ref, at that commit, and no branch or tag at all.
    const ref = `refs/factory-evidence/${ISSUE}/${SHA12}/${RUN_ID}`;
    assert.deepEqual(originRefs(fx.origin), [{ sha: commit, ref }]);
    assert.deepEqual(originRefs(fx.origin, "refs/heads/", "refs/tags/"), []);
    assert.equal(fx.pushes(), 1);

    // The commit: no parent, the fixed message, only the two images, by slot.
    const dir = `${ISSUE}/${SHA12}/${RUN_ID}`;
    const c = commitOf(fx.origin, commit);
    assert.deepEqual(c.parents, []);
    assert.equal(c.message, commitMessage(ISSUE));
    assert.deepEqual(c.paths, [`${dir}/01.png`, `${dir}/03.jpg`]);
    assert.ok(blobOf(fx.origin, commit, `${dir}/01.png`).equals(one.data));
    assert.ok(blobOf(fx.origin, commit, `${dir}/03.jpg`).equals(three.data));

    // upload.json: mode 600, the URLs pinned to the evidence commit, no bytes.
    const record = readJsonFile(fx.out);
    assert.equal(modeOf(fx.out), 0o600);
    assert.equal(record.ok, true);
    assert.equal(record.issue, ISSUE);
    assert.equal(record.sha, SHA);
    assert.equal(record.runId, RUN_ID);
    assert.equal(record.ref, ref);
    assert.equal(record.commit, commit);
    assert.deepEqual(record.images, [
      {
        n: 1,
        url: `${RAW}${commit}/${dir}/01.png`,
        local: join(fx.evidenceDir, one.name),
        name: one.name,
      },
      {
        n: 3,
        url: `${RAW}${commit}/${dir}/03.jpg`,
        local: join(fx.evidenceDir, three.name),
        name: three.name,
      },
    ]);
    assert.doesNotMatch(readFileSync(fx.out, "utf8"), /"data"/);

    // Each published image was OCR-scanned, and nothing else was.
    assert.deepEqual(
      fx.ocr.seen.map((s) => s.ext),
      ["png", "jpg"],
    );
    assert.ok(fx.ocr.seen[0].data.equals(one.data));
  });

  it("publishes a macOS run's shots/NN-<label>.png with their labels", async () => {
    const fx = uploadFixture({ shots: [] });
    const shotsDir = join(fx.root, "macos-run", "shots");
    mkdirSync(shotsDir, { recursive: true });
    writeFileSync(join(shotsDir, "01-signed-in.png"), PNG("m1"));
    writeFileSync(join(shotsDir, "02-note-open.png"), PNG("m2"));
    writeFileSync(join(shotsDir, "preflight-window.png"), PNG("preflight"));
    writeFileSync(join(shotsDir, "tmp-ocr.png"), PNG("tmp"));
    const runId = "macos-20261110-051950";
    const summary = await upload(fx, {
      source: "macos",
      "evidence-dir": shotsDir,
      "guard-log": undefined,
      "run-id": runId,
    });
    assert.equal(summary.ok, true);
    const dir = `${ISSUE}/${SHA12}/${runId}`;
    assert.deepEqual(commitOf(fx.origin, summary.commit).paths, [`${dir}/01.png`, `${dir}/02.png`]);
    assert.deepEqual(
      readJsonFile(fx.out).images.map(({ n, label, url }) => ({ n, label, url })),
      [
        { n: 1, label: "signed-in", url: `${RAW}${summary.commit}/${dir}/01.png` },
        { n: 2, label: "note-open", url: `${RAW}${summary.commit}/${dir}/02.png` },
      ],
    );
  });

  it("keeps a listed file that fails its checks on the Mac mini, with its path and why", async () => {
    const outside = join(tempRoot(), "elsewhere.png");
    writeFileSync(outside, PNG("outside"));
    const fx = uploadFixture({ shots: [shot(1)] });
    // Slot 2: a symlink out of the evidence dir. Slot 3: not PNG bytes.
    const link = "screenshot-1731215990002-2.png";
    symlinkSync(outside, join(fx.evidenceDir, link));
    const fake = "screenshot-1731215990003-3.png";
    writeFileSync(join(fx.evidenceDir, fake), Buffer.from("GIF89a not a png"));
    const log = readFileSync(fx.guardLog, "utf8");
    writeFileSync(
      fx.guardLog,
      log +
        [link, fake]
          .map((name) =>
            JSON.stringify({
              event: "post",
              tool: "computer",
              events: [{ copied: name, onOrigin: true }],
            }),
          )
          .join("\n") +
        "\n",
    );
    const summary = await upload(fx);
    assert.equal(summary.ok, true);
    assert.equal(summary.images, 1);
    assert.equal(summary.overflow, 2);
    const record = readJsonFile(fx.out);
    assert.deepEqual(
      record.images.map((i) => i.n),
      [1],
    );
    assert.deepEqual(record.overflow, [
      { n: 2, path: join(fx.evidenceDir, link), why: "a symlink" },
      { n: 3, path: join(fx.evidenceDir, fake), why: "its bytes aren't a PNG image" },
    ]);
    assert.deepEqual(commitOf(fx.origin, summary.commit).paths, [
      `${ISSUE}/${SHA12}/${RUN_ID}/01.png`,
    ]);
  });

  it("publishes at most the per-comment cap and lists the rest as kept on the Mac mini", async () => {
    const shots = Array.from({ length: MAX_IMAGES + 2 }, (_, i) => shot(i + 1));
    const fx = uploadFixture({ shots });
    const summary = await upload(fx);
    assert.equal(summary.ok, true);
    assert.equal(summary.images, MAX_IMAGES);
    assert.equal(summary.overflow, 2);
    const record = readJsonFile(fx.out);
    assert.deepEqual(
      record.overflow,
      shots.slice(MAX_IMAGES).map((s, i) => ({
        n: MAX_IMAGES + 1 + i,
        path: join(fx.evidenceDir, s.name),
        why: CAP_WHY,
      })),
    );
    assert.equal(commitOf(fx.origin, summary.commit).paths.length, MAX_IMAGES);
    // What is over the cap is never even OCR'd.
    assert.equal(fx.ocr.seen.length, MAX_IMAGES);
  });

  it("drops an image whose text shows the account password, never saying what matched", async () => {
    const fx = uploadFixture({
      shots: [shot(1), shot(2), shot(3)],
      textOf: (data) => (data.includes("png:2") ? `Email\nPassword ${PASSWORD}` : "Notebooks"),
    });
    const account = join(fx.root, "account.env");
    writeFileSync(
      account,
      `FACTORY_BROWSER_EMAIL=factory-test@example.com\nFACTORY_BROWSER_PASSWORD=${PASSWORD}\n`,
      { mode: 0o600 },
    );
    const summary = await upload(fx, { "account-file": account });
    assert.equal(summary.ok, true);
    const record = readJsonFile(fx.out);
    assert.deepEqual(
      record.images.map((i) => i.n),
      [1, 3],
    );
    assert.equal(record.overflow.length, 1);
    assert.equal(record.overflow[0].n, 2);
    assert.match(record.overflow[0].why, /secret pattern \(password\)/);
    assert.ok(!readFileSync(fx.out, "utf8").includes(PASSWORD));
    const dir = `${ISSUE}/${SHA12}/${RUN_ID}`;
    assert.deepEqual(commitOf(fx.origin, summary.commit).paths, [`${dir}/01.png`, `${dir}/03.png`]);
  });

  it("drops an image whose text shows the bypass secret or the dev service-role key it was given", async () => {
    // Neither value matches a pattern, so only the literal scan finds them.
    const BYPASS = "bypassLiteral0123456789abcdefXYZ";
    const SERVICE = "svc-literal-0123456789abcdefXYZ";
    const fx = uploadFixture({
      shots: [shot(1), shot(2), shot(3)],
      textOf: (data) =>
        data.includes("png:1")
          ? `header ${BYPASS}`
          : data.includes("png:2")
            ? `key ${SERVICE}`
            : "Notebooks",
    });
    const bypassFile = join(fx.root, "vercel-bypass.env");
    writeFileSync(bypassFile, `VERCEL_AUTOMATION_BYPASS_SECRET=${BYPASS}\n`, { mode: 0o600 });
    const keyFile = join(fx.root, "dev-supabase-admin.env");
    writeFileSync(keyFile, `DEV_SUPABASE_SERVICE_ROLE_KEY=${SERVICE}\n`, { mode: 0o600 });
    const summary = await upload(fx, { "bypass-file": bypassFile, "signin-key-file": keyFile });
    assert.equal(summary.ok, true);
    const record = readJsonFile(fx.out);
    assert.deepEqual(
      record.images.map((i) => i.n),
      [3],
    );
    assert.deepEqual(
      record.overflow.map((o) => [o.n, /bypass-secret|service-role-key/.exec(o.why)?.[0]]),
      [
        [1, "bypass-secret"],
        [2, "service-role-key"],
      ],
    );
    const text = readFileSync(fx.out, "utf8");
    assert.ok(!text.includes(BYPASS) && !text.includes(SERVICE));
  });

  it('says "secret-file", pushing nothing, when a given bypass or key file can\'t be read', async () => {
    for (const flag of ["bypass-file", "signin-key-file"]) {
      const fx = uploadFixture();
      const summary = await upload(fx, { [flag]: join(fx.root, "missing.env") });
      assert.equal(summary.reason, "secret-file", flag);
      assert.equal(fx.ocr.seen.length, 0, flag);
      assertNothingPushed(fx);
    }
  });

  it("drops an image whose text shows a secret pattern such as a dk_ key", async () => {
    const fx = uploadFixture({
      shots: [shot(1), shot(2)],
      textOf: (data) => (data.includes("png:1") ? `Your new key: ${DK_KEY}` : "Settings"),
    });
    const summary = await upload(fx);
    const record = readJsonFile(fx.out);
    assert.equal(summary.ok, true);
    assert.deepEqual(
      record.images.map((i) => i.n),
      [2],
    );
    assert.match(record.overflow[0].why, /drafto-api-key/);
    assert.ok(!readFileSync(fx.out, "utf8").includes(DK_KEY));
  });
});

// ── upload: idempotency ─────────────────────────────────────────────────────

describe("upload is idempotent per issue + head + run", () => {
  it("reuses upload.json, then the ref on origin, and never pushes twice", async () => {
    const fx = uploadFixture();
    const first = await upload(fx);
    assert.equal(first.ok, true);
    assert.equal(fx.pushes(), 1);
    const firstRecord = readJsonFile(fx.out);

    // A retry: upload.json answers, nothing is scanned or pushed again.
    const scanned = fx.ocr.seen.length;
    const again = await upload(fx);
    assert.equal(again.reused, true);
    assert.equal(again.commit, first.commit);
    assert.equal(fx.pushes(), 1);
    assert.equal(fx.ocr.seen.length, scanned);
    assert.deepEqual(readJsonFile(fx.out), firstRecord);

    // upload.json lost: the commit already on the run's ref is reused.
    rmSync(fx.out);
    const third = await upload(fx);
    assert.equal(third.ok, true);
    assert.equal(third.commit, first.commit);
    assert.equal(fx.pushes(), 1);
    assert.deepEqual(readJsonFile(fx.out).images, firstRecord.images);
    assert.equal(evidenceRefs(fx.origin).length, 1);
  });

  it("priorUpload says what a retry posts: upload.json, else the ref, else nothing, never a guess", async () => {
    const fx = uploadFixture();
    const args = {
      issue: ISSUE,
      sha: SHA,
      runId: RUN_ID,
      out: fx.out,
      repoRoot: fx.work,
      git: fx.git,
    };
    assert.equal(priorUpload(args), null);
    const first = await upload(fx);
    const record = readJsonFile(fx.out);
    assert.deepEqual(priorUpload(args), { ...record, reused: true });
    // upload.json lost: the commit on the run's ref, read back from its tree.
    rmSync(fx.out);
    assert.deepEqual(priorUpload(args), {
      ok: true,
      issue: ISSUE,
      sha: SHA,
      runId: RUN_ID,
      ref: record.ref,
      commit: first.commit,
      images: record.images.map(({ n, url }) => ({ n, url, local: null, name: null })),
      overflow: [],
      reused: true,
    });
    // Another run of the same head has nothing to reuse.
    assert.equal(priorUpload({ ...args, runId: "verify-20261110T061000" }), null);
    // An origin that can't be asked, or a ref whose commit can't be read, is
    // never "nothing published".
    const remote = {
      ok: false,
      issue: ISSUE,
      sha: SHA,
      runId: RUN_ID,
      ref: record.ref,
      reason: "remote",
      overflow: [],
    };
    assert.deepEqual(
      priorUpload({ ...args, git: () => ({ code: 128, stdout: "", stderr: "" }) }),
      remote,
    );
    const unreadable = (a, o) =>
      a[0] === "ls-remote" ? fx.git(a, o) : { code: 128, stdout: "", stderr: "" };
    assert.deepEqual(priorUpload({ ...args, git: unreadable }), remote);
    // A failed record is no upload: the ref decides.
    writeFileSync(fx.out, `${JSON.stringify({ ...record, ok: false, reason: "push" })}\n`);
    assert.equal(priorUpload(args).commit, first.commit);
    assert.equal(priorUpload({ ...args, git: () => ({ code: 0, stdout: "", stderr: "" }) }), null);
    assert.equal(fx.pushes(), 1);
  });

  it("reads the existing commit's paths from origin in a checkout that never had it", async () => {
    const fx = uploadFixture();
    const first = await upload(fx);
    const other = workRepo(fx.root, fx.origin, "other-checkout");
    const out = join(fx.root, "other-upload.json");
    const summary = await upload(fx, { "repo-root": other.work, out }, { git: other.git });
    assert.equal(summary.ok, true);
    assert.equal(summary.commit, first.commit);
    assert.equal(other.pushes(), 0);
    assert.ok(other.calls.some((a) => a[0] === "fetch"));
    assert.deepEqual(readJsonFile(out).images, readJsonFile(fx.out).images);
  });

  it("publishes a different run of the same head on its own ref", async () => {
    const fx = uploadFixture();
    const first = await upload(fx);
    const second = await upload(fx, { "run-id": "verify-20261110T061000" });
    assert.equal(second.ok, true);
    assert.equal(second.reused, false);
    assert.notEqual(second.commit, first.commit);
    assert.equal(fx.pushes(), 2);
    assert.deepEqual(
      evidenceRefs(fx.origin)
        .map((r) => r.ref)
        .sort(),
      [
        `refs/factory-evidence/${ISSUE}/${SHA12}/${RUN_ID}`,
        `refs/factory-evidence/${ISSUE}/${SHA12}/verify-20261110T061000`,
      ],
    );
  });

  it("doesn't reuse an upload.json for another head", async () => {
    const fx = uploadFixture();
    await upload(fx);
    const otherSha = "fedcba9876543210fedcba9876543210fedcba98";
    const summary = await upload(fx, { sha: otherSha });
    assert.equal(summary.reused, false);
    assert.equal(readJsonFile(fx.out).sha, otherSha);
    assert.equal(fx.pushes(), 2);
  });

  it("counts a push that reported a failure but landed, by the commit on the ref", async () => {
    const fx = uploadFixture();
    const git = (args, opts) => {
      const r = fx.git(args, opts);
      return args.includes("push") ? { ...r, code: 1 } : r;
    };
    const summary = await upload(fx, {}, { git });
    assert.equal(summary.ok, true);
    assert.equal(summary.commit, evidenceRefs(fx.origin)[0].sha);
  });
});

// ── upload: failures fall back ──────────────────────────────────────────────

describe("upload failures are reasons, written to upload.json", () => {
  it('says "push", and resolves (the CLI exits 0), when the push fails', async () => {
    const fx = uploadFixture();
    const git = (args, opts) =>
      args.includes("push")
        ? {
            code: 128,
            stdout: "",
            stderr: "fatal: unable to access 'https://x-access-token:ghs_SECRET@github.com/'",
          }
        : fx.git(args, opts);
    const summary = await upload(fx, {}, { git });
    assert.deepEqual(summary, {
      ok: false,
      reason: "push",
      commit: null,
      images: 0,
      overflow: 0,
      reused: false,
    });
    const record = readJsonFile(fx.out);
    assert.equal(record.ok, false);
    assert.equal(record.reason, "push");
    assert.equal(record.ref, `refs/factory-evidence/${ISSUE}/${SHA12}/${RUN_ID}`);
    assert.equal(modeOf(fx.out), 0o600);
    assert.ok(!readFileSync(fx.out, "utf8").includes("ghs_SECRET"));
    assert.deepEqual(evidenceRefs(fx.origin), []);
  });

  it('says "remote", without pushing, when origin can\'t be listed', async () => {
    const fx = uploadFixture();
    const git = (args, opts) =>
      args[0] === "ls-remote"
        ? { code: 128, stdout: "", stderr: "no network" }
        : fx.git(args, opts);
    const summary = await upload(fx, {}, { git });
    assert.equal(summary.reason, "remote");
    assert.equal(readJsonFile(fx.out).reason, "remote");
    assertNothingPushed(fx);
  });

  it('says "account-file", scanning and pushing nothing, when a given account file can\'t be read', async () => {
    const fx = uploadFixture();
    const summary = await upload(fx, { "account-file": join(fx.root, "no-such-account.env") });
    assert.equal(summary.reason, "account-file");
    assert.deepEqual(readJsonFile(fx.out), { ok: false, reason: "account-file" });
    assert.equal(fx.ocr.seen.length, 0);
    assertNothingPushed(fx);
  });

  it('says "account-file" for an account file without a password', async () => {
    const fx = uploadFixture();
    const account = join(fx.root, "account.env");
    writeFileSync(account, "FACTORY_BROWSER_EMAIL=factory-test@example.com\n");
    assert.equal((await upload(fx, { "account-file": account })).reason, "account-file");
    assertNothingPushed(fx);
  });

  it("succeeds with no images and pushes nothing when the run took no screenshots", async () => {
    const fx = uploadFixture({ shots: [] });
    const summary = await upload(fx);
    assert.deepEqual(summary, {
      ok: true,
      reason: null,
      commit: null,
      images: 0,
      overflow: 0,
      reused: false,
    });
    const record = readJsonFile(fx.out);
    assert.equal(record.ok, true);
    assert.equal(record.commit, null);
    assert.deepEqual(record.images, []);
    assertNothingPushed(fx);
  });

  it("succeeds with no images when every screenshot slot has no file, and lists each with why", async () => {
    const fx = uploadFixture({ shots: [{ copyFailed: true }, { rejected: true }] });
    const summary = await upload(fx, {}, { ocr: null });
    assert.equal(summary.ok, true);
    assert.equal(summary.commit, null);
    assert.deepEqual(readJsonFile(fx.out).overflow, [
      { n: 1, path: fx.evidenceDir, why: "the guard couldn't copy it" },
      { n: 2, path: fx.evidenceDir, why: "the guard rejected it" },
    ]);
    assertNothingPushed(fx);
  });

  it("never publishes a copy taken off the preview, lists it, and the comment says none passed", async () => {
    const off = { ...shot(1), offOrigin: true };
    const fx = uploadFixture({ shots: [off] });
    const summary = await upload(fx);
    assert.equal(summary.ok, true);
    assert.equal(summary.commit, null);
    assert.equal(summary.images, 0);
    assert.equal(summary.overflow, 1);
    const record = readJsonFile(fx.out);
    assert.deepEqual(record.overflow, [
      { n: 1, path: join(fx.evidenceDir, off.name), why: OFF_ORIGIN_WHY },
    ]);
    assert.equal(fx.ocr.seen.length, 0, "a held-back copy is never even read");
    assertNothingPushed(fx);

    // The comment: the shot is listed with its path and why, and the footer
    // doesn't claim the run saved none.
    const ev = evidenceSection({
      report:
        "| # | Step | Result | Evidence |\n|---|---|---|---|\n| 1 | Open | PASS | screenshot 1 |",
      upload: record,
      evidenceDir: fx.evidenceDir,
    });
    assert.equal(ev.embedded, 0);
    assert.equal(ev.reason, "none-passed");
    assert.equal(ev.footer, localFooter(fx.evidenceDir, "none-passed"));
    const block = ev.block.join("\n");
    assert.match(block, /\*\*Kept on the Mac mini\*\*/);
    assert.ok(block.includes(`screenshot 1, ${OFF_ORIGIN_WHY}`), block);
    assert.ok(block.includes(off.name), block);
  });

  it('says "no-session" for a run without a guard log', async () => {
    for (const guardLog of ["", "/nonexistent/browser-guard/x.jsonl"]) {
      const fx = uploadFixture();
      const summary = await upload(fx, { "guard-log": guardLog });
      assert.equal(summary.reason, "no-session");
      assert.equal(readJsonFile(fx.out).reason, "no-session");
      assertNothingPushed(fx);
    }
  });

  it('says "ocr-missing", pushing nothing, when screenshots are listed but no OCR helper can scan them', async () => {
    const fx = uploadFixture();
    const notExecutable = join(fx.root, "ocr");
    writeFileSync(notExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    for (const ocr of ["", notExecutable, "relative/ocr"]) {
      const summary = await upload(fx, { ocr }, { ocr: null });
      assert.equal(summary.reason, "ocr-missing", `--ocr ${JSON.stringify(ocr)}`);
      assert.equal(readJsonFile(fx.out).reason, "ocr-missing");
    }
    assertNothingPushed(fx);
  });

  it("writes and returns the same record from uploadRun", () => {
    const fx = uploadFixture({ selftestRecord: null });
    const result = uploadRun({
      issue: ISSUE,
      sha: SHA,
      runId: RUN_ID,
      source: "browser",
      evidenceDir: fx.evidenceDir,
      guardLog: fx.guardLog,
      out: fx.out,
      logDir: fx.logDir,
      repoRoot: fx.work,
      withheld: false,
      env: {},
      git: fx.git,
      deps: { ocr: fx.ocr.ocr },
    });
    assert.deepEqual(result, { ok: false, reason: "selftest-missing" });
    assert.deepEqual(readJsonFile(fx.out), result);
  });
});

// ── CLI usage ───────────────────────────────────────────────────────────────

describe("main rejects a bad command line before doing anything", () => {
  const bad = [
    ["--sha", { sha: "abc" }, /--sha/],
    ["--sha (upper case)", { sha: SHA.toUpperCase() }, /--sha/],
    ["--run-id ../x", { "run-id": "../x" }, /--run-id/],
    ["--run-id UPPER-1", { "run-id": "UPPER-1" }, /--run-id/],
    ["--run-id without a stamp", { "run-id": "intest" }, /--run-id/],
    ["--run-id with a slash", { "run-id": "intest-1/2" }, /--run-id/],
    ["--source", { source: "shell" }, /--source/],
    ["--issue 0", { issue: "0" }, /--issue/],
    ["--issue 12a", { issue: "12a" }, /--issue/],
    ["a missing --guard-log for a browser run", { "guard-log": undefined }, /--guard-log/],
    ["a missing --render-json", { "render-json": undefined }, /--render-json/],
    ["a missing --ocr", { ocr: undefined }, /--ocr/],
    ["a missing --account-file", { "account-file": undefined }, /--account-file/],
    ["a missing --out", { out: undefined }, /--out/],
  ];
  for (const [what, over, re] of bad) {
    it(`rejects ${what}`, async () => {
      const fx = uploadFixture();
      await assert.rejects(upload(fx, over), isUsageError(re));
      assert.equal(existsSync(fx.out), false);
      assertNothingPushed(fx);
    });
  }

  it("rejects an unknown command", async () => {
    await assert.rejects(main(["publish"]), isUsageError(/usage/));
    await assert.rejects(main([]), isUsageError(/usage/));
  });

  it("rejects a selftest without --log-dir", async () => {
    await assert.rejects(main(["selftest", "--repo-root", "/tmp"]), isUsageError(/--log-dir/));
  });
});

// ── the CLI binary ──────────────────────────────────────────────────────────

describe("evidence-upload.mjs as a command", () => {
  const runCli = (args, cwd) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: cleanEnv() });

  it("prints one JSON line and exits 0 when the upload is refused", () => {
    const fx = uploadFixture({ selftestRecord: null });
    const r = runCli(uploadArgv(fx), fx.root);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      ok: false,
      reason: "selftest-missing",
      commit: null,
      images: 0,
      overflow: 0,
      reused: false,
    });
    assert.deepEqual(readJsonFile(fx.out), { ok: false, reason: "selftest-missing" });
    assertNothingPushed(fx);
  });

  it("exits 2 on a usage error, printing the error to stderr only", () => {
    const fx = uploadFixture();
    for (const args of [
      uploadArgv(fx, { sha: "not-a-sha" }),
      uploadArgv(fx, { "run-id": "../x" }),
      ["upload", "--issue"],
      ["frobnicate"],
    ]) {
      const r = runCli(args, fx.root);
      assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
      assert.equal(r.stdout, "");
      assert.ok(typeof JSON.parse(r.stderr.trim()).error === "string");
    }
    assert.equal(existsSync(fx.out), false);
    assertNothingPushed(fx);
  });

  it("exits 1 on a selftest status check with no record", () => {
    const logDir = join(tempRoot(), "logs");
    const r = runCli(["selftest", "--log-dir", logDir, "--status", "1"], tmpdir());
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout.trim()), { ok: false, reason: "selftest-missing" });
  });

  // A stand-in for $LOG_DIR/bin/ocr: every image reads as "Notebooks".
  function fakeOcrHelper(root) {
    const bin = join(root, "bin", "ocr");
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, '#!/bin/sh\nprintf \'{"items":[{"text":"Notebooks"}]}\\n\'\n');
    chmodSync(bin, 0o755);
    return bin;
  }

  it("publishes with its own git and the OCR helper, and exits 0", () => {
    const fx = uploadFixture();
    const r = runCli(uploadArgv(fx, { ocr: fakeOcrHelper(fx.root) }), fx.root);
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stdout.trim());
    assert.equal(summary.ok, true, r.stdout);
    assert.equal(summary.images, 2);
    assert.deepEqual(evidenceRefs(fx.origin), [
      { sha: summary.commit, ref: `refs/factory-evidence/${ISSUE}/${SHA12}/${RUN_ID}` },
    ]);
    assert.deepEqual(commitOf(fx.origin, summary.commit).parents, []);
  });

  it('exits 0 with reason "push" when origin rejects the ref', () => {
    const fx = uploadFixture();
    const hook = join(fx.origin, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'refs/factory-evidence is not allowed' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const r = runCli(uploadArgv(fx, { ocr: fakeOcrHelper(fx.root) }), fx.root);
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stdout.trim());
    assert.equal(summary.ok, false);
    assert.equal(summary.reason, "push");
    assert.equal(readJsonFile(fx.out).reason, "push");
    assert.equal(modeOf(fx.out), 0o600);
    assert.deepEqual(evidenceRefs(fx.origin), []);
  });
});
