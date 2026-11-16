#!/usr/bin/env node
// Generic wrapper that bounds a child process's wall time. macOS doesn't ship
// `timeout(1)` and we avoid a new Homebrew dep on the Mac mini, so we implement
// the exit-124-on-cap convention in Node. `scripts/lib/run-claude.mjs` is the
// claude-specific sibling that delegates to this core.
//
// Why this exists, beyond claude: the factory's per-worktree `pnpm install`
// (factory-agent.sh) ran for 3.5+ hours on #451 because the pnpm store lives on
// an external volume and a cold install cross-device-copies ~2000 packages.
// Nothing bounded it, so a stuck install held the implement lock for hours and
// starved every other card. Wrapping install (and any other long child) in a
// wall-clock cap closes that gap the same way run-claude.mjs did for hung
// `claude -p` calls.
//
// Behaviour:
//   - Normal child exit: propagate the child's exit code unchanged.
//   - Wall-time cap (timeoutMs): SIGTERM the child, escalate to SIGKILL after a
//     grace window, and resolve exit code 124 (matches coreutils `timeout(1)`
//     so a bash caller can branch on it). The grace window is 5 s unless the
//     env sets CLAUDE_CALL_KILL_GRACE_SEC: --implement gives claude 30 s
//     (FACTORY_IMPLEMENT_TERM_GRACE_SEC), so it can write the interrupted tool
//     call to its transcript before the SIGKILL and the session can be resumed
//     (ADR-0084).
//   - Process-group mode (killGroup, or CLAUDE_CALL_KILL_GROUP=1 in the env):
//     the child leads its own process group, and SIGTERM, SIGKILL and any
//     SIGTERM/SIGINT/SIGHUP this wrapper receives go to the whole group. A
//     timed-out child's descendants (claude's Bash tasks, its background
//     agents) are killed with it, so none can keep writing to the worktree
//     after the next run starts there. --implement turns it on; every other
//     caller keeps signalling the direct child only.
//   - spawn() failure (e.g. ENOENT): resolve exit code 127.
//
// stdio is `inherit`ed so the caller's existing redirects keep working.

import { spawn as nodeSpawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { isMainModule } from "./is-main.mjs";

export const KILL_GRACE_MS = 5000;
export const TIMEOUT_EXIT_CODE = 124;
export const SPAWN_FAILURE_EXIT_CODE = 127;
export const USAGE_EXIT_CODE = 2;

// Pure: the SIGTERM → SIGKILL grace window from CLAUDE_CALL_KILL_GRACE_SEC
// (whole seconds), or KILL_GRACE_MS when it is unset or not a positive integer.
// It is read wherever runWithTimeout is not given one, so the bash caller sets
// it for one call with an inline env prefix.
export function resolveKillGraceMs(env = process.env) {
  const raw = env.CLAUDE_CALL_KILL_GRACE_SEC;
  if (raw == null || !/^[1-9][0-9]*$/.test(String(raw).trim())) return KILL_GRACE_MS;
  return Number.parseInt(String(raw).trim(), 10) * 1000;
}

// Pure: process-group mode from CLAUDE_CALL_KILL_GROUP ("1" only).
export function resolveKillGroup(env = process.env) {
  return String(env.CLAUDE_CALL_KILL_GROUP ?? "").trim() === "1";
}

// Core: spawn `command` with `args`, kill it after `timeoutMs`, return a
// promise resolving to {exitCode, timedOut, signal}. exitCode is the raw child
// exit code on normal exit; on timeout it's TIMEOUT_EXIT_CODE (124). Tests
// inject a fake `spawn` via the parameter directly.
export function runWithTimeout({
  command,
  args = [],
  timeoutMs,
  killGraceMs = resolveKillGraceMs(),
  label = "run-with-timeout",
  spawn = nodeSpawn,
  killGroup = resolveKillGroup(),
  signalProcess = process,
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      command,
      args,
      killGroup ? { stdio: "inherit", detached: true } : { stdio: "inherit" },
    );
    let timedOut = false;
    let killTimer = null;
    // Group mode signals -pid (every process in the child's group); otherwise
    // the child alone, as before.
    const signal = (sig) => {
      try {
        if (killGroup && child.pid) signalProcess.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    // A detached group no longer gets the signals sent to ours (launchd
    // stopping the job, a Ctrl-C): pass them on.
    const forwarded = ["SIGTERM", "SIGINT", "SIGHUP"];
    const forward = (sig) => signal(sig);
    if (killGroup) for (const sig of forwarded) signalProcess.on?.(sig, forward);
    const unforward = () => {
      if (killGroup) for (const sig of forwarded) signalProcess.off?.(sig, forward);
    };

    const fireTimeout = () => {
      timedOut = true;
      // SIGTERM first; if the child is genuinely stuck in a syscall it may
      // ignore it, in which case SIGKILL after the grace window guarantees we
      // exit. .unref() so the SIGKILL timer doesn't hold the event loop open if
      // the child exits cleanly under SIGTERM.
      process.stderr.write(
        `${label}: wall-time cap reached after ${timeoutMs}ms; sending SIGTERM\n`,
      );
      signal("SIGTERM");
      killTimer = setTimeout(() => {
        process.stderr.write(
          `${label}: child ignored SIGTERM for ${killGraceMs}ms; escalating to SIGKILL\n`,
        );
        signal("SIGKILL");
      }, killGraceMs);
      killTimer.unref?.();
    };

    const wallTimer = setTimeout(fireTimeout, timeoutMs);
    wallTimer.unref?.();

    child.once("exit", (code, exitSignal) => {
      clearTimeout(wallTimer);
      if (killTimer) clearTimeout(killTimer);
      unforward();
      if (timedOut) {
        // The child is gone; in group mode take whatever it left running
        // (descendants that ignored SIGTERM) down with it.
        if (killGroup) signal("SIGKILL");
        resolve({ exitCode: TIMEOUT_EXIT_CODE, timedOut: true, signal: exitSignal });
        return;
      }
      // Normal exit: propagate the child's exit code. If killed by an external
      // signal (not us), surface 128+signum like a POSIX shell.
      if (code != null) {
        resolve({ exitCode: code, timedOut: false, signal: exitSignal });
      } else if (exitSignal) {
        const signum = osConstants.signals[exitSignal] ?? 0;
        resolve({ exitCode: 128 + signum, timedOut: false, signal: exitSignal });
      } else {
        resolve({ exitCode: 1, timedOut: false, signal: exitSignal });
      }
    });

    child.once("error", (err) => {
      clearTimeout(wallTimer);
      if (killTimer) clearTimeout(killTimer);
      unforward();
      // spawn() failed (e.g. ENOENT — command not on PATH). Surface a distinct
      // exit code so the caller doesn't confuse it with a child-side error or a
      // timeout.
      process.stderr.write(`${label}: spawn failed: ${err.message}\n`);
      resolve({ exitCode: SPAWN_FAILURE_EXIT_CODE, timedOut: false, signal: null });
    });
  });
}

// Pure: parse `<timeoutSec> <command> [args...]`. Returns null on bad input so
// the CLI can print usage and exit 2. Exported for tests.
export function parseCliArgs(argv) {
  const [secRaw, command, ...args] = argv;
  const sec = Number.parseInt(secRaw, 10);
  if (!Number.isFinite(sec) || sec <= 0 || !command) return null;
  return { timeoutMs: sec * 1000, command, args };
}

// CLI entrypoint:
//   node run-with-timeout.mjs <timeoutSec> <command> [args...]
async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed) {
    process.stderr.write("usage: run-with-timeout.mjs <timeoutSec> <command> [args...]\n");
    process.exit(USAGE_EXIT_CODE);
  }
  const { exitCode } = await runWithTimeout(parsed);
  process.exit(exitCode);
}

if (isMainModule(import.meta.url)) {
  main();
}
