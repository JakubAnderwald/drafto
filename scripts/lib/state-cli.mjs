#!/usr/bin/env node
// Tiny CLI for mutating logs/support-state.json from bash. Used by
// scripts/support-agent.sh after Claude returns its summary line.
//
// Subcommands:
//   bump-notification <track-key>   Stamp lastAdminNotificationAt = now for
//                                    the given thread/message id (atomic load
//                                    + mutate + save). Returns 0 on success.
//   bump-counters <track-key> <sender>
//                                    Append now to thread + sender + global
//                                    rate-limit counters. Used after a
//                                    successful auto-reply (Phase E onward;
//                                    safe to leave wired in now).
//   set-issue-cursor <issue> <iso>
//                                    Set state.issues[<issue>].lastGithubCommentSyncAt
//                                    = <iso>. Used by --comment-sync to advance
//                                    the per-issue cursor after Claude
//                                    forwards a batch of GitHub comments to
//                                    the linked Zoho thread.
//   set-issue-state <issue> <state> [<state-reason>]
//                                    Record state.issues[<issue>].lastKnownState
//                                    = {state, state_reason} and bump
//                                    lastIssueStateSync. Used by --state-sync
//                                    after handling (or bootstrapping) a
//                                    transition. <state-reason> may be
//                                    empty/"null" to record an explicit null.
//
// State path can be overridden via --state-file <path> for tests; defaults to
// state.mjs's DEFAULT_STATE_PATH. The save is atomic (temp file + rename).
//
// **Callers must serialize.** loadState → mutate → saveState is atomic per
// write but NOT a transaction. Two concurrent invocations would each load
// the same prior state and the second `rename` would silently overwrite
// the first's update. Today this is safe because `support-agent.sh` holds
// a PID-file lock and iterates threads sequentially. As Phase E/F add more
// state mutations (rate-limit counters, comment-sync cursors), keep that
// assumption explicit or upgrade this CLI to file-locking on state.json.
//
// Exit non-zero with a single-line JSON {"error": "..."} to stderr on failure.

import { loadState, saveState, DEFAULT_STATE_PATH } from "./state.mjs";
import { bumpNotification, bumpCounters } from "./policy.mjs";
import { parseFlags } from "./parse-flags.mjs";
import { isMainModule } from "./is-main.mjs";

async function main(argv) {
  const [sub, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);
  const file = flags["state-file"] ?? DEFAULT_STATE_PATH;
  const now = flags.now ?? new Date().toISOString();

  switch (sub) {
    case "bump-notification": {
      const trackKey = positional[0];
      if (!trackKey) throw new Error("bump-notification requires <track-key>");
      const state = await loadState(file);
      bumpNotification(state, trackKey, now);
      await saveState(state, file);
      return { ok: true, trackKey, lastAdminNotificationAt: now };
    }
    case "bump-counters": {
      const trackKey = positional[0];
      const sender = positional[1];
      if (!trackKey || !sender) {
        throw new Error("bump-counters requires <track-key> <sender>");
      }
      const state = await loadState(file);
      bumpCounters(state, trackKey, sender, now);
      await saveState(state, file);
      return { ok: true, trackKey, sender };
    }
    case "set-issue-cursor": {
      const issueNumber = positional[0];
      const cursor = positional[1];
      if (!issueNumber || !cursor) {
        throw new Error("set-issue-cursor requires <issue-number> <cursor-iso>");
      }
      const state = await loadState(file);
      state.issues ??= {};
      state.issues[issueNumber] ??= {};
      state.issues[issueNumber].lastGithubCommentSyncAt = cursor;
      await saveState(state, file);
      return { ok: true, issueNumber, cursor };
    }
    case "set-issue-state": {
      const issueNumber = positional[0];
      const stateName = positional[1];
      const stateReasonRaw = positional[2];
      if (!issueNumber || !stateName) {
        throw new Error("set-issue-state requires <issue-number> <state> [<state-reason>]");
      }
      // Trim before checking so that bash callers passing " completed " (with
      // surrounding whitespace from a quoted variable) hit the same normalised
      // form as github-sync.mjs's normaliseStateReason — otherwise the
      // persisted value wouldn't compare equal to what diffStateChanges
      // produces from the live API on the next run, and we'd email the same
      // transition again.
      const trimmedReason =
        stateReasonRaw == null ? "" : String(stateReasonRaw).trim().toLowerCase();
      const stateReason = trimmedReason === "" || trimmedReason === "null" ? null : trimmedReason;
      const state = await loadState(file);
      state.issues ??= {};
      state.issues[issueNumber] ??= {};
      state.issues[issueNumber].lastKnownState = {
        state: String(stateName).trim().toLowerCase(),
        state_reason: stateReason,
      };
      state.issues[issueNumber].lastIssueStateSync = now;
      await saveState(state, file);
      return {
        ok: true,
        issueNumber,
        state: state.issues[issueNumber].lastKnownState.state,
        state_reason: state.issues[issueNumber].lastKnownState.state_reason,
      };
    }
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        "Usage: state-cli.mjs <bump-notification <track-key>|" +
          "bump-counters <track-key> <sender>|" +
          "set-issue-cursor <issue-number> <cursor-iso>|" +
          "set-issue-state <issue-number> <state> [<state-reason>]> " +
          "[--state-file <path>] [--now <iso>]\n",
      );
      return null;
    default:
      throw new Error(`Unknown subcommand: ${sub}`);
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (out) => {
      if (out !== null && out !== undefined) {
        process.stdout.write(JSON.stringify(out) + "\n");
      }
    },
    (err) => {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
      process.exit(1);
    },
  );
}
