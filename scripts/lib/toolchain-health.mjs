#!/usr/bin/env node
// Host-toolchain health check for the dark factory.
//
// Why this exists: 2026-10-04 — an Xcode 27 update landed on the Mac mini with
// its license unaccepted, and from then on every /usr/bin/git call died with
// "You have not agreed to the Xcode license agreements". For ~3 hours every
// tick failed `worktree add` / `worktree resume` (71 times), self-update logged
// a misleading "fetch origin main FAILED (offline?)", each mode still exited 0
// (so no factory-failure issue was filed), and nobody was told. gh-only steps
// kept working, so the board looked alive.
//
// factory-agent-loop.sh runs `check` every tick, right after self-update (so a
// bad commit here can always be fixed by merging to main) and before the
// modes. It probes the local tools the factory can't work without and, when
// one is broken:
//   - pauses the factory with a `toolchain:` reason. The prefix is the
//     ownership marker: a pause with any other reason (set by hand, even
//     mid-incident) is never rewritten or resumed,
//   - emails the operator via zoho-cli (GitHub doesn't notify Jakub about
//     issues his own token files) and files one deduplicated factory-failure
//     issue as the record, with the exact fix. Each channel is retried every
//     tick until it succeeds,
//   - re-sends one reminder email a day while the fault persists.
// When the probes pass again it resumes its own pause, closes the issue
// (retrying the close if it fails) and sends a recovery email — no operator
// step beyond fixing the host. The loop treats any exit other than 3 as a
// crash of this check and runs the tick anyway (fail open).
//
// Probes are local-only (no network) so an internet blip can't trip them, and
// a fault must persist for --threshold consecutive ticks (default 2) before
// the factory pauses or alerts, so a one-off timeout under load stays quiet.
// The loop still skips a tick on the first failure — git is broken either way.
//
// CLI:
//   node toolchain-health.mjs check --repo <dir> [--state-file <f>]
//        [--to <email>] [--threshold <n>] [--zoho-cli <path>] [--dry-run]
//
//   Exit 0 — healthy. Exit 3 — unhealthy (the caller skips the tick).
//   Prints one JSON line: {healthy, failures:[…], signature, actions:[…]}.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./is-main.mjs";
import {
  DEFAULT_FACTORY_STATE_PATH,
  clearExpiredPause,
  isFactoryPaused,
  loadFactoryState,
  pauseFactory,
  resumeFactory,
  saveFactoryState,
} from "./factory-state.mjs";

export const PAUSE_REASON_PREFIX = "toolchain:";
export const ISSUE_MARKER_PREFIX = "drafto-factory-toolchain";
export const DEFAULT_THRESHOLD = 2;
export const REMINDER_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;
const REPO_NWO = "JakubAnderwald/drafto";
const DEFAULT_TO = "jakub@anderwald.info";
const DEFAULT_ZOHO_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "zoho-cli.mjs");

// Known failure signatures → a stable class and the fix to hand the operator.
// Order matters: the first match wins.
const CLASSES = [
  {
    id: "xcode-license",
    test: /Xcode license|xcodebuild -license/i,
    hint:
      "Accept the new Xcode license in a real Terminal on the Mac mini (sudo cannot " +
      "prompt under launchd or a Claude `!` command): `sudo xcodebuild -license accept`",
  },
  {
    id: "xcode-developer-path",
    test: /invalid active developer path|xcrun: error/i,
    hint: "Reinstall the Command Line Tools: `xcode-select --install` (or `sudo xcode-select -s /Applications/Xcode.app`)",
  },
  {
    id: "not-found",
    test: /ENOENT|command not found|not found in PATH/i,
    hint: "The binary is missing from launchd's PATH — check it is installed and that the factory plist's PATH includes it.",
  },
  {
    id: "timeout",
    test: /ETIMEDOUT|timed out/i,
    hint: "The probe hung. Check the Mac mini for a stuck process or a pending system dialog.",
  },
];

// Each probe is [tool, cmd, args]. `git rev-parse` in the factory checkout
// catches a corrupt repo as well as a broken binary.
export function defaultProbes(repo) {
  return [
    ["git", "git", ["--version"]],
    ["git", "git", ["-C", repo, "rev-parse", "HEAD"]],
    ["gh", "gh", ["--version"]],
    ["claude", "claude", ["--version"]],
  ];
}

export function classifyFailure(text) {
  for (const c of CLASSES) {
    if (c.test.test(text)) return { class: c.id, hint: c.hint };
  }
  return { class: "other", hint: null };
}

function firstLine(text) {
  return (
    String(text ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? ""
  );
}

export function runProbes(probes, { spawn = spawnSync, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const failures = [];
  for (const [tool, cmd, args] of probes) {
    // Once a tool has failed, its remaining probes would only repeat the error.
    if (failures.some((f) => f.tool === tool)) continue;
    const res = spawn(cmd, args, { encoding: "utf8", timeout: timeoutMs });
    if (!res.error && res.status === 0) continue;
    const stderr = String(
      res.error ? (res.error.code ?? res.error.message) : res.stderr || res.stdout || "",
    ).trim();
    const { class: cls, hint } = classifyFailure(stderr);
    failures.push({
      tool,
      cmd: [cmd, ...args].join(" "),
      exitCode: typeof res.status === "number" ? res.status : null,
      stderr: stderr.slice(0, 2000),
      class: cls,
      hint: hint ?? `\`${cmd}\` failed: ${firstLine(stderr) || "no output"}`,
    });
  }
  return {
    healthy: failures.length === 0,
    failures,
    signature: failures.length
      ? failures
          .map((f) => `${f.tool}:${f.class}`)
          .sort()
          .join(",")
      : null,
  };
}

export function summarize(failures) {
  return failures.map((f) => `${f.tool} broken (${f.class})`).join("; ");
}

// The factory's pause belongs to this check only while its reason carries the
// `toolchain:` prefix. Ownership is read off the reason itself, not remembered
// in the incident, so an operator who re-pauses by hand mid-incident takes the
// pause over (and it is never auto-resumed), and a toolchain pause orphaned by
// a lost incident record still resumes once the probes pass.
export function ownsPause(state) {
  return Boolean(state?.paused) && String(state.pausedReason ?? "").startsWith(PAUSE_REASON_PREFIX);
}

function freshIncident(now, issueNumber = null) {
  return {
    since: now,
    consecutive: 0,
    signature: null,
    summary: null,
    issueNumber,
    issueSignature: null, // signature last filed/commented on the issue
    emailSignature: null, // signature last emailed successfully
    lastEmailAt: null,
    recovered: false, // healthy again, only the issue close is still pending
  };
}

// State machine: given the loaded state and this tick's probe result, mutate
// state in place and return the side effects to perform. Alert bookkeeping is
// recorded only when a side effect succeeds (recordSuccess), so a failed email
// or issue call is retried on the next tick instead of going quiet.
export function decide(
  state,
  probe,
  { now = new Date().toISOString(), threshold = DEFAULT_THRESHOLD } = {},
) {
  const actions = [];
  // An expired session-limit pause would otherwise read as "already paused"
  // forever: the agent's pause gate that normally clears it never runs while
  // the toolchain is broken.
  clearExpiredPause(state, now);
  const prev = state.toolchainIncident ?? null;

  if (probe.healthy) {
    if (ownsPause(state)) {
      resumeFactory(state);
      actions.push({ type: "resume" });
    }
    if (!prev) return actions;
    if (prev.issueNumber) {
      actions.push({ type: "resolve-issue", issueNumber: prev.issueNumber, incident: prev });
    }
    if (prev.emailSignature && !prev.recovered) {
      actions.push({ type: "email", kind: "recovered", incident: prev });
    }
    state.toolchainIncident = null;
    return actions;
  }

  const incident =
    prev && !prev.recovered ? { ...prev } : freshIncident(now, prev?.issueNumber ?? null);
  incident.signature = probe.signature;
  incident.summary = summarize(probe.failures);
  incident.consecutive += 1;
  state.toolchainIncident = incident;

  if (incident.consecutive < threshold) return actions;

  const reason = `${PAUSE_REASON_PREFIX} ${incident.summary}`;
  if (!isFactoryPaused(state, now)) {
    pauseFactory(state, { reason, now });
    actions.push({ type: "pause", reason });
  } else if (ownsPause(state) && state.pausedReason !== reason) {
    state.pausedReason = reason;
  }

  const sig = incident.signature;
  if (incident.issueSignature !== sig) {
    actions.push({
      type: incident.issueNumber ? "comment-issue" : "create-issue",
      issueNumber: incident.issueNumber,
      signature: sig,
    });
  }
  if (incident.emailSignature !== sig) {
    actions.push({ type: "email", kind: "broken", signature: sig });
  } else if (
    incident.lastEmailAt &&
    Date.parse(now) - Date.parse(incident.lastEmailAt) >= REMINDER_MS
  ) {
    actions.push({ type: "email", kind: "reminder", signature: sig });
  }
  return actions;
}

// Record a side effect that succeeded. A failed one records nothing, so
// decide() asks for it again next tick.
export function recordSuccess(state, action, { now = new Date().toISOString(), issueNumber } = {}) {
  const incident = state.toolchainIncident;
  if (!incident) return;
  if (action.type === "create-issue" || action.type === "comment-issue") {
    if (issueNumber) incident.issueNumber = issueNumber;
    incident.issueSignature = action.signature;
  } else if (action.type === "email" && action.kind !== "recovered") {
    incident.emailSignature = action.signature;
    incident.lastEmailAt = now;
  }
}

// ── message bodies ──────────────────────────────────────────────────────────

function failureDetails(failures) {
  return failures
    .map(
      (f) =>
        `- ${f.tool}: \`${f.cmd}\` exited ${f.exitCode ?? "(no status)"} [${f.class}]\n` +
        `  Fix: ${f.hint}\n` +
        `  Output: ${firstLine(f.stderr) || "(none)"}`,
    )
    .join("\n");
}

export function issueBody(incident, failures, { owned = true } = {}) {
  return [
    `<!-- ${ISSUE_MARKER_PREFIX}:${incident.signature} -->`,
    `The factory's toolchain health check found a broken tool on the Mac mini and ` +
      `${owned ? "**paused the factory**" : "the factory was already paused by hand"} ` +
      `(first seen ${incident.since}).`,
    "",
    "### Failures",
    "",
    failureDetails(failures),
    "",
    "The factory **resumes on its own** on the first tick after the probes pass — " +
      "fixing the host is the only step needed. This issue closes automatically then.",
    "",
    'See `docs/operations/factory-runbook.md` → "Automatic toolchain pause".',
  ].join("\n");
}

export function emailContent(kind, incident, failures, { owned = true } = {}) {
  if (kind === "recovered") {
    return {
      subject: "[drafto factory] toolchain recovered",
      body:
        `The toolchain fault first seen ${incident.since} (${incident.summary}) has cleared.\n\n` +
        (owned
          ? "The factory has resumed and will pick up its cards on this tick.\n"
          : "The factory is still paused by hand; that pause is untouched.\n"),
    };
  }
  const prefix = kind === "reminder" ? "[drafto factory] STILL broken" : "[drafto factory] paused";
  return {
    subject: `${prefix}: ${incident.summary}`,
    body:
      `The dark factory on the Mac mini cannot run: ${incident.summary} (first seen ${incident.since}).\n\n` +
      `${failureDetails(failures)}\n\n` +
      (owned
        ? "The factory is paused and resumes on its own once the probes pass.\n"
        : "The factory is also paused by hand; that pause is untouched.\n") +
      (incident.issueNumber
        ? `\nRecord: https://github.com/${REPO_NWO}/issues/${incident.issueNumber}\n`
        : ""),
  };
}

// ── side effects ────────────────────────────────────────────────────────────

function runCmd(cmd, args, spawn) {
  const res = spawn(cmd, args, { encoding: "utf8", timeout: 60_000 });
  return {
    ok: !res.error && res.status === 0,
    stdout: String(res.stdout ?? ""),
    error: res.error ? String(res.error.message) : String(res.stderr ?? "").trim(),
  };
}

// An open issue from an earlier attempt whose `gh issue create` timed out
// after GitHub had already created it: reuse it rather than file a duplicate.
function findOpenIncidentIssue(spawn) {
  const r = runCmd(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      REPO_NWO,
      "--label",
      "factory-failure",
      "--state",
      "open",
      "--search",
      `"${ISSUE_MARKER_PREFIX}" in:body`,
      "--json",
      "number",
      "--jq",
      ".[0].number // empty",
    ],
    spawn,
  );
  const n = Number(r.stdout.trim());
  return r.ok && Number.isInteger(n) && n > 0 ? n : null;
}

function ghIssueAction(a, { incident, failures, owned, spawn }) {
  const body = issueBody(incident, failures, { owned });
  const existing = a.type === "create-issue" ? findOpenIncidentIssue(spawn) : a.issueNumber;
  if (existing) {
    const r = runCmd(
      "gh",
      ["issue", "comment", String(existing), "--repo", REPO_NWO, "--body", body],
      spawn,
    );
    return { ok: r.ok, issueNumber: existing, error: r.error };
  }
  const r = runCmd(
    "gh",
    [
      "issue",
      "create",
      "--repo",
      REPO_NWO,
      "--label",
      "factory-failure",
      "--title",
      `factory paused: ${incident.summary}`,
      "--body",
      body,
    ],
    spawn,
  );
  const m = r.stdout.match(/\/issues\/(\d+)/);
  return { ok: r.ok && Boolean(m), issueNumber: m ? Number(m[1]) : null, error: r.error };
}

function sendEmail({ subject, body }, { to, zohoCli, spawn }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "factory-health-"));
  const bodyFile = path.join(dir, "body.txt");
  try {
    writeFileSync(bodyFile, body);
    return runCmd(
      process.execPath,
      [zohoCli, "send", "--to", to, "--subject", subject, "--body-file", bodyFile],
      spawn,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function performActions(
  actions,
  { state, failures, to, zohoCli, now = new Date().toISOString(), spawn = spawnSync },
) {
  const owned = ownsPause(state);
  const results = [];
  for (const a of actions) {
    const { incident: snapshot, ...shown } = a;
    if (a.type === "pause" || a.type === "resume") {
      results.push({ ...shown, ok: true });
      continue;
    }
    let r;
    if (a.type === "create-issue" || a.type === "comment-issue") {
      r = ghIssueAction(a, { incident: state.toolchainIncident, failures, owned, spawn });
      if (r.ok) recordSuccess(state, a, { now, issueNumber: r.issueNumber });
    } else if (a.type === "resolve-issue") {
      r = runCmd(
        "gh",
        [
          "issue",
          "close",
          String(a.issueNumber),
          "--repo",
          REPO_NWO,
          "--comment",
          "Toolchain probes pass again. Closing automatically.",
        ],
        spawn,
      );
      // Keep a tombstone so the close is retried next tick rather than the
      // issue being left open with nothing tracking it.
      if (!r.ok) {
        state.toolchainIncident = { ...snapshot, recovered: true, consecutive: 0 };
      }
    } else if (a.type === "email") {
      const incident = a.kind === "recovered" ? snapshot : state.toolchainIncident;
      // A recovery mail reports whether the factory runs again: it does unless
      // an operator's own pause is still in place.
      const ownedNow = a.kind === "recovered" ? !state.paused : owned;
      r = sendEmail(emailContent(a.kind, incident, failures, { owned: ownedNow }), {
        to,
        zohoCli,
        spawn,
      });
      if (r.ok) recordSuccess(state, a, { now });
    } else {
      continue;
    }
    results.push({ ...shown, ok: r.ok, error: r.ok ? undefined : r.error });
  }
  return results;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (key === "dry-run") flags[key] = true;
    else flags[key] = argv[++i];
  }
  return flags;
}

export async function check(argv, { spawn = spawnSync, now = new Date().toISOString() } = {}) {
  const flags = parseFlags(argv);
  if (!flags.repo) throw new Error("--repo required");
  const stateFile = flags["state-file"] ?? DEFAULT_FACTORY_STATE_PATH;
  const threshold = flags.threshold ? Number(flags.threshold) : DEFAULT_THRESHOLD;
  const to = flags.to || process.env.SUPPORT_ADMIN_EMAIL || DEFAULT_TO;
  const zohoCli = flags["zoho-cli"] ?? DEFAULT_ZOHO_CLI;
  const dryRun = Boolean(flags["dry-run"]);

  const probe = runProbes(defaultProbes(flags.repo), { spawn });
  const state = await loadFactoryState(stateFile);
  const actions = decide(state, probe, { now, threshold });

  let results = actions.map(({ incident, ...rest }) => rest);
  if (!dryRun) {
    results = performActions(actions, { state, failures: probe.failures, to, zohoCli, now, spawn });
    await saveFactoryState(state, stateFile);
  }

  return {
    healthy: probe.healthy,
    failures: probe.failures,
    signature: probe.signature,
    dryRun,
    actions: results,
  };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== "check") {
    process.stdout.write(
      "Usage: toolchain-health.mjs check --repo <dir> [--state-file <f>] [--to <email>] " +
        "[--threshold <n>] [--zoho-cli <path>] [--dry-run]\n",
    );
    process.exit(cmd ? 2 : 0);
  }
  const result = await check(rest);
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(result.healthy ? 0 : 3);
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
    process.exit(1);
  });
}
