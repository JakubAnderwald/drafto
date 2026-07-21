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
//   record-filed-issue <issue> <sender-email> [<zoho-thread-id>]
//                                    Persist state.issues[<issue>].reporterEmail
//                                    = sender-email (lower-cased, trimmed). Called
//                                    by support-agent.sh after Claude reports
//                                    `action=filed-issue`; the inbound `fromAddress`
//                                    is the authoritative sender (captured before
//                                    the LLM ran) — nightly-support.sh reads it to
//                                    gate auto-implementation. See ADR-0025.
//
//                                    Optional 3rd positional <zoho-thread-id> also
//                                    writes state.issues[<issue>].zohoThreadId and
//                                    mirrors onto state.threads[<id>] (linkedIssue
//                                    + fromAddress). Empty/"null" 3rd arg is
//                                    treated as "no linkage yet" and skips the
//                                    thread-side write. Read back by `--comment-sync`
//                                    via get-issue-zoho-thread-id. See issue #422.
//   get-reporter-email <issue>      Print state.issues[<issue>].reporterEmail (or
//                                    empty string if absent / unknown). Exit 0
//                                    regardless — callers branch on the printed
//                                    value. Used by nightly-support.sh's gate.
//   get-issue-zoho-thread-id <issue>
//                                    Print state.issues[<issue>].zohoThreadId (or
//                                    empty string if absent / unknown). Exit 0
//                                    regardless — used by --comment-sync to decide
//                                    routing. See issue #422.
//   set-issue-field <issue> <field> <value>
//                                    Allowlisted setter for support-side issue
//                                    fields. <field> ∈ {zohoThreadId, reporterEmail,
//                                    lastGithubCommentSyncAt}. Empty/whitespace
//                                    values are rejected. Writes to zohoThreadId
//                                    also mirror onto state.threads[<value>]
//                                    (linkedIssue + fromAddress when the issue has
//                                    a reporterEmail). See issue #422.
//
// Dark-factory subcommands (all prefixed with `factory:`). These mutate
// logs/factory-state.json (separate file from support-state.json) via
// factory-state.mjs's atomic save. The shared `--state-file <path>` override
// targets the factory file for these subcommands; tests use it.
//
//   factory:pause [<reason>]        Set paused=true, pausedAt=now,
//                                    pausedReason=<reason>. Manual pause: never
//                                    auto-expires. Agent exits early on every
//                                    cycle while set.
//   factory:pause-until <iso> [<reason>]
//                                    Timed pause: paused until <iso>, then the
//                                    next `factory:paused?` auto-resumes. Used
//                                    for session-limit backoff (see
//                                    factory-agent.sh check_session_limit).
//   factory:resume                  Clear the pause flag (manual or timed).
//   factory:status                  Print the full factory state JSON
//                                    (paused, slots, issues).
//   factory:paused?                 Exit 0 if paused, exit 1 otherwise. Bash-
//                                    friendly: `if node ... factory:paused?; then echo paused; fi`.
//                                    Auto-resumes (and persists) an expired
//                                    timed pause before reporting.
//   factory:slot-acquire <slot> <issue> [<pid>]
//                                    Record slot <slot> (0|1) as occupied by
//                                    <issue> + <pid>. Caller still holds an
//                                    flock on logs/factory.slot<N>.pid for
//                                    real mutual exclusion — this is just
//                                    the bookkeeping side. Refuses if slot
//                                    is already occupied and the existing
//                                    pid is still alive (use --force to
//                                    steal a slot whose pid is dead).
//   factory:slot-release <slot>     Clear slot <slot>.
//   factory:slot-status [<slot>]    Print one slot's record, or all slots
//                                    if <slot> is omitted.
//   factory:bump-attempts <issue>   Increment issues[<n>].attempts by 1 and
//                                    print the new value.
//   factory:reset-attempts <issue>  Set issues[<n>].attempts = 0.
//   factory:get-attempts <issue>    Print issues[<n>].attempts (0 if absent).
//   factory:set-issue-field <issue> <field> <value>
//                                    Set issues[<n>][<field>] = <value>.
//                                    <field> ∈ {lastPlanAt, lastImplementAt,
//                                    lastWatchAt, lastReleaseAt, lastBeta,
//                                    lastProd, lastStatus, lastError}.
//                                    Empty/`null` clears the field.
//   factory:get-issue <issue>       Print issues[<n>] as JSON (empty record
//                                    if absent).
//
// State path can be overridden via --state-file <path> for tests; defaults to
// state.mjs's DEFAULT_STATE_PATH for support subcommands and to
// factory-state.mjs's DEFAULT_FACTORY_STATE_PATH for `factory:*` subcommands.
// The save is atomic (temp file + rename).
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
import {
  loadFactoryState,
  saveFactoryState,
  DEFAULT_FACTORY_STATE_PATH,
  pauseFactory,
  pauseFactoryUntil,
  resumeFactory,
  isFactoryPaused,
  clearExpiredPause,
  acquireSlot,
  releaseSlot,
  getSlot,
  isSlotFree,
  bumpIssueAttempts,
  resetIssueAttempts,
  getIssue,
  setIssueField,
} from "./factory-state.mjs";
import { bumpNotification, bumpCounters } from "./policy.mjs";
import { parseFlags } from "./parse-flags.mjs";
import { isMainModule } from "./is-main.mjs";

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = process exists but we can't signal it
    // (still counts as alive for liveness purposes).
    return err.code === "EPERM";
  }
}

async function main(argv) {
  const [sub, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);
  const isFactorySub = typeof sub === "string" && sub.startsWith("factory:");
  const defaultStatePath = isFactorySub ? DEFAULT_FACTORY_STATE_PATH : DEFAULT_STATE_PATH;
  const file = flags["state-file"] ?? defaultStatePath;
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
    case "record-filed-issue": {
      const issueNumber = positional[0];
      const senderEmail = positional[1];
      const zohoThreadIdRaw = positional[2];
      if (!issueNumber || !senderEmail) {
        throw new Error(
          "record-filed-issue requires <issue-number> <sender-email> [<zoho-thread-id>]",
        );
      }
      const normalised = String(senderEmail).trim().toLowerCase();
      if (!normalised) {
        throw new Error("record-filed-issue: sender-email is empty after trim");
      }
      // Empty string or the literal "null" (case-insensitive) → singleton path:
      // no Zoho linkage yet, persist email only. support-agent.sh re-reads the
      // patched footer post-filing and calls set-issue-field to fill it in.
      const zohoThreadIdTrimmed = zohoThreadIdRaw == null ? "" : String(zohoThreadIdRaw).trim();
      const zohoThreadId =
        zohoThreadIdTrimmed === "" || zohoThreadIdTrimmed.toLowerCase() === "null"
          ? null
          : zohoThreadIdTrimmed;
      const state = await loadState(file);
      state.issues ??= {};
      state.issues[issueNumber] ??= {};
      state.issues[issueNumber].reporterEmail = normalised;
      if (zohoThreadId != null) {
        state.issues[issueNumber].zohoThreadId = zohoThreadId;
        state.threads ??= {};
        state.threads[zohoThreadId] ??= {};
        state.threads[zohoThreadId].linkedIssue = String(issueNumber);
        state.threads[zohoThreadId].fromAddress = normalised;
      }
      await saveState(state, file);
      return { ok: true, issueNumber, reporterEmail: normalised, zohoThreadId };
    }
    case "get-reporter-email": {
      const issueNumber = positional[0];
      if (!issueNumber) {
        throw new Error("get-reporter-email requires <issue-number>");
      }
      const state = await loadState(file);
      const email = state.issues?.[issueNumber]?.reporterEmail ?? "";
      // Print bare value (no JSON wrapper, no trailing newline) so bash callers
      // can `REPORTER_EMAIL=$(node ... get-reporter-email "$N")` directly.
      process.stdout.write(email);
      return null;
    }
    case "get-issue-zoho-thread-id": {
      const issueNumber = positional[0];
      if (!issueNumber) {
        throw new Error("get-issue-zoho-thread-id requires <issue-number>");
      }
      const state = await loadState(file);
      const id = state.issues?.[issueNumber]?.zohoThreadId ?? "";
      // Bare value, no JSON, no trailing newline — bash callers capture directly.
      process.stdout.write(id);
      return null;
    }
    case "set-issue-field": {
      // Allowlist guards against typos clobbering structured fields like
      // lastKnownState (a nested object) or lastIssueStateSync (an audit
      // timestamp set by --state-sync). Keep this set narrow; widen only when
      // there is a real operator need.
      const ALLOWED = new Set(["zohoThreadId", "reporterEmail", "lastGithubCommentSyncAt"]);
      const issueNumber = positional[0];
      const field = positional[1];
      const value = positional[2];
      if (!issueNumber || !field || value == null) {
        throw new Error("set-issue-field requires <issue-number> <field> <value>");
      }
      if (!ALLOWED.has(field)) {
        throw new Error(
          `set-issue-field: field '${field}' not in allowlist (${[...ALLOWED].join(", ")})`,
        );
      }
      let normalised = String(value).trim();
      if (!normalised) {
        throw new Error("set-issue-field: value is empty after trim");
      }
      if (field === "reporterEmail") normalised = normalised.toLowerCase();
      const state = await loadState(file);
      state.issues ??= {};
      state.issues[issueNumber] ??= {};
      state.issues[issueNumber][field] = normalised;
      if (field === "zohoThreadId") {
        state.threads ??= {};
        state.threads[normalised] ??= {};
        state.threads[normalised].linkedIssue = String(issueNumber);
        const email = state.issues[issueNumber].reporterEmail;
        if (email) state.threads[normalised].fromAddress = email;
      } else if (field === "reporterEmail") {
        // Keep state.threads[<id>].fromAddress in sync with the new
        // reporterEmail; the threads side is documented as a joinless mirror
        // and operators should not have to remember to update both.
        const existingThreadId = state.issues[issueNumber].zohoThreadId;
        if (existingThreadId) {
          state.threads ??= {};
          state.threads[existingThreadId] ??= {};
          state.threads[existingThreadId].fromAddress = normalised;
        }
      }
      await saveState(state, file);
      return { ok: true, issueNumber, field, value: normalised };
    }
    case "factory:pause": {
      const reason = positional[0] ?? null;
      const state = await loadFactoryState(file);
      pauseFactory(state, { reason, now });
      await saveFactoryState(state, file);
      return { ok: true, paused: true, pausedAt: now, pausedReason: state.pausedReason };
    }
    case "factory:pause-until": {
      const until = positional[0];
      const reason = positional[1] ?? null;
      if (!until) throw new Error("factory:pause-until requires <until-iso> [<reason>]");
      const untilMs = Date.parse(until);
      if (Number.isNaN(untilMs)) {
        throw new Error(`factory:pause-until: invalid <until-iso>: ${until}`);
      }
      // Persist a canonical UTC ISO string. isFactoryPaused/clearExpiredPause
      // compare pausedUntil lexicographically against a toISOString() `now`, so
      // a zone-offset (…+02:00) or reduced-precision operator input would order
      // incorrectly. Normalising here keeps the stored value comparable.
      const state = await loadFactoryState(file);
      pauseFactoryUntil(state, { until: new Date(untilMs).toISOString(), reason, now });
      await saveFactoryState(state, file);
      return {
        ok: true,
        paused: true,
        pausedAt: now,
        pausedUntil: state.pausedUntil,
        pausedReason: state.pausedReason,
      };
    }
    case "factory:resume": {
      const state = await loadFactoryState(file);
      resumeFactory(state);
      await saveFactoryState(state, file);
      return { ok: true, paused: false };
    }
    case "factory:status": {
      const state = await loadFactoryState(file);
      return state;
    }
    case "factory:paused?": {
      const state = await loadFactoryState(file);
      // Auto-resume an expired timed pause so `factory:status` stays truthful.
      // Safe to persist here: modes run sequentially under the loop's mutex, so
      // there's no concurrent writer, and a redundant clear is idempotent.
      if (clearExpiredPause(state, now)) {
        await saveFactoryState(state, file);
      }
      // Exit 0 if paused, 1 if not — bash-friendly. Don't print anything.
      process.exit(isFactoryPaused(state, now) ? 0 : 1);
      return null;
    }
    case "factory:slot-acquire": {
      const slot = positional[0];
      const issueNumber = positional[1];
      const pidStr = positional[2];
      if (slot == null || issueNumber == null) {
        throw new Error("factory:slot-acquire requires <slot> <issue> [<pid>]");
      }
      const pid = pidStr ? Number(pidStr) : null;
      const force = flags.force != null && flags.force !== "false";
      const state = await loadFactoryState(file);
      if (!force && !isSlotFree(state, slot, { isPidAlive })) {
        const occupied = getSlot(state, slot);
        return {
          ok: false,
          reason: "slot-occupied",
          slot: Number(slot),
          occupiedBy: occupied,
        };
      }
      acquireSlot(state, slot, { issueNumber, pid, now });
      await saveFactoryState(state, file);
      return {
        ok: true,
        slot: Number(slot),
        issueNumber: String(issueNumber),
        pid,
        acquiredAt: now,
      };
    }
    case "factory:slot-release": {
      const slot = positional[0];
      if (slot == null) throw new Error("factory:slot-release requires <slot>");
      const state = await loadFactoryState(file);
      releaseSlot(state, slot);
      await saveFactoryState(state, file);
      return { ok: true, slot: Number(slot) };
    }
    case "factory:slot-status": {
      const slot = positional[0];
      const state = await loadFactoryState(file);
      if (slot == null) {
        return { slots: state.slots };
      }
      return { slot: Number(slot), ...getSlot(state, slot) };
    }
    case "factory:bump-attempts": {
      const issueNumber = positional[0];
      if (!issueNumber) throw new Error("factory:bump-attempts requires <issue>");
      const state = await loadFactoryState(file);
      const attempts = bumpIssueAttempts(state, issueNumber);
      await saveFactoryState(state, file);
      return { ok: true, issueNumber: String(issueNumber), attempts };
    }
    case "factory:reset-attempts": {
      const issueNumber = positional[0];
      if (!issueNumber) throw new Error("factory:reset-attempts requires <issue>");
      const state = await loadFactoryState(file);
      resetIssueAttempts(state, issueNumber);
      await saveFactoryState(state, file);
      return { ok: true, issueNumber: String(issueNumber), attempts: 0 };
    }
    case "factory:get-attempts": {
      const issueNumber = positional[0];
      if (!issueNumber) throw new Error("factory:get-attempts requires <issue>");
      const state = await loadFactoryState(file);
      const issue = state.issues?.[String(issueNumber)] ?? {};
      // Print bare integer (no JSON, no newline) so bash can capture directly.
      process.stdout.write(String(Number.isInteger(issue.attempts) ? issue.attempts : 0));
      return null;
    }
    case "factory:set-issue-field": {
      const issueNumber = positional[0];
      const field = positional[1];
      const value = positional[2];
      if (!issueNumber || !field) {
        throw new Error("factory:set-issue-field requires <issue> <field> <value>");
      }
      const state = await loadFactoryState(file);
      const newValue = setIssueField(state, issueNumber, field, value);
      await saveFactoryState(state, file);
      return { ok: true, issueNumber: String(issueNumber), field, value: newValue };
    }
    case "factory:get-issue": {
      const issueNumber = positional[0];
      if (!issueNumber) throw new Error("factory:get-issue requires <issue>");
      const state = await loadFactoryState(file);
      return getIssue(state, issueNumber);
    }
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        "Usage: state-cli.mjs <bump-notification <track-key>|" +
          "bump-counters <track-key> <sender>|" +
          "set-issue-cursor <issue-number> <cursor-iso>|" +
          "set-issue-state <issue-number> <state> [<state-reason>]|" +
          "record-filed-issue <issue-number> <sender-email> [<zoho-thread-id>]|" +
          "get-reporter-email <issue-number>|" +
          "get-issue-zoho-thread-id <issue-number>|" +
          "set-issue-field <issue-number> <field> <value>|" +
          "factory:pause [<reason>]|" +
          "factory:pause-until <until-iso> [<reason>]|" +
          "factory:resume|" +
          "factory:status|" +
          "factory:paused?|" +
          "factory:slot-acquire <slot> <issue> [<pid>] [--force]|" +
          "factory:slot-release <slot>|" +
          "factory:slot-status [<slot>]|" +
          "factory:bump-attempts <issue>|" +
          "factory:reset-attempts <issue>|" +
          "factory:get-attempts <issue>|" +
          "factory:set-issue-field <issue> <field> <value>|" +
          "factory:get-issue <issue>> " +
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
