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
//                      [--message-id <id>] [--subject <s>]
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
//                                    thread-side write. See issue #422.
//
//                                    --message-id / --subject record the inbound
//                                    Zoho messageId + subject as
//                                    issues[<issue>].zohoMessageId / .zohoSubject.
//                                    That is the route progress emails use when
//                                    Zoho never assigned a threadId (a customer's
//                                    first email) — `reply <messageId>` threads
//                                    without one. Empty / "null" / "undefined"
//                                    values are ignored. Read back through
//                                    `github-sync.mjs issue-route`.
//   get-reporter-email <issue>      Print state.issues[<issue>].reporterEmail (or
//                                    empty string if absent / unknown). Exit 0
//                                    regardless — callers branch on the printed
//                                    value. Used by nightly-support.sh's gate.
//   get-issue-zoho-thread-id <issue>
//                                    Print state.issues[<issue>].zohoThreadId (or
//                                    empty string if absent / unknown / a stored
//                                    literal "null"). Exit 0 regardless — used by
//                                    the inbound path to decide whether a linked
//                                    customer reply should upgrade the issue to
//                                    thread routing. See issue #422.
//   set-issue-field <issue> <field> <value>
//                                    Allowlisted setter for support-side issue
//                                    fields. <field> ∈ {zohoThreadId, zohoMessageId,
//                                    zohoSubject, reporterEmail,
//                                    lastGithubCommentSyncAt}. Empty/whitespace
//                                    values and the literals "null" / "undefined"
//                                    (any case) are rejected. Writes to
//                                    zohoThreadId also mirror onto
//                                    state.threads[<value>] (linkedIssue +
//                                    fromAddress when the issue has a
//                                    reporterEmail). See issue #422. A write
//                                    that makes an issue routable for the first
//                                    time also sets lastGithubCommentSyncAt =
//                                    now (when unset), so comment-sync never
//                                    emails comments from before the route
//                                    existed (issue #658).
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
//                                    lastProd, lastStatus, lastError,
//                                    lastFeedbackAt, intestCommentSha,
//                                    intestBetaSha, intestBetaAt,
//                                    intestBetaLanes, intestBetaAttempts,
//                                    intestBetaLaneAt,
//                                    lastReviewSha, crConvergedSha,
//                                    crConvergedAt, crCoverageSha, crCoverage,
//                                    crLastCoveredSha, crCliRuns,
//                                    crCliFreePassSha}.
//                                    Empty/`null` clears the field.
//   factory:get-issue <issue>       Print issues[<n>] as JSON (empty record
//                                    if absent).
//
// CodeRabbit CLI lane (ADR-0036). The lane itself reserves/attaches runs via
// factory-state.mjs directly (coderabbit-cli.mjs); these are the operator's
// view and escape hatches.
//
//   factory:cr-cli-status           Print the crCli ledger plus derived
//                                    usedLastHour, nextSlotAt and paused.
//                                    Clears (and persists) an expired lane
//                                    pause before reporting.
//   factory:cr-cli-pause-until <iso> [<reason>]
//                                    Pause ONLY the CodeRabbit lane until <iso>.
//                                    Never touches the factory pause.
//   factory:cr-cli-resume           Clear the lane pause.
//   factory:cr-cli-finish <runId> [--refund none|spawn|card] [--wait-ms <ms>]
//                                    Release a wedged in-flight run. Prints
//                                    {ok:false, reason:"run-id-mismatch"} (exit
//                                    0) when <runId> isn't the in-flight run.
//                                    Otherwise SIGTERMs the run's supervisor
//                                    process group first — only while the run is
//                                    still ours: its pid alive with <runId> on
//                                    its command line, or the supervisor exited
//                                    or mid-exit with its group still live (a
//                                    reused pid is left alone; see
//                                    crCliRunState) — and waits up to --wait-ms
//                                    (default 10000) for the group to exit.
//                                    Only then is the run released (killed:
//                                    true|false). If it is still running, or ps
//                                    can't verify it, the state is left untouched
//                                    and {ok:false, reason:"supervisor-still-
//                                    running"|"supervisor-unverifiable"} is
//                                    printed (exit 0): `kill -KILL -<pid>` and
//                                    re-run. The worktree is left to
//                                    housekeeping's reap.
//
// Nightly beta-release retry counters (ADR-0042). These live in
// logs/support-release-state.json — written only by nightly-support.sh, so they
// never race support-agent.sh's every-minute writes to support-state.json — and
// default to that file; --state-file overrides it as for every other subcommand.
//
//   record-release-attempt <issue> <platform> ok|fail [--closed-at <iso>]
//                                    Record one nightly attempt to ship <issue>'s
//                                    fix to <platform> (android|ios|macos) under
//                                    issues[<n>].releaseAttempts[<platform>] =
//                                    {failures, lastAttemptAt, lastResult}. ok
//                                    resets failures to 0; fail increments it.
//                                    --closed-at scopes the count to that close
//                                    (a record from an earlier close restarts
//                                    at 0). Prints the updated record.
//   reset-release-attempts <issue>  Forget every platform's attempts for
//                                    <issue>, so the next nightly retries it
//                                    (operator escape hatch after a give-up).
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

import { spawnSync } from "node:child_process";
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
  getCrCli,
  crCliUsage,
  isCrCliPaused,
  clearExpiredCrCliPause,
  pauseCrCli,
  resumeCrCli,
  finishCrCliRun,
} from "./factory-state.mjs";
import { bumpNotification, bumpCounters } from "./policy.mjs";
import { isManualReviewCommand } from "./coderabbit-review.mjs";
import { parseFlags } from "./parse-flags.mjs";
import { isMainModule } from "./is-main.mjs";
// A bash caller interpolating an unset value can hand us "", "null" or
// "undefined"; none is a real Zoho id or subject, so they count as absent.
import { isAbsentValue, normaliseRouteValue } from "./route-value.mjs";
import { resolveIssueRoute } from "./github-sync.mjs";

// The release-attempt subcommands load support-release.mjs (and with it the
// beta dispatcher) only when they run: support-agent.sh calls this CLI every
// minute, and its state updates must not depend on the release code loading.
const loadReleaseModule = () => import("./support-release.mjs");

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

// Does anything in process group <pgid> still exist (zombies included)? EPERM
// means it exists but isn't ours to signal.
function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Is the in-flight run still running — the supervisor OR anything in its process
// group? The supervisor leads its own group, and the CodeRabbit CLI it spawned
// lives in that group and can outlive it (it may ignore SIGTERM, or be mid-
// shutdown), so a dead supervisor alone doesn't prove the vendor connection is
// gone. One process-table snapshot decides:
//   - leader alive (not a zombie) → "alive" if its command carries the runId,
//     else "gone" (a reused pid: POSIX never reuses a pid still in use as a
//     process group id, so our group can't exist alongside it);
//   - leader alive but ps can't read its args (it prints the bare process name:
//     "(node)" on macOS, "[node]" with Linux procps, for one that is mid-exit) →
//     treated as exiting, so its group decides, below, as it will a moment later
//     when the leader is a zombie; the dying leader still counts as a live
//     member until then;
//   - leader exited or an unreaped zombie → "alive" while any non-zombie process
//     still has pgid == pid (the CLI it started), else "gone".
// "unknown" when ps fails while the pid or its group still exists.
function crCliRunState(inFlight) {
  const pid = inFlight?.pid;
  // A manual `coderabbit-cli.mjs review` holds the lane from its own process:
  // it is not a group leader and its run id never reaches argv, so it is alive
  // exactly while that pid is a `review` of the recorded PR.
  if (inFlight?.manual) {
    if (!Number.isInteger(pid) || pid <= 0 || !isPidAlive(pid)) return "gone";
    const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    if (ps.status !== 0) return isPidAlive(pid) ? "unknown" : "gone";
    return isManualReviewCommand(ps.stdout.trim(), inFlight.pr) ? "alive" : "gone";
  }
  if (!Number.isInteger(pid) || pid <= 0) return "gone";
  const ps = spawnSync("ps", ["-axo", "pid=,pgid=,stat=,command="], { encoding: "utf8" });
  if (ps.status !== 0) {
    return isPidAlive(pid) || processGroupExists(pid) ? "unknown" : "gone";
  }
  const rows = String(ps.stdout ?? "")
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), stat: m[3], command: m[4] }));
  const live = (r) => !r.stat.startsWith("Z");
  const leader = rows.find((r) => r.pid === pid);
  // "(node)" / "[node]": our leader mid-exit, not a reused pid, so its group decides.
  const argsUnreadable = (r) => /^(\(.*\)|\[.*\])$/.test(r.command.trim());
  if (leader && live(leader) && !argsUnreadable(leader)) {
    return leader.command.includes(inFlight.runId) ? "alive" : "gone";
  }
  return rows.some((r) => r.pgid === pid && live(r)) ? "alive" : "gone";
}

// Releasing a run in the ledger without stopping it would leave a vendor review
// running that nothing collects, and the gate free to start a second one — which
// the vendor refuses while the first is connected. So the release only happens
// once the run is verifiably gone: SIGTERM its process group (the supervisor was
// spawned detached, so -pid reaches the CLI too), then wait, bounded, until no
// live member of the group is left. Returns {state, signalled, killed}:
// `signalled` = SIGTERM was sent; `killed` = sent AND the group is now gone, so
// a group that shrugged off the signal never reads as killed.
async function stopCrCliSupervisor(inFlight, { waitMs }) {
  const initial = crCliRunState(inFlight);
  if (initial !== "alive") return { state: initial, signalled: false, killed: false };
  try {
    // A manual review traps SIGTERM itself (stops its CLI child, frees the
    // lane); the factory's supervisor is a group leader, so -pid reaches its CLI.
    process.kill(inFlight.manual ? inFlight.pid : -inFlight.pid, "SIGTERM");
  } catch {
    // Fall through to the wait: it reports whatever state the group is in.
  }
  const deadline = Date.now() + waitMs;
  let state = crCliRunState(inFlight);
  while (state === "alive" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    state = crCliRunState(inFlight);
  }
  return { state, signalled: true, killed: state === "gone" };
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
          "record-filed-issue requires <issue-number> <sender-email> [<zoho-thread-id>] " +
            "[--message-id <id>] [--subject <s>]",
        );
      }
      const normalised = String(senderEmail).trim().toLowerCase();
      if (!normalised) {
        throw new Error("record-filed-issue: sender-email is empty after trim");
      }
      // Empty string or the literal "null" (case-insensitive) → singleton path:
      // Zoho has not assigned a threadId to a customer's first email. Persist
      // the email plus the inbound messageId / subject (below), which is enough
      // for the sync modes to route by `reply <messageId>`.
      const zohoThreadId = normaliseRouteValue(zohoThreadIdRaw);
      const zohoMessageId = normaliseRouteValue(flags["message-id"]);
      const zohoSubject = normaliseRouteValue(flags.subject);
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
      if (zohoMessageId != null) state.issues[issueNumber].zohoMessageId = zohoMessageId;
      if (zohoSubject != null) state.issues[issueNumber].zohoSubject = zohoSubject;
      await saveState(state, file);
      return {
        ok: true,
        issueNumber,
        reporterEmail: normalised,
        zohoThreadId,
        zohoMessageId,
        zohoSubject,
      };
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
      const raw = state.issues?.[issueNumber]?.zohoThreadId;
      // Older set-issue-field builds accepted a literal "null"; print it as
      // absent so callers' `-z` checks see "no linkage".
      const id = isAbsentValue(raw) ? "" : String(raw);
      // Bare value, no JSON, no trailing newline — bash callers capture directly.
      process.stdout.write(id);
      return null;
    }
    case "set-issue-field": {
      // Allowlist guards against typos clobbering structured fields like
      // lastKnownState (a nested object) or lastIssueStateSync (an audit
      // timestamp set by --state-sync). Keep this set narrow; widen only when
      // there is a real operator need.
      const ALLOWED = new Set([
        "zohoThreadId",
        "zohoMessageId",
        "zohoSubject",
        "reporterEmail",
        "lastGithubCommentSyncAt",
      ]);
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
      // A literal "null" / "undefined" is what an unset bash or jq value turns
      // into. Storing it would read back as a real id (issue #658 lost its
      // progress emails to a footer that said `zoho-thread-id: null`).
      if (isAbsentValue(normalised)) {
        throw new Error(`set-issue-field: refusing literal '${normalised}' as a value`);
      }
      if (field === "reporterEmail") normalised = normalised.toLowerCase();
      const state = await loadState(file);
      state.issues ??= {};
      state.issues[issueNumber] ??= {};
      const issue = state.issues[issueNumber];
      // Same routability rule the sync modes use (state only — no footer here).
      const wasRoutable = resolveIssueRoute({ stateEntry: issue }).routable;
      issue[field] = normalised;
      // A route that appears after filing (an operator backfill, or the
      // runner recording a linked customer reply's thread) must not make
      // comment-sync email the issue's whole comment history: with no cursor
      // yet, comment-sync would start from issue.createdAt. Start it at now;
      // forwarding older comments stays a deliberate opt-in (set
      // lastGithubCommentSyncAt to an earlier time afterwards).
      // record-filed-issue does not do this: a filing-time route rightly
      // starts from createdAt.
      let cursorBootstrappedAt = null;
      if (
        !wasRoutable &&
        resolveIssueRoute({ stateEntry: issue }).routable &&
        isAbsentValue(issue.lastGithubCommentSyncAt)
      ) {
        issue.lastGithubCommentSyncAt = now;
        cursorBootstrappedAt = now;
      }
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
      return { ok: true, issueNumber, field, value: normalised, cursorBootstrappedAt };
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
    case "factory:cr-cli-status": {
      const state = await loadFactoryState(file);
      // Same auto-resume-on-read as factory:paused?, for the same reason: the
      // status an operator sees should never report a pause that has expired.
      if (clearExpiredCrCliPause(state, now)) {
        await saveFactoryState(state, file);
      }
      const crCli = getCrCli(state);
      return {
        ...crCli,
        ...crCliUsage(state, { now }),
        paused: isCrCliPaused(state, now),
      };
    }
    case "factory:cr-cli-pause-until": {
      const until = positional[0];
      const reason = positional[1] ?? null;
      if (!until) throw new Error("factory:cr-cli-pause-until requires <until-iso> [<reason>]");
      if (Number.isNaN(Date.parse(until))) {
        throw new Error(`factory:cr-cli-pause-until: invalid <until-iso>: ${until}`);
      }
      const state = await loadFactoryState(file);
      const crCli = pauseCrCli(state, { until, reason });
      await saveFactoryState(state, file);
      return { ok: true, pausedUntil: crCli.pausedUntil, pausedReason: crCli.pausedReason };
    }
    case "factory:cr-cli-resume": {
      const state = await loadFactoryState(file);
      resumeCrCli(state);
      await saveFactoryState(state, file);
      return { ok: true, paused: false };
    }
    case "factory:cr-cli-finish": {
      const runId = positional[0];
      if (!runId)
        throw new Error("factory:cr-cli-finish requires <runId> [--refund none|spawn|card]");
      const refund = flags.refund ?? "none";
      const waitMs = flags["wait-ms"] == null ? 10_000 : Number(flags["wait-ms"]);
      if (!Number.isFinite(waitMs) || waitMs < 0) {
        throw new Error(`factory:cr-cli-finish: invalid --wait-ms: ${flags["wait-ms"]}`);
      }
      const snapshot = await loadFactoryState(file);
      const inFlight = getCrCli(snapshot).inFlight;
      // Dry-finish a throwaway copy first: it validates <runId> and --refund, so
      // a bad invocation fails before anything is signalled.
      const check = finishCrCliRun(structuredClone(snapshot), runId, { refund, now });
      if (!check.ok) return check;
      const stop = await stopCrCliSupervisor(inFlight, { waitMs });
      if (stop.state !== "gone") {
        // Still running, or unverifiable: keep inFlight, so the gate won't start
        // a second (vendor-refused) run and housekeeping still owns this one.
        return {
          ok: false,
          reason: stop.state === "alive" ? "supervisor-still-running" : "supervisor-unverifiable",
          runId,
          pid: inFlight?.pid ?? null,
          signalled: stop.signalled,
          killed: stop.killed,
        };
      }
      // Re-load: the wait can take seconds while the factory keeps writing.
      const state = await loadFactoryState(file);
      const result = finishCrCliRun(state, runId, { refund, now });
      // A manual review frees its own slot on SIGTERM; that is the success case.
      if (!result.ok && inFlight?.manual && getCrCli(state).inFlight?.runId !== runId) {
        return { ok: true, runId, releasedBy: "manual-review", killed: stop.killed };
      }
      if (!result.ok) return { ...result, killed: stop.killed };
      await saveFactoryState(state, file);
      return { ...result, killed: stop.killed };
    }
    case "record-release-attempt": {
      const issueNumber = positional[0];
      const platform = positional[1];
      const result = positional[2];
      if (!issueNumber || !platform || !result) {
        throw new Error("record-release-attempt requires <issue> <platform> ok|fail");
      }
      if (!/^[1-9][0-9]*$/.test(issueNumber)) {
        throw new Error(
          `record-release-attempt: invalid issue number ${JSON.stringify(issueNumber)}`,
        );
      }
      const {
        loadReleaseState,
        saveReleaseState,
        recordReleaseAttempt,
        DEFAULT_RELEASE_STATE_PATH,
      } = await loadReleaseModule();
      const releaseFile = flags["state-file"] ?? DEFAULT_RELEASE_STATE_PATH;
      const state = await loadReleaseState(releaseFile);
      const record = recordReleaseAttempt(state, issueNumber, platform, result, now, {
        closedAt: flags["closed-at"],
      });
      await saveReleaseState(state, releaseFile);
      return { ok: true, issueNumber: String(issueNumber), platform, ...record };
    }
    case "reset-release-attempts": {
      const issueNumber = positional[0];
      if (!issueNumber) throw new Error("reset-release-attempts requires <issue>");
      const {
        loadReleaseState,
        saveReleaseState,
        resetReleaseAttempts,
        DEFAULT_RELEASE_STATE_PATH,
      } = await loadReleaseModule();
      const releaseFile = flags["state-file"] ?? DEFAULT_RELEASE_STATE_PATH;
      const state = await loadReleaseState(releaseFile);
      resetReleaseAttempts(state, issueNumber);
      await saveReleaseState(state, releaseFile);
      return { ok: true, issueNumber: String(issueNumber), releaseAttempts: null };
    }
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        "Usage: state-cli.mjs <bump-notification <track-key>|" +
          "bump-counters <track-key> <sender>|" +
          "set-issue-cursor <issue-number> <cursor-iso>|" +
          "set-issue-state <issue-number> <state> [<state-reason>]|" +
          "record-filed-issue <issue-number> <sender-email> [<zoho-thread-id>] " +
          "[--message-id <id>] [--subject <s>]|" +
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
          "factory:get-issue <issue>|" +
          "record-release-attempt <issue> <platform> ok|fail|" +
          "reset-release-attempts <issue>|" +
          "factory:cr-cli-status|" +
          "factory:cr-cli-pause-until <until-iso> [<reason>]|" +
          "factory:cr-cli-resume|" +
          "factory:cr-cli-finish <runId> [--refund none|spawn|card]> " +
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
