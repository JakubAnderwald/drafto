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
//     the child leads its own process group. The cap, or a SIGTERM/SIGINT/
//     SIGHUP this wrapper receives, signals the whole group and sends it
//     SIGKILL after the grace window, whether or not the leader has exited by
//     then, and the wrapper returns only once the group is gone (bounded; see
//     runWithTimeoutGroup). A timed-out child's descendants in its group
//     (claude's Bash tasks, its background agents) die with it, so none can
//     keep writing to the worktree after the next run starts there.
//     --implement turns it on; every other caller keeps the default above:
//     no detached spawn, no group signals.
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
  groupSettleMs = GROUP_SETTLE_MS,
  pollMs = GROUP_POLL_MS,
} = {}) {
  if (killGroup) {
    return runWithTimeoutGroup({
      command,
      args,
      timeoutMs,
      killGraceMs,
      label,
      spawn,
      signalProcess,
      groupSettleMs,
      pollMs,
    });
  }
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

// After SIGKILL is due, how long to keep polling for the group to be gone
// before giving up and saying so, and how often to poll.
export const GROUP_SETTLE_MS = 10_000;
export const GROUP_POLL_MS = 100;

// Process-group mode (ADR-0084): the child leads its own process group, and
// the wrapper returns only once that whole group is gone, so nothing the child
// started can keep writing after the caller moves on.
//   - Cancelling (the wall cap, a SIGTERM/SIGINT/SIGHUP sent to this wrapper,
//     or the child dying of a signal nobody here sent) signals the group,
//     then sends it SIGKILL after killGraceMs. That timer runs on its own:
//     neither the wall deadline nor the leader exiting cancels it.
//   - Once the leader has exited, the group is polled (kill -0) until it is
//     gone, for at most killGraceMs + groupSettleMs after the cancel. A group
//     still alive then is logged and the wrapper returns anyway.
//   - A leader that exits on its own with a code is a normal exit: the result
//     resolves at once, as in the default mode.
// Descendants that leave the group (setsid, a daemon) are out of reach.
function runWithTimeoutGroup({
  command,
  args,
  timeoutMs,
  killGraceMs,
  label,
  spawn,
  signalProcess,
  groupSettleMs,
  pollMs,
}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", detached: true });
    const pgid = child.pid;
    let timedOut = false;
    let cancelledAt = null;
    let killTimer = null;
    let wallTimer = null;
    let exit = null;
    let settled = false;

    const signalGroup = (sig) => {
      try {
        if (pgid) signalProcess.kill(-pgid, sig);
        else child.kill(sig);
      } catch {
        /* the group is already gone */
      }
    };
    const groupAlive = () => {
      if (!pgid) return false;
      try {
        signalProcess.kill(-pgid, 0);
        return true;
      } catch (err) {
        return err?.code === "EPERM";
      }
    };

    const cancel = (sig, why) => {
      if (cancelledAt != null) return;
      cancelledAt = Date.now();
      process.stderr.write(`${label}: ${why}; sending ${sig} to process group ${pgid}\n`);
      signalGroup(sig);
      killTimer = setTimeout(() => {
        if (!groupAlive()) return;
        process.stderr.write(
          `${label}: process group ${pgid} still running ${killGraceMs}ms after ${sig}; escalating to SIGKILL\n`,
        );
        signalGroup("SIGKILL");
      }, killGraceMs);
    };

    const forwarded = ["SIGTERM", "SIGINT", "SIGHUP"];
    const forward = (sig) => cancel(sig, `received ${sig}`);
    for (const sig of forwarded) signalProcess.on?.(sig, forward);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      clearTimeout(killTimer);
      for (const sig of forwarded) signalProcess.off?.(sig, forward);
      resolve(result);
    };

    const resultOf = () => {
      if (timedOut) return { exitCode: TIMEOUT_EXIT_CODE, timedOut: true, signal: exit.signal };
      if (exit.code != null) return { exitCode: exit.code, timedOut: false, signal: exit.signal };
      if (exit.signal) {
        const signum = osConstants.signals[exit.signal] ?? 0;
        return { exitCode: 128 + signum, timedOut: false, signal: exit.signal };
      }
      return { exitCode: 1, timedOut: false, signal: exit.signal };
    };

    // Resolve once the group is gone, or once the bounded wait runs out.
    const awaitGroup = () => {
      const deadline = cancelledAt + killGraceMs + groupSettleMs;
      const poll = () => {
        if (!groupAlive()) return finish(resultOf());
        if (Date.now() >= deadline) {
          process.stderr.write(
            `${label}: process group ${pgid} survived SIGKILL; returning anyway\n`,
          );
          return finish(resultOf());
        }
        setTimeout(poll, pollMs);
      };
      poll();
    };

    wallTimer = setTimeout(() => {
      timedOut = true;
      cancel("SIGTERM", `wall-time cap reached after ${timeoutMs}ms`);
    }, timeoutMs);

    child.once("exit", (code, signal) => {
      clearTimeout(wallTimer);
      exit = { code, signal };
      if (cancelledAt == null) {
        // A normal exit resolves at once. A leader killed by a signal nobody
        // here sent still gets its group cleaned up first.
        if (signal == null) return finish(resultOf());
        cancel("SIGTERM", `child killed by ${signal}`);
      }
      awaitGroup();
    });

    child.once("error", (err) => {
      process.stderr.write(`${label}: spawn failed: ${err.message}\n`);
      finish({ exitCode: SPAWN_FAILURE_EXIT_CODE, timedOut: false, signal: null });
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
