#!/usr/bin/env node
// Thin claude-specific wrapper around `claude -p` that bounds wall time. The
// timeout mechanics live in scripts/lib/run-with-timeout.mjs (the generic
// sibling); this file only adds the CLAUDE_CALL_TIMEOUT_SEC env budget and the
// `claude` command default.
//
// Why this exists: 2026-05-05 23:24 — `support-agent.sh --auto-classify`
// invoked `claude -p`, the child opened an HTTPS connection to the Anthropic
// API, and the read hung for 7+ hours (15 s CPU, S state). The parent bash
// `wait()`ed forever, holding the loop's mkdir mutex, so every subsequent
// 60-second launchd tick was a no-op. There's no `claude --timeout` flag, and
// the script's existing "claude exited non-zero → log + continue" path works
// fine — it just never fires when the call hangs. This wrapper closes that gap.
//
// Behaviour:
//   - On normal child exit: propagate the child's exit code unchanged.
//   - On wall-time cap (CLAUDE_CALL_TIMEOUT_SEC, default 180): SIGTERM the
//     child, escalate to SIGKILL after 5 s, and exit 124 (matches `timeout(1)`).
//   - All argv after the script name is forwarded verbatim to `claude`.
//
// stdio is `inherit`ed so the bash caller's existing redirects keep working.

import { runWithTimeout } from "./run-with-timeout.mjs";
import { isMainModule } from "./is-main.mjs";

const DEFAULT_TIMEOUT_SEC = 180;

// Pure: read the budget from env, falling back to the default. Exported so
// tests can verify the env-override path without spawning anything.
export function resolveTimeoutSec(env = process.env) {
  const raw = env.CLAUDE_CALL_TIMEOUT_SEC;
  if (raw == null || raw === "") return DEFAULT_TIMEOUT_SEC;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_SEC;
  return n;
}

// Claude-flavoured wrapper over the generic core: defaults the command to
// `claude` and tags log lines with the run-claude label. Kept as a named export
// so existing callers/tests keep working unchanged.
export function runClaudeWithTimeout({ command = "claude", ...rest } = {}) {
  return runWithTimeout({ command, label: "run-claude", ...rest });
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
