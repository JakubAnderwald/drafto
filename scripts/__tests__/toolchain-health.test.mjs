import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyFailure,
  decide,
  performActions,
  recordSuccess,
  emailContent,
  issueBody,
  runProbes,
  PAUSE_REASON_PREFIX,
  REMINDER_MS,
} from "../lib/toolchain-health.mjs";
import { emptyFactoryState, pauseFactory, pauseFactoryUntil } from "../lib/factory-state.mjs";

// Guards the toolchain health check added after the 2026-10-04 outage, where
// an unaccepted Xcode license broke every git call for ~3 hours while the
// factory kept exiting 0 and nobody was told.

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "lib", "toolchain-health.mjs");
const loopPath = resolve(here, "..", "factory-agent-loop.sh");
const agentPath = resolve(here, "..", "factory-agent.sh");

const XCODE_MSG =
  "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license' " +
  "from within a Terminal window to review and agree to the Xcode and Apple SDKs license.";

const broken = {
  healthy: false,
  failures: [
    {
      tool: "git",
      cmd: "git --version",
      exitCode: 69,
      stderr: XCODE_MSG,
      class: "xcode-license",
      hint: "sudo xcodebuild -license accept",
    },
  ],
  signature: "git:xcode-license",
};
const healthy = { healthy: true, failures: [], signature: null };

const T0 = "2026-10-04T10:00:00.000Z";
const T1 = "2026-10-04T10:05:00.000Z";
const T2 = "2026-10-04T10:10:00.000Z";

describe("classifyFailure", () => {
  it("recognises the Xcode license fault and hands over the sudo fix", () => {
    const c = classifyFailure(XCODE_MSG);
    assert.equal(c.class, "xcode-license");
    assert.match(c.hint, /sudo xcodebuild -license accept/);
  });

  it("recognises a missing developer path, a missing binary and a timeout", () => {
    assert.equal(
      classifyFailure(
        "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)",
      ).class,
      "xcode-developer-path",
    );
    assert.equal(classifyFailure("ENOENT").class, "not-found");
    assert.equal(classifyFailure("ETIMEDOUT").class, "timeout");
    assert.equal(classifyFailure("fatal: something odd").class, "other");
  });
});

describe("runProbes", () => {
  const ok = { status: 0, stdout: "ok", stderr: "" };

  it("is healthy when every probe exits 0", () => {
    const r = runProbes([["git", "git", ["--version"]]], { spawn: () => ok });
    assert.deepEqual(r, { healthy: true, failures: [], signature: null });
  });

  it("reports one failure per tool, classified, with a stable signature", () => {
    const spawn = (cmd) => (cmd === "git" ? { status: 69, stdout: "", stderr: XCODE_MSG } : ok);
    const r = runProbes(
      [
        ["git", "git", ["--version"]],
        ["git", "git", ["rev-parse", "HEAD"]],
        ["gh", "gh", ["--version"]],
      ],
      { spawn },
    );
    assert.equal(r.healthy, false);
    assert.equal(r.failures.length, 1, "second git probe is skipped once git has failed");
    assert.equal(r.failures[0].class, "xcode-license");
    assert.equal(r.failures[0].exitCode, 69);
    assert.equal(r.signature, "git:xcode-license");
  });

  it("treats a spawn error (missing binary) as a failure", () => {
    const err = Object.assign(new Error("spawnSync claude ENOENT"), { code: "ENOENT" });
    const r = runProbes([["claude", "claude", ["--version"]]], {
      spawn: () => ({ error: err, status: null }),
    });
    assert.equal(r.failures[0].class, "not-found");
  });
});

// Run decide() and treat every side effect as having succeeded.
function tick(s, probe, now) {
  const actions = decide(s, probe, { now });
  for (const a of actions) {
    recordSuccess(s, a, { now, issueNumber: a.type === "create-issue" ? 700 : undefined });
  }
  return actions;
}
const types = (actions) => actions.map((a) => a.type);

describe("decide", () => {
  it("does nothing on a healthy tick with no open incident", () => {
    const s = emptyFactoryState();
    assert.deepEqual(decide(s, healthy, { now: T0 }), []);
    assert.equal(s.toolchainIncident, null);
  });

  it("stays quiet below the threshold, then pauses and alerts once", () => {
    const s = emptyFactoryState();
    assert.deepEqual(tick(s, broken, T0), [], "first failure: no pause, no alert");
    assert.equal(s.paused, false);
    assert.equal(s.toolchainIncident.consecutive, 1);

    assert.deepEqual(types(tick(s, broken, T1)), ["pause", "create-issue", "email"]);
    assert.equal(s.paused, true);
    assert.ok(s.pausedReason.startsWith(PAUSE_REASON_PREFIX));
    assert.equal(s.pausedUntil, null);
    assert.equal(s.toolchainIncident.since, T0);
    assert.equal(s.toolchainIncident.issueNumber, 700);

    assert.deepEqual(tick(s, broken, T2), [], "same fault next tick: no repeat alert");
  });

  it("retries a failed email next tick without refiling a filed issue", () => {
    const s = emptyFactoryState();
    tick(s, broken, T0);
    const a = decide(s, broken, { now: T1 });
    // Only the issue succeeded; the email failed.
    recordSuccess(
      s,
      a.find((x) => x.type === "create-issue"),
      { now: T1, issueNumber: 700 },
    );
    assert.deepEqual(decide(s, broken, { now: T2 }), [
      { type: "email", kind: "broken", signature: "git:xcode-license" },
    ]);
  });

  it("sends one reminder after 24h of the same fault, retrying until it is sent", () => {
    const s = emptyFactoryState();
    tick(s, broken, T0);
    tick(s, broken, T1);
    const later = new Date(Date.parse(T1) + REMINDER_MS).toISOString();
    assert.deepEqual(types(decide(s, broken, { now: later })), ["email"], "reminder due");
    assert.deepEqual(types(tick(s, broken, later)), ["email"], "failed reminder is retried");
    assert.deepEqual(tick(s, broken, later), [], "sent: no more reminders");
  });

  it("re-alerts on a different fault, commenting on the existing issue", () => {
    const s = emptyFactoryState();
    tick(s, broken, T0);
    tick(s, broken, T1);
    const other = {
      healthy: false,
      failures: [{ ...broken.failures[0], tool: "gh", class: "not-found" }],
      signature: "gh:not-found",
    };
    const a = tick(s, other, T2);
    assert.deepEqual(types(a), ["comment-issue", "email"]);
    assert.equal(a[0].issueNumber, 700);
    assert.match(s.pausedReason, /gh broken/);
  });

  it("recovers: resumes its own pause, closes the issue, emails, clears the incident", () => {
    const s = emptyFactoryState();
    tick(s, broken, T0);
    tick(s, broken, T1);
    const a = decide(s, healthy, { now: T2 });
    assert.deepEqual(types(a), ["resume", "resolve-issue", "email"]);
    assert.equal(a[1].issueNumber, 700);
    assert.equal(a[2].kind, "recovered");
    assert.equal(s.paused, false);
    assert.equal(s.toolchainIncident, null);
  });

  it("recovers silently from a sub-threshold blip", () => {
    const s = emptyFactoryState();
    tick(s, broken, T0);
    assert.deepEqual(decide(s, healthy, { now: T1 }), []);
    assert.equal(s.toolchainIncident, null);
  });

  it("never overwrites or resumes a manual pause set before the fault, but still alerts", () => {
    const s = emptyFactoryState();
    pauseFactory(s, { reason: "operator: holiday", now: T0 });
    tick(s, broken, T0);
    assert.deepEqual(types(tick(s, broken, T1)), ["create-issue", "email"]);
    assert.equal(s.pausedReason, "operator: holiday");

    const r = decide(s, healthy, { now: T2 });
    assert.ok(!r.some((x) => x.type === "resume"));
    assert.equal(s.paused, true);
    assert.equal(s.pausedReason, "operator: holiday");
  });

  it("a manual re-pause during an incident is taken over by the operator, never auto-resumed", () => {
    const s = emptyFactoryState();
    tick(s, broken, T0);
    tick(s, broken, T1);
    pauseFactory(s, { reason: "operator: hold", now: T1 });
    tick(s, broken, T2);
    assert.equal(s.pausedReason, "operator: hold", "reason must not be rewritten");
    const later = "2026-10-04T10:15:00.000Z";
    assert.ok(!decide(s, healthy, { now: later }).some((x) => x.type === "resume"));
    assert.equal(s.paused, true);
  });

  it("resumes an orphaned toolchain pause even with no incident on record", () => {
    const s = emptyFactoryState();
    pauseFactory(s, { reason: `${PAUSE_REASON_PREFIX} git broken (xcode-license)`, now: T0 });
    assert.deepEqual(types(decide(s, healthy, { now: T1 })), ["resume"]);
    assert.equal(s.paused, false);
  });

  it("clears an expired timed pause and takes the pause over", () => {
    const s = emptyFactoryState();
    pauseFactoryUntil(s, { until: T0, reason: "claude session limit", now: T0 });
    tick(s, broken, T1);
    assert.deepEqual(types(tick(s, broken, T2)), ["pause", "create-issue", "email"]);
    assert.ok(s.pausedReason.startsWith(PAUSE_REASON_PREFIX));
  });
});

describe("performActions", () => {
  const ok = { status: 0, stdout: "", stderr: "" };

  it("keeps a tombstone when closing the issue fails, and retries only the close", () => {
    const s = emptyFactoryState();
    tick(s, broken, T0);
    tick(s, broken, T1);
    const actions = decide(s, healthy, { now: T2 });
    const spawn = (cmd, args) =>
      cmd === "gh" && args[1] === "close" ? { status: 1, stdout: "", stderr: "502" } : ok;
    performActions(actions, { state: s, failures: [], to: "x@y", zohoCli: "z", now: T2, spawn });
    assert.equal(s.toolchainIncident.recovered, true);
    assert.equal(s.toolchainIncident.issueNumber, 700);
    const retry = decide(s, healthy, { now: T2 });
    assert.deepEqual(types(retry), ["resolve-issue"], "only the close is retried; no second email");
    assert.equal(retry[0].issueNumber, 700);
    assert.equal(s.toolchainIncident, null);
  });
});

describe("toolchain-health CLI end to end (PATH-stubbed git / gh / claude / zoho)", () => {
  let dir;
  let bin;
  let calls;
  let stateFile;
  let zoho;

  function stub(name, script) {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/bash\n${script}\n`);
    chmodSync(p, 0o755);
  }

  function run() {
    return spawnSync(
      process.execPath,
      [
        cli,
        "check",
        "--repo",
        dir,
        "--state-file",
        stateFile,
        "--zoho-cli",
        zoho,
        "--to",
        "op@example.com",
      ],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
  }

  function logged() {
    return existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "toolchain-health-"));
    bin = join(dir, "bin");
    spawnSync("mkdir", ["-p", bin]);
    calls = join(dir, "calls.log");
    stateFile = join(dir, "factory-state.json");
    zoho = join(dir, "zoho-stub.mjs");
    writeFileSync(
      zoho,
      `import { appendFileSync } from "node:fs";\n` +
        `appendFileSync(${JSON.stringify(calls)}, "zoho " + process.argv.slice(2, 6).join(" ") + "\\n");\n`,
    );
    stub(
      "gh",
      `if [[ "$1" == "--version" ]]; then echo "gh version 2.0.0"; exit 0; fi\n` +
        `echo "gh $1 $2 $3" >> ${JSON.stringify(calls)}\n` +
        `if [[ "$1 $2" == "issue create" ]]; then echo "https://github.com/JakubAnderwald/drafto/issues/777"; fi`,
    );
    stub("claude", "echo 2.0.0");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("Xcode-license git: skips, then pauses + issues + emails once, then recovers", () => {
    stub("git", `echo "${XCODE_MSG}" >&2; exit 69`);

    let r = run();
    assert.equal(r.status, 3, r.stderr);
    assert.equal(JSON.parse(r.stdout).failures[0].class, "xcode-license");
    assert.deepEqual(logged(), [], "below threshold: no alerts");

    r = run();
    assert.equal(r.status, 3, r.stderr);
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.paused, true);
    assert.match(state.pausedReason, /^toolchain: git broken \(xcode-license\)/);
    assert.equal(state.toolchainIncident.issueNumber, 777);
    const afterAlert = logged();
    assert.equal(afterAlert.filter((l) => l.startsWith("gh issue create")).length, 1);
    assert.equal(afterAlert.filter((l) => l.startsWith("zoho send")).length, 1);
    assert.ok(afterAlert.some((l) => l.includes("--to op@example.com")));

    r = run();
    assert.equal(r.status, 3);
    assert.deepEqual(logged(), afterAlert, "third tick of the same fault adds no alerts");

    // Fixed: git works again.
    stub("git", "echo git version 2.54.0");
    r = run();
    assert.equal(r.status, 0, r.stderr);
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.paused, false);
    assert.equal(state.toolchainIncident, null);
    const final = logged();
    assert.ok(final.some((l) => l.startsWith("gh issue close")));
    assert.equal(final.filter((l) => l.startsWith("zoho send")).length, 2, "one recovery email");
  });

  it("a failed email is retried next tick while the filed issue is not refiled", () => {
    stub("git", `echo "${XCODE_MSG}" >&2; exit 69`);
    const realZoho = readFileSync(zoho, "utf8");
    writeFileSync(zoho, realZoho + "process.exit(1);\n");
    run();
    run();
    let state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.toolchainIncident.issueNumber, 777);
    assert.equal(state.toolchainIncident.emailSignature, null, "failed send is not recorded");

    writeFileSync(zoho, realZoho);
    run();
    state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.toolchainIncident.emailSignature, "git:xcode-license");
    const lines = logged();
    assert.equal(lines.filter((l) => l.startsWith("gh issue create")).length, 1);
    assert.equal(lines.filter((l) => l.startsWith("zoho send")).length, 2, "failed + retried send");
  });

  it("--dry-run reports the planned actions without writing state or alerting", () => {
    stub("git", `echo "${XCODE_MSG}" >&2; exit 69`);
    writeFileSync(
      stateFile,
      JSON.stringify({
        ...emptyFactoryState(),
        toolchainIncident: {
          signature: "git:xcode-license",
          since: T0,
          consecutive: 1,
          issueNumber: null,
          issueSignature: null,
          emailSignature: null,
          lastEmailAt: null,
        },
      }),
    );
    const before = readFileSync(stateFile, "utf8");
    const r = spawnSync(
      process.execPath,
      [cli, "check", "--repo", dir, "--state-file", stateFile, "--zoho-cli", zoho, "--dry-run"],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
    assert.equal(r.status, 3);
    assert.deepEqual(
      JSON.parse(r.stdout).actions.map((a) => a.type),
      ["pause", "create-issue", "email"],
    );
    assert.equal(readFileSync(stateFile, "utf8"), before);
    assert.deepEqual(logged(), []);
  });
});

describe("loop + agent wiring", () => {
  const loop = readFileSync(loopPath, "utf8");
  const agent = readFileSync(agentPath, "utf8");

  it("runs the health check after self-update, skipping the tick only on exit 3", () => {
    const health = loop.indexOf('lib/toolchain-health.mjs" check');
    const selfUpdate = loop.indexOf("fetch --quiet origin main");
    const modes = loop.indexOf('/bin/bash "$AGENT" --plan');
    assert.ok(health > 0, "loop must call toolchain-health check");
    assert.ok(
      selfUpdate < health,
      "self-update must run first so a bad check can be fixed by merging",
    );
    assert.ok(health < modes, "health check must gate the modes");
    assert.match(
      loop,
      /\|\| _health_rc=\$\?/,
      "check exit code is captured, not fatal under set -e",
    );
    assert.match(loop, /"\$_health_rc" -eq 3 \]\]; then[\s\S]*?skipping this tick[\s\S]*?exit 0/);
    assert.match(loop, /check itself failed \(rc=\$_health_rc\); running the tick anyway/);
  });

  it("self-update no longer discards git's stderr or guesses 'offline'", () => {
    assert.doesNotMatch(loop, /fetch --quiet origin main 2>\/dev\/null/);
    assert.doesNotMatch(loop, /FAILED \(offline\?\)/);
  });

  it("worktree failure lines carry worktree-cli's error text", () => {
    assert.match(agent, /^worktree_cli_error\(\) \{/m);
    assert.match(
      agent,
      /worktree add failed for #\$ISSUE_NUM: \$\(worktree_cli_error "\$WT_ERR_FILE"\)/,
    );
    assert.match(
      agent,
      /worktree resume failed for #\$ISSUE_NUM: \$\(worktree_cli_error "\$WT_ERR_FILE"\)/,
    );
  });
});
