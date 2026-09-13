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
//     so a bash caller can branch on it).
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

// Core: spawn `command` with `args`, kill it after `timeoutMs`, return a
// promise resolving to {exitCode, timedOut, signal}. exitCode is the raw child
// exit code on normal exit; on timeout it's TIMEOUT_EXIT_CODE (124). Tests
// inject a fake `spawn` via the parameter directly.
export function runWithTimeout({
  command,
  args = [],
  timeoutMs,
  killGraceMs = KILL_GRACE_MS,
  label = "run-with-timeout",
  spawn = nodeSpawn,
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    let timedOut = false;
    let killTimer = null;

    const fireTimeout = () => {
      timedOut = true;
      // SIGTERM first; if the child is genuinely stuck in a syscall it may
      // ignore it, in which case SIGKILL after the grace window guarantees we
      // exit. .unref() so the SIGKILL timer doesn't hold the event loop open if
      // the child exits cleanly under SIGTERM.
      process.stderr.write(
        `${label}: wall-time cap reached after ${timeoutMs}ms; sending SIGTERM\n`,
      );
      try {
        child.kill("SIGTERM");
      } catch {
        /* child already exited */
      }
      killTimer = setTimeout(() => {
        process.stderr.write(
          `${label}: child ignored SIGTERM for ${killGraceMs}ms; escalating to SIGKILL\n`,
        );
        try {
          child.kill("SIGKILL");
        } catch {
          /* child already exited */
        }
      }, killGraceMs);
      killTimer.unref?.();
    };

    const wallTimer = setTimeout(fireTimeout, timeoutMs);
    wallTimer.unref?.();

    child.once("exit", (code, signal) => {
      clearTimeout(wallTimer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        resolve({ exitCode: TIMEOUT_EXIT_CODE, timedOut: true, signal });
        return;
      }
      // Normal exit: propagate the child's exit code. If killed by an external
      // signal (not us), surface 128+signum like a POSIX shell.
      if (code != null) {
        resolve({ exitCode: code, timedOut: false, signal });
      } else if (signal) {
        const signum = osConstants.signals[signal] ?? 0;
        resolve({ exitCode: 128 + signum, timedOut: false, signal });
      } else {
        resolve({ exitCode: 1, timedOut: false, signal });
      }
    });

    child.once("error", (err) => {
      clearTimeout(wallTimer);
      if (killTimer) clearTimeout(killTimer);
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
