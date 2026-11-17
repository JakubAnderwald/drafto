// Liveness and stopping of a detached supervisor: a node process the factory
// spawned with `detached: true`, so it leads its own process group, and whose
// command line carries its run id. Shared by state-cli.mjs (the CodeRabbit
// lane's and the verification lane's escape hatches) and implement-lane.mjs
// (detached --implement runs, ADR-0085). Moved here unchanged from
// state-cli.mjs; the process-table helpers at the bottom are new.

import { spawnSync } from "node:child_process";
import { isManualReviewCommand } from "./coderabbit-review.mjs";

export function isPidAlive(pid) {
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
export function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Is the in-flight run still running — the supervisor OR anything in its process
// group? The supervisor leads its own group, and the CodeRabbit CLI (or, for the
// verification lane, the claude session) it spawned lives in that group and can
// outlive it (it may ignore SIGTERM, or be mid-shutdown), so a dead supervisor
// alone doesn't prove the work is gone. One process-table snapshot decides:
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
export function supervisorRunState(inFlight) {
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
  // One decision for every lane: groupRunState, below.
  return groupRunState(rows, { pid, runId: inFlight.runId });
}

// Releasing a run in the ledger without stopping it would leave a vendor review
// running that nothing collects, and the gate free to start a second one — which
// the vendor refuses while the first is connected. (For the verification lane:
// a second test run on top of the first, on a Mac mini already short of RAM.)
// So the release only happens once the run is verifiably gone: SIGTERM its
// process group (the supervisor was spawned detached, so -pid reaches its child
// too), then wait, bounded, until no live member of the group is left. Returns
// {state, signalled, killed}: `signalled` = SIGTERM was sent; `killed` = sent
// AND the group is now gone, so a group that shrugged off the signal never
// reads as killed.
export async function stopSupervisor(inFlight, { waitMs }) {
  const initial = supervisorRunState(inFlight);
  if (initial !== "alive") return { state: initial, signalled: false, killed: false };
  try {
    // A manual review traps SIGTERM itself (stops its CLI child, frees the
    // lane); the factory's supervisor is a group leader, so -pid reaches its CLI.
    process.kill(inFlight.manual ? inFlight.pid : -inFlight.pid, "SIGTERM");
  } catch {
    // Fall through to the wait: it reports whatever state the group is in.
  }
  const deadline = Date.now() + waitMs;
  let state = supervisorRunState(inFlight);
  while (state === "alive" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    state = supervisorRunState(inFlight);
  }
  return { state, signalled: true, killed: state === "gone" };
}

// ── Process-table snapshots (ADR-0085) ──────────────────────────────────────
// implement-lane.mjs decides liveness, and finds what to stop, from one `ps`
// snapshot per call. It needs the parent pid too: the claude session a
// detached implement run starts leads a process group of its own
// (run-with-timeout.mjs's group mode), so stopping the run means finding that
// group under the supervisor before anything is killed.

// The process table as [{pid, ppid, pgid, stat, command}], or null when ps
// fails. `ww` so a long command line (claude's carries its whole prompt) is
// never cut off before the run id or session id; the buffer is sized for that.
export function processTable({ run = spawnSync } = {}) {
  const ps = run("ps", ["-axww", "-o", "pid=,ppid=,pgid=,stat=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!ps || ps.error || ps.status !== 0) return null;
  return parseProcessTable(ps.stdout);
}

export function parseProcessTable(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      stat: m[4],
      command: m[5],
    }));
}

// A zombie is gone for every purpose here: it runs nothing and holds no files.
export function isLiveRow(row) {
  return Boolean(row) && !String(row.stat).startsWith("Z");
}

// supervisorRunState's decision (it calls this), on a snapshot already taken:
// "alive" while the leader <pid> is alive with <runId> on its command line, or
// (leader gone, a zombie, or mid-exit with unreadable args) while any live
// process is still in its group; else "gone". A live leader WITHOUT the run id
// is a reused pid: POSIX never hands out a pid still in use as a process group
// id, so our group can't exist beside it.
export function groupRunState(rows, { pid, runId }) {
  if (!Number.isInteger(pid) || pid <= 0 || !runId) return "gone";
  const leader = rows.find((r) => r.pid === pid);
  // "(node)" / "[node]": our leader mid-exit, not a reused pid, so its group decides.
  const argsUnreadable = (r) => /^(\(.*\)|\[.*\])$/.test(r.command.trim());
  if (leader && isLiveRow(leader) && !argsUnreadable(leader)) {
    return leader.command.includes(runId) ? "alive" : "gone";
  }
  return rows.some((r) => r.pgid === pid && isLiveRow(r)) ? "alive" : "gone";
}

// Every live process descended from <rootPid> (its children, theirs, …),
// followed by ppid in one snapshot. A process whose parent died has been
// re-parented to launchd and is no longer found this way; callers that must
// reach it match it some other way (implement-lane.mjs: the session id).
export function descendants(rows, rootPid) {
  const byParent = new Map();
  for (const r of rows) {
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
    byParent.get(r.ppid).push(r);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (isLiveRow(child)) out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}
