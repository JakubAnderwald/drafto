// Integration tests for the detached half of verify-lane.mjs: `_supervise`,
// `preview-curl` and the sign-in / key-revocation steps, with fake `pnpm`,
// `claude` and `curl` binaries. The supervisor is spawned for real (detached,
// its own process group), so this exercises what the factory relies on across
// ticks: the install, the locked-down claude call (flags, env, stdin), the
// guard's real settings (the fake claude runs their hook commands the way
// Claude Code does), the deadline, a SIGTERM to the group, and the cleanup
// that removes the run's private/ dir whatever happened.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EventEmitter } from "node:events";

import {
  PREVIEW_CURL_BIN,
  curlConfigText,
  previewCurlScript,
  revokeLaneKeys,
  runPreviewCurl,
  signInPreview,
} from "../lib/verify-lane.mjs";
import { writeGuardFiles } from "../lib/verify-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANE = path.resolve(HERE, "..", "lib", "verify-lane.mjs");
const RUN_CLAUDE = path.resolve(HERE, "..", "lib", "run-claude.mjs");
const ORIGIN = "https://drafto-abc123-jakubanderwalds-projects.vercel.app";
const SHA = "a".repeat(40);
const BYPASS_SECRET = "s3cretBypassValue0123456789ABCDEF";

let tmp;
let fakeBin;
let home;
const pids = new Set();

const OUTPUT = [
  "<<<REPORT",
  "Ran against the checkout.",
  "| # | Step | Result | Evidence |",
  "|---|---|---|---|",
  "| 1 | health | PASS | 200 |",
  "**Summary:** 1 PASS",
  "**Assessment:** fine.",
  "REPORT>>>",
  "<<<MANUAL",
  "1. Open the app — expected: it opens.",
  "MANUAL>>>",
  "shell=ok verdict=pass",
].join("\n");

// The fake claude: dumps what it was given next to itself, runs the guard's
// hooks from the --settings file the way Claude Code would, writes a
// transcript with one tool call, and prints a canned report (or sleeps).
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const here = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
const input = fs.readFileSync(0, "utf8");
const at = (f) => args[args.indexOf(f) + 1];
fs.writeFileSync(path.join(here, "claude-argv.json"), JSON.stringify(args));
fs.writeFileSync(path.join(here, "claude-env.json"), JSON.stringify(process.env));
fs.writeFileSync(path.join(here, "claude-input.txt"), input);
fs.writeFileSync(path.join(here, "claude-cwd.txt"), process.cwd());
const settings = JSON.parse(fs.readFileSync(at("--settings"), "utf8"));
const sid = at("--session-id");
const hook = (cmd, payload) => spawnSync("/bin/sh", ["-c", cmd], { input: JSON.stringify(payload), encoding: "utf8" });
hook(settings.hooks.SessionStart[0].hooks[0].command, { session_id: sid, source: "startup" });
const pre = hook(settings.hooks.PreToolUse[0].hooks[0].command, { session_id: sid, tool_name: "Bash", tool_input: { command: "gh auth token" } });
fs.writeFileSync(path.join(here, "claude-pre-exit.txt"), String(pre.status));
const proj = path.join(process.env.HOME, ".claude", "projects", "-fake-cwd");
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, sid + ".jsonl"), JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }) + "\\n");
const mode = fs.existsSync(path.join(here, "claude-mode")) ? fs.readFileSync(path.join(here, "claude-mode"), "utf8").trim() : "ok";
if (mode === "sleep") { setTimeout(() => {}, 120000); return; }
process.stdout.write(${JSON.stringify(OUTPUT)} + "\\n");
`;

const FAKE_PNPM = `#!/bin/sh
here=$(dirname "$0")
echo "$@" >> "$here/pnpm-calls.txt"
env > "$here/pnpm-env.txt"
pwd > "$here/pnpm-cwd.txt"
if [ -f "$here/pnpm-fail" ]; then exit 1; fi
exit 0
`;

// The fake curl: records every call (and whether its config carries the bypass
// header) and answers like the preview would.
const FAKE_CURL = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const here = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
const cfgs = [];
args.forEach((a, i) => { if (a === "-K") cfgs.push(fs.readFileSync(args[i + 1], "utf8")); });
const url = args[args.indexOf("--url") + 1] || "";
fs.appendFileSync(path.join(here, "curl-calls.jsonl"), JSON.stringify({ args, url, bypass: cfgs.some((c) => c.includes("x-vercel-protection-bypass")), signin: cfgs.some((c) => c.includes("test-sign-in")) }) + "\\n");
if (cfgs.some((c) => c.includes("test-sign-in"))) { process.stdout.write(process.env.FAKE_SIGNIN || "307 ${ORIGIN}/"); process.exit(0); }
if (args.includes("DELETE")) { process.stdout.write("200"); process.exit(0); }
if (url.endsWith("/api/api-keys")) {
  process.stdout.write(JSON.stringify([
    { id: "k1", name: "factory-shell-7-aaaaaaa-120000-mcp", revoked_at: null, created_at: "2026-10-21T12:05:00Z" },
    { id: "k2", name: "factory-shell-3-bbbbbbb-090000", revoked_at: null, created_at: "2026-10-21T09:00:00Z" },
    { id: "k3", name: "factory-shell-7-old", revoked_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z" },
    { id: "k4", name: "the operator's own key", revoked_at: null, created_at: "2026-10-01T00:00:00Z" },
    { id: "k5", name: "factory-shell-8-ccccccc-121000", revoked_at: null, created_at: "2026-10-21T12:10:00Z" },
  ]) + "\\n200");
  process.exit(0);
}
process.stdout.write('{"ok":true}');
`;

before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "verify-supervisor-test-"));
  fakeBin = path.join(tmp, "bin");
  home = path.join(tmp, "home");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const [name, text] of [
    ["claude", FAKE_CLAUDE],
    ["pnpm", FAKE_PNPM],
    ["curl", FAKE_CURL],
  ]) {
    writeFileSync(path.join(fakeBin, name), text);
    chmodSync(path.join(fakeBin, name), 0o755);
  }
});

after(() => {
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(tmp, { recursive: true, force: true });
});

function resetFakes() {
  for (const f of [
    "claude-argv.json",
    "claude-env.json",
    "claude-input.txt",
    "claude-mode",
    "pnpm-calls.txt",
    "pnpm-fail",
    "curl-calls.jsonl",
    "claude-pre-exit.txt",
  ]) {
    rmSync(path.join(fakeBin, f), { force: true });
  }
}

function makeRun(name, { deadlineInMs = 60_000, previewOrigin = "", bypassFile = null } = {}) {
  const runId = `7-aaaaaaaaaaaa-20261021T0000${String(name).padStart(2, "0")}Z`;
  const repoRoot = path.join(tmp, `factory-${name}`);
  const runDir = path.join(repoRoot, "logs", "factory", "verify", runId);
  const worktree = path.join(repoRoot, "worktrees", "verify-7-aaaaaaaaaaaa");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(path.join(runDir, "prompt.md"), "# the verify prompt\n");
  writeFileSync(
    path.join(runDir, "bundle.json"),
    JSON.stringify({ kind: "factory_verify_shell", headSha: SHA }),
  );
  const guard = writeGuardFiles({ runDir, worktree, repoRoot, home });
  const meta = {
    runId,
    issue: "7",
    pr: "70",
    sha: SHA,
    worktree,
    runDir,
    repoRoot,
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + deadlineInMs).toISOString(),
    sessionId: "12345678-1234-4123-8123-1234567890ab",
    effort: "low",
    installTimeoutSec: 30,
    previewOrigin,
    qaTag: "factory-shell-7-aaaaaaa",
    bins: {
      claude: path.join(fakeBin, "claude"),
      pnpm: path.join(fakeBin, "pnpm"),
      curl: path.join(fakeBin, "curl"),
      node: process.execPath,
      cp: "/bin/cp",
      nice: "/usr/bin/nice",
      perl: "/usr/bin/perl",
    },
    paths: {
      prompt: path.join(runDir, "prompt.md"),
      bundle: path.join(runDir, "bundle.json"),
      guardConfig: guard.configPath,
      guardSettings: guard.settingsPath,
      runClaude: RUN_CLAUDE,
      module: LANE,
      bypassFile,
      // A key file other users can read: minting refuses it before any request.
      signinKeyFile: path.join(tmp, "open-key.env"),
      accountFile: path.join(tmp, "account.env"),
    },
    laneFacts: { bypass: bypassFile ? "ok" : "missing" },
  };
  writeFileSync(path.join(tmp, "open-key.env"), "DEV_SUPABASE_URL=x\n", { mode: 0o644 });
  writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta));
  return { runDir, worktree, meta };
}

function startSupervisor(runDir, extraEnv = {}) {
  const child = spawn(process.execPath, [LANE, "_supervise", "--run-dir", runDir], {
    detached: true,
    stdio: "ignore",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USER: process.env.USER ?? "x",
      TMPDIR: tmpdir(),
      GH_TOKEN: "ghp_leakedIntoTheLane0000000000000000",
      SUPABASE_ACCESS_TOKEN: "sbp_leak",
      RESEND_API_KEY: "re_leak",
      ...extraEnv,
    },
  });
  child.unref();
  pids.add(child.pid);
  return child;
}

async function waitFor(predicate, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

describe("_supervise", () => {
  it("installs, runs the locked-down claude call, checks the guard and cleans up", async () => {
    resetFakes();
    const { runDir, worktree, meta } = makeRun(1);
    startSupervisor(runDir);
    assert.ok(await waitFor(() => existsSync(path.join(runDir, "exit.json"))), "exit.json written");
    const exit = readJson(path.join(runDir, "exit.json"));
    assert.equal(exit.exitCode, 0, readFileSync(path.join(runDir, "supervisor.log"), "utf8"));
    assert.equal(exit.error, null);
    assert.equal(exit.facts.install, "ok");
    assert.equal(exit.facts.session, "no-preview");
    assert.equal(
      exit.guard.sessionStart,
      true,
      "the real settings' SessionStart hook wrote the canary",
    );
    assert.equal(exit.guard.pre, 1);
    assert.equal(exit.guard.denied, 1);
    assert.equal(exit.guard.toolUses, 1);
    assert.equal(exit.guard.ok, true);
    assert.equal(
      readFileSync(path.join(fakeBin, "claude-pre-exit.txt"), "utf8"),
      "2",
      "the real pre hook blocked gh",
    );

    // pnpm: the frozen, offline-preferring install, in the worktree.
    assert.equal(
      readFileSync(path.join(fakeBin, "pnpm-calls.txt"), "utf8").trim(),
      "install --frozen-lockfile --prefer-offline",
    );
    assert.equal(
      realpathSync(readFileSync(path.join(fakeBin, "pnpm-cwd.txt"), "utf8").trim()),
      realpathSync(worktree),
    );
    const pnpmEnv = readFileSync(path.join(fakeBin, "pnpm-env.txt"), "utf8");
    assert.ok(!pnpmEnv.includes("ghp_"), "no GitHub token reaches pnpm");

    // claude: the exact flags, through run-claude.mjs, input on stdin.
    const argv = readJson(path.join(fakeBin, "claude-argv.json"));
    assert.deepEqual(argv, [
      "-p",
      "--no-chrome",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--settings",
      meta.paths.guardSettings,
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Bash,Read,Grep,Glob",
      "--allowedTools",
      "Bash,Read,Grep,Glob",
      "--session-id",
      meta.sessionId,
      "--effort",
      "low",
    ]);
    const env = readJson(path.join(fakeBin, "claude-env.json"));
    for (const k of ["GH_TOKEN", "SUPABASE_ACCESS_TOKEN", "RESEND_API_KEY"])
      assert.equal(env[k], undefined, k);
    assert.equal(env.GH_CONFIG_DIR, path.join(runDir, "gh-empty"));
    assert.ok(env.PATH.startsWith(`${path.join(runDir, "bin")}:${fakeBin}:`), env.PATH);
    assert.ok(Number(env.CLAUDE_CALL_TIMEOUT_SEC) >= 60);
    assert.equal(
      realpathSync(readFileSync(path.join(fakeBin, "claude-cwd.txt"), "utf8")),
      realpathSync(worktree),
    );
    const input = readFileSync(path.join(fakeBin, "claude-input.txt"), "utf8");
    assert.match(input, /^# the verify prompt\n/);
    assert.match(
      input,
      /## Context bundle for this run\n\n```json\n\{"kind":"factory_verify_shell"/,
    );
    assert.match(
      input,
      /## Run-time facts\n\n```json\n\{\n {2}"preview": null,\n {2}"install": "ok"/,
    );

    // Output where the report composer reads it; the wrapper; no private/ left.
    assert.equal(readFileSync(path.join(runDir, "shell-output.txt"), "utf8").trim(), OUTPUT);
    const wrapper = readFileSync(path.join(runDir, "bin", "preview-curl"), "utf8");
    assert.match(wrapper, /preview-curl --run-dir/);
    assert.ok(statSync(path.join(runDir, "bin", "preview-curl")).mode & 0o100);
    assert.ok(!existsSync(path.join(runDir, "private")), "private/ removed");
    assert.ok(!existsSync(path.join(runDir, "gh-empty")), "gh-empty removed");
  });

  it("stops at a failed install without starting claude", async () => {
    resetFakes();
    writeFileSync(path.join(fakeBin, "pnpm-fail"), "");
    const { runDir } = makeRun(2);
    startSupervisor(runDir);
    assert.ok(await waitFor(() => existsSync(path.join(runDir, "exit.json"))));
    const exit = readJson(path.join(runDir, "exit.json"));
    assert.equal(exit.error, "install");
    assert.equal(exit.facts.install, "failed");
    assert.ok(!existsSync(path.join(fakeBin, "claude-argv.json")), "claude never ran");
    assert.ok(!existsSync(path.join(runDir, "private")));
  });

  it("ends the claude call at the deadline and still cleans up", async () => {
    resetFakes();
    writeFileSync(path.join(fakeBin, "claude-mode"), "sleep");
    const { runDir } = makeRun(3, { deadlineInMs: 3000 });
    startSupervisor(runDir);
    assert.ok(
      await waitFor(() => existsSync(path.join(runDir, "exit.json")), 40_000),
      "exit.json written",
    );
    const exit = readJson(path.join(runDir, "exit.json"));
    assert.equal(exit.timedOut, true);
    assert.ok(!existsSync(path.join(runDir, "private")));
  });

  it("winds down on a SIGTERM to its process group, writing exit.json", async () => {
    resetFakes();
    writeFileSync(path.join(fakeBin, "claude-mode"), "sleep");
    const { runDir } = makeRun(4, { deadlineInMs: 120_000 });
    const child = startSupervisor(runDir);
    assert.ok(
      await waitFor(() => existsSync(path.join(fakeBin, "claude-argv.json"))),
      "claude started",
    );
    process.kill(-child.pid, "SIGTERM");
    assert.ok(
      await waitFor(() => existsSync(path.join(runDir, "exit.json")), 30_000),
      "exit.json written",
    );
    const exit = readJson(path.join(runDir, "exit.json"));
    assert.equal(exit.terminated, true);
    assert.ok(!existsSync(path.join(runDir, "private")));
  });

  it("reports a key file minting refuses as mint-failed, without a request", async () => {
    resetFakes();
    const bypass = path.join(tmp, "bypass.env");
    writeFileSync(bypass, `VERCEL_AUTOMATION_BYPASS_SECRET=${BYPASS_SECRET}\n`, { mode: 0o600 });
    const { runDir } = makeRun(5, { previewOrigin: ORIGIN, bypassFile: bypass });
    startSupervisor(runDir);
    assert.ok(await waitFor(() => existsSync(path.join(runDir, "exit.json"))));
    const exit = readJson(path.join(runDir, "exit.json"));
    assert.equal(exit.facts.session, "mint-failed");
    assert.equal(exit.facts.bypass, "ok");
    assert.ok(
      !existsSync(path.join(fakeBin, "curl-calls.jsonl")),
      "no sign-in request, no revocation without a session",
    );
    const input = readFileSync(path.join(fakeBin, "claude-input.txt"), "utf8");
    assert.ok(!input.includes(BYPASS_SECRET), "the secret never reaches the model");
    assert.match(input, /"session": "mint-failed"/);
  });
});

describe("sign-in and key revocation", () => {
  const meta = () => ({
    qaTag: "factory-shell-7-aaaaaaa-120000",
    startedAt: "2026-10-21T12:00:00Z",
    previewOrigin: ORIGIN,
    bins: { curl: path.join(fakeBin, "curl") },
    paths: { signinKeyFile: "k", accountFile: "a" },
  });
  const setup = (bypassSecret = BYPASS_SECRET) => {
    const dir = mkdtempSync(path.join(tmp, "private-"));
    const cfg = path.join(dir, "curl.cfg");
    writeFileSync(cfg, curlConfigText({ bypassSecret, cookieJar: path.join(dir, "cookies.txt") }), {
      mode: 0o600,
    });
    return { dir, cfg };
  };
  const calls = () =>
    existsSync(path.join(fakeBin, "curl-calls.jsonl"))
      ? readFileSync(path.join(fakeBin, "curl-calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  const env = (extra = {}) => ({ PATH: process.env.PATH, HOME: home, ...extra });

  it("exchanges the minted link through the run's config, keeping it off argv", async () => {
    resetFakes();
    const { dir, cfg } = setup();
    const link = `${ORIGIN}/auth/test-sign-in?token_hash=abcdefghijklmnopqrstuvwxyz&next=%2F`;
    const session = await signInPreview(meta(), {
      cfg,
      privateDir: dir,
      env: env(),
      logFile: path.join(dir, "log"),
      mint: async () => link,
    });
    assert.equal(session, "signed-in");
    const [call] = calls();
    assert.equal(call.signin, true);
    assert.equal(call.bypass, true);
    assert.ok(!call.args.join(" ").includes("token_hash"), "the token never reaches argv");
    assert.equal(call.args[0], "-q", "no ~/.curlrc");
    assert.ok(!existsSync(path.join(dir, "signin.cfg")), "the link's config is deleted at once");
  });

  it("names a sign-in that lands on /login or Vercel's SSO", async () => {
    resetFakes();
    const { dir, cfg } = setup();
    const mint = async () =>
      `${ORIGIN}/auth/test-sign-in?token_hash=abcdefghijklmnopqrstuvwxyz&next=%2F`;
    assert.equal(
      await signInPreview(meta(), {
        cfg,
        privateDir: dir,
        env: env({ FAKE_SIGNIN: `307 ${ORIGIN}/login?next=%2Fauth` }),
        logFile: path.join(dir, "log"),
        mint,
      }),
      "signin-failed",
    );
    assert.equal(
      await signInPreview(meta(), {
        cfg,
        privateDir: dir,
        env: env({ FAKE_SIGNIN: "302 https://vercel.com/sso-api?x=1" }),
        logFile: path.join(dir, "log"),
        mint,
      }),
      "protected",
    );
  });

  it("revokes this run's keys and older lane leftovers, never a newer run's", async () => {
    resetFakes();
    const { dir, cfg } = setup();
    const r = await revokeLaneKeys(meta(), { cfg, env: env(), cwd: dir });
    assert.deepEqual(r, { revoked: 2, failed: false });
    const deletes = calls()
      .filter((c) => c.args.includes("DELETE"))
      .map((c) => c.url);
    assert.deepEqual(deletes, [`${ORIGIN}/api/api-keys/k1`, `${ORIGIN}/api/api-keys/k2`]);
  });
});

describe("preview-curl", () => {
  function runDirWithSession() {
    const runDir = mkdtempSync(path.join(tmp, "run-"));
    mkdirSync(path.join(runDir, "private"), { mode: 0o700 });
    mkdirSync(path.join(runDir, "bin"));
    writeFileSync(
      path.join(runDir, "meta.json"),
      JSON.stringify({ previewOrigin: ORIGIN, bins: { curl: path.join(fakeBin, "curl") } }),
    );
    writeFileSync(
      path.join(runDir, "private", "curl.cfg"),
      curlConfigText({
        bypassSecret: BYPASS_SECRET,
        cookieJar: path.join(runDir, "private", "cookies.txt"),
      }),
      { mode: 0o600 },
    );
    const wrapper = path.join(runDir, "bin", "preview-curl");
    writeFileSync(
      wrapper,
      previewCurlScript({ nodePath: process.execPath, modulePath: LANE, runDir }),
      { mode: 0o700 },
    );
    return { runDir, wrapper };
  }

  it("sends one request to the pinned origin through the run's config, with the system curl", async () => {
    const { runDir } = runDirWithSession();
    const spawned = [];
    const spawnFn = (command, args, opts) => {
      spawned.push({ command, args, opts });
      const child = new EventEmitter();
      setImmediate(() => child.emit("exit", 0, null));
      return child;
    };
    const code = await runPreviewCurl(
      { runDir, argv: ["-s", "-w", "%{http_code}", "/api/health"] },
      { spawnFn },
    );
    assert.equal(code, 0);
    assert.equal(spawned.length, 1);
    // Never meta.bins.curl: meta.json sits where the session could edit it.
    assert.equal(spawned[0].command, PREVIEW_CURL_BIN);
    assert.equal(PREVIEW_CURL_BIN, "/usr/bin/curl");
    assert.deepEqual(spawned[0].args, [
      "-q",
      "-K",
      path.join(runDir, "private", "curl.cfg"),
      "-s",
      "-w",
      "%{http_code}",
      "--url",
      `${ORIGIN}/api/health`,
    ]);
    assert.equal(spawned[0].opts.stdio, "inherit", "curl's output is the response");
  });

  it("refuses a URL or a header dump with exit 2 and never runs curl", () => {
    resetFakes();
    const { wrapper } = runDirWithSession();
    for (const args of [
      ["https://evil.example/x"],
      ["-i", "/x"],
      ["-H", "x-vercel-protection-bypass: x", "/x"],
    ]) {
      const r = spawnSync(wrapper, args, { encoding: "utf8" });
      assert.equal(r.status, 2, JSON.stringify(args));
      assert.match(r.stderr, /^preview-curl: /);
    }
    assert.ok(!existsSync(path.join(fakeBin, "curl-calls.jsonl")));
  });

  it("refuses once the run is over (private/ gone)", () => {
    const { runDir, wrapper } = runDirWithSession();
    rmSync(path.join(runDir, "private"), { recursive: true, force: true });
    const r = spawnSync(wrapper, ["/api/health"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no preview session/);
  });
});
