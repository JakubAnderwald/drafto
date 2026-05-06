#!/usr/bin/env node
// Thin wrapper around `claude -p` that bounds wall time. macOS doesn't ship
// `timeout(1)` and we don't want a new Homebrew dep on the Mac mini, so we
// implement the exit-124-on-cap convention in Node.
//
// Why this exists: 2026-05-05 23:24 — `support-agent.sh --auto-classify`
// invoked `claude -p`, the child opened an HTTPS connection to the Anthropic
// API, and the read hung for 7+ hours (15 s CPU, S state). The parent bash
// `wait()`ed forever, holding the loop's mkdir mutex, so every subsequent
// 60-second launchd tick was a no-op. There's no `claude --timeout` flag,
// and the script's existing "claude exited non-zero → log + continue" path
// works fine — it just never fires when the call hangs. This wrapper closes
// that gap.
//
// Behaviour:
//   - On normal child exit: propagate the child's exit code unchanged.
//   - On wall-time cap (CLAUDE_CALL_TIMEOUT_SEC, default 180): SIGTERM the
//     child, escalate to SIGKILL after 5 s if it didn't exit, and exit 124.
//     124 matches coreutils `timeout(1)` so the bash caller can branch on it.
//   - All argv after the script name is forwarded verbatim to `claude`.
//
// stdio is `inherit`ed so the bash caller's existing redirects keep working
// (stdout → tempfile, stderr → log). The wrapper itself prints nothing.

import { spawn as nodeSpawn } from "node:child_process";
import { isMainModule } from "./is-main.mjs";

const DEFAULT_TIMEOUT_SEC = 180;
const KILL_GRACE_MS = 5000;
const TIMEOUT_EXIT_CODE = 124;

// Pure: read the budget from env, falling back to the default. Exported so
// tests can verify the env-override path without spawning anything.
export function resolveTimeoutSec(env = process.env) {
  const raw = env.CLAUDE_CALL_TIMEOUT_SEC;
  if (raw == null || raw === "") return DEFAULT_TIMEOUT_SEC;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC;
  return n;
}

// Inject-able for tests. Mirrors the `_setExecFileForTests` pattern in
// scripts/lib/github-sync.mjs.
let _spawnForTests = null;
export function _setSpawnForTests(impl) {
  _spawnForTests = impl;
}

// Core: spawn `command` with `args`, kill it after `timeoutMs`, return a
// promise resolving to {exitCode, timedOut}. exitCode is the raw child exit
// code on normal exit; on timeout it's TIMEOUT_EXIT_CODE (124). The caller
// is responsible for translating that into a process.exit() if running as
// a CLI.
export function runClaudeWithTimeout({
  command = "claude",
  args = [],
  timeoutMs,
  killGraceMs = KILL_GRACE_MS,
  spawn = _spawnForTests ?? nodeSpawn,
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit" });
    let timedOut = false;
    let killTimer = null;

    const fireTimeout = () => {
      timedOut = true;
      // SIGTERM first; if the child is genuinely stuck in a syscall it may
      // ignore it, in which case SIGKILL after the grace window guarantees
      // we exit. .unref() so the SIGKILL timer doesn't hold the event loop
      // open if the child exits cleanly under SIGTERM.
      try {
        child.kill("SIGTERM");
      } catch {
        /* child already exited */
      }
      killTimer = setTimeout(() => {
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
      // Normal exit: propagate the child's exit code. If killed by an
      // external signal (not us), surface 128+sig like a shell would.
      if (code != null) {
        resolve({ exitCode: code, timedOut: false, signal });
      } else if (signal) {
        resolve({ exitCode: 128, timedOut: false, signal });
      } else {
        resolve({ exitCode: 1, timedOut: false, signal });
      }
    });

    child.once("error", (err) => {
      clearTimeout(wallTimer);
      if (killTimer) clearTimeout(killTimer);
      // spawn() failed (e.g. ENOENT — `claude` not on PATH). Surface a
      // distinct exit code so the bash caller doesn't confuse it with a
      // claude-side error or a timeout.
      process.stderr.write(`run-claude: spawn failed: ${err.message}\n`);
      resolve({ exitCode: 127, timedOut: false, signal: null });
    });
  });
}

// CLI entrypoint. Invoked by support-agent.sh as:
//   node scripts/lib/run-claude.mjs -p "$INPUT" --dangerously-skip-permissions
async function main() {
  const args = process.argv.slice(2);
  const timeoutSec = resolveTimeoutSec();
  const { exitCode } = await runClaudeWithTimeout({
    args,
    timeoutMs: timeoutSec * 1000,
  });
  process.exit(exitCode);
}

if (isMainModule(import.meta.url)) {
  main();
}
