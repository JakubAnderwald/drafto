#!/usr/bin/env node
// Resume a timed-out --implement Claude session (ADR-0084).
//
// Why this exists: five --implement runs hit the 45-min wall cap between
// 2026-10-17 and 2026-11-13 and burned 13.5% of the factory's tokens. Every
// retry started a fresh session, so the 45 minutes of context the killed run
// had built up were lost (#797). `claude -p --resume <id>` continues a session
// under the same id and appends to the same <id>.jsonl, so the next attempt can
// pick up where the killed one stopped — when nothing it relied on changed.
//
// factory-agent.sh gives every implement run a --session-id. When a fresh run
// hits the cap, or stops itself with action=incomplete at its soft deadline, it
// records the session (factory:implement-resume-set). The next run asks
// `decide` whether resuming is safe, and clears the record whatever the answer,
// so a timeout chain resumes at most once.
//
// CLI (all output on stdout; errors as one JSON line on stderr, exit 1):
//   task-key --plan-id <id> [--rev-ids <id,id,…>]
//       The task key, bare: "plan:<plan comment id>|rev:<sorted revision ids>".
//   decide --record <issue JSON> --worktree <worktree-cli add JSON>
//          --head <sha> --task-key <key> [--pr-state OPEN|CLOSED|MERGED|""]
//          [--enabled 0|1] [--max-age-min <n>] [--now <iso>]
//          [--projects-dir <dir>]
//       One JSON line: {"resume":true,"sessionId":…,"preHead":…} or
//       {"resume":false,"reason":…,"detail":…}.
//   started --session-id <uuid> --since <iso> [--projects-dir <dir>]
//       One JSON line: {"started":bool,"transcript":path|null}. Started means
//       the session's transcript has a real assistant record stamped at or
//       after <since>: a resume that wrote none never got going.

import * as nodeFs from "node:fs";
import { parseFlags } from "./parse-flags.mjs";
import { isMainModule } from "./is-main.mjs";
import { SESSION_ID_RE, findTranscriptById } from "./session-limit.mjs";

export const DEFAULT_MAX_AGE_MIN = 360;

// Every reason decideResume can give for not resuming, in the order it checks.
export const NO_RESUME_REASONS = Object.freeze([
  "off", // FACTORY_IMPLEMENT_RESUME=0
  "no-record", // nothing recorded (or not a session id)
  "stale", // recorded more than maxAgeMin ago, or with no usable time
  "worktree-new", // the worktree was created for this run, not reused
  "worktree-moved", // reused, but fast-forwarded or its leftovers set aside
  "head-moved", // the worktree HEAD isn't the one the stopped run left
  "task-changed", // a different approved plan, or different feedback
  "pr-closed", // the card's PR was closed or merged since
  "no-transcript", // claude has no <session>.jsonl to resume
]);

// Order ids by numeric value without Number(): comment ids are digit strings,
// and shorter-then-lexicographic is numeric order for them (and stable for
// anything else).
function byIdString(a, b) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function idList(ids) {
  const raw = Array.isArray(ids) ? ids : String(ids ?? "").split(",");
  return raw.map((id) => String(id ?? "").trim()).filter((id) => id !== "");
}

// "plan:<plan comment id>|rev:<revision comment ids, sorted, de-duplicated>".
// It names what the run was asked to do: a resumed session carries the plan and
// the feedback it was started with, so a new plan comment or a new feedback
// comment must start a fresh one. "" when there is no plan id.
export function taskKey({ planCommentId, revisionCommentIds = [] } = {}) {
  const plan = String(planCommentId ?? "").trim();
  if (plan === "" || plan === "null") return "";
  const revs = [...new Set(idList(revisionCommentIds))].sort(byIdString);
  return `plan:${plan}|rev:${revs.join(",")}`;
}

function no(reason, detail = null) {
  return { resume: false, reason, detail };
}

// Should this --implement run resume the recorded session? Pure: the caller
// looks up the transcript (findTranscriptById) and passes its path.
//   record     the issue's factory-state record (factory:get-issue)
//   worktree   worktree-cli add's JSON for this run
//   head       the worktree's HEAD now
//   taskKey    this run's task key (taskKey())
//   prState    the card's PR state (OPEN, CLOSED, MERGED), "" or null for none
//   transcript the recorded session's transcript path, or null
// Returns {resume:true, sessionId, preHead} — preHead is the PR head before
// the stopped run, "" when it had no PR — or {resume:false, reason, detail}.
export function decideResume({
  enabled = true,
  record = null,
  worktree = null,
  head = "",
  taskKey: key = "",
  prState = null,
  transcript = null,
  now = new Date(),
  maxAgeMin = DEFAULT_MAX_AGE_MIN,
} = {}) {
  if (!enabled) return no("off");
  const session = record?.implementResumeSession;
  if (!SESSION_ID_RE.test(String(session ?? ""))) return no("no-record");
  const atMs = Date.parse(String(record.implementResumeAt ?? ""));
  if (Number.isNaN(atMs)) return no("stale", "no record time");
  const ageMin = Math.floor((now.getTime() - atMs) / 60_000);
  if (ageMin > maxAgeMin) return no("stale", `recorded ${ageMin} min ago (max ${maxAgeMin})`);
  if (worktree?.reused !== true) return no("worktree-new");
  if (worktree.fastForwarded === true || worktree.leftoversRef) {
    return no(
      "worktree-moved",
      worktree.leftoversRef ? `leftovers at ${worktree.leftoversRef}` : "fast-forwarded",
    );
  }
  const recordedHead = String(record.implementResumeHead ?? "");
  if (!head || head !== recordedHead) {
    return no("head-moved", `${recordedHead.slice(0, 12) || "?"} → ${head.slice(0, 12) || "?"}`);
  }
  if (!key || key !== record.implementResumeKey) return no("task-changed");
  if (prState && prState !== "OPEN") return no("pr-closed", prState);
  if (!transcript) return no("no-transcript");
  return {
    resume: true,
    sessionId: session,
    preHead: String(record.implementResumePreHead ?? ""),
  };
}

// Did a resumed session get going? True when the transcript has an assistant
// record stamped at or after <since> that isn't an API error: the model
// answered. A resume that died first (a CLI error, an API error on the
// restored conversation) wrote none, and costs the card no attempt. <since> is
// bash's second-precision start time, truncated, so no slack is needed. An
// unreadable <since> counts as started: the attempt is spent, as before.
export function resumeStarted(jsonlText, since) {
  const sinceMs = Date.parse(String(since ?? ""));
  if (Number.isNaN(sinceMs)) return true;
  for (const line of String(jsonlText ?? "").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "assistant" || record.isApiErrorMessage === true) continue;
    const t = Date.parse(String(record.timestamp ?? ""));
    if (!Number.isNaN(t) && t >= sinceMs) return true;
  }
  return false;
}

function parseJsonFlag(raw, name) {
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`--${name} is not valid JSON`);
  }
}

function positiveInt(raw, fallback) {
  return /^[1-9][0-9]*$/.test(String(raw ?? "")) ? Number.parseInt(raw, 10) : fallback;
}

export function main(argv, { fs = nodeFs } = {}) {
  const [sub, ...rest] = argv;
  const { flags } = parseFlags(rest);
  const projectsDir = flags["projects-dir"] ?? null;
  switch (sub) {
    case "task-key":
      return taskKey({ planCommentId: flags["plan-id"], revisionCommentIds: flags["rev-ids"] });
    case "decide": {
      const now = flags.now == null ? new Date() : new Date(flags.now);
      if (Number.isNaN(now.getTime())) throw new Error(`invalid --now: ${flags.now}`);
      const record = parseJsonFlag(flags.record, "record");
      const session = record?.implementResumeSession;
      const decision = decideResume({
        enabled: (flags.enabled ?? "1") === "1",
        record,
        worktree: parseJsonFlag(flags.worktree, "worktree"),
        head: flags.head ?? "",
        taskKey: flags["task-key"] ?? "",
        prState: flags["pr-state"] || null,
        transcript: SESSION_ID_RE.test(String(session ?? ""))
          ? findTranscriptById(session, { projectsDir, fs })
          : null,
        now,
        maxAgeMin: positiveInt(flags["max-age-min"], DEFAULT_MAX_AGE_MIN),
      });
      return JSON.stringify(decision);
    }
    case "started": {
      const sessionId = flags["session-id"];
      if (!SESSION_ID_RE.test(String(sessionId ?? ""))) {
        throw new Error(`invalid --session-id: ${sessionId}`);
      }
      if (Number.isNaN(Date.parse(String(flags.since ?? "")))) {
        throw new Error(`invalid --since: ${flags.since}`);
      }
      const transcript = findTranscriptById(sessionId, { projectsDir, fs });
      const started = transcript
        ? resumeStarted(fs.readFileSync(transcript, "utf8"), flags.since)
        : false;
      return JSON.stringify({ started, transcript });
    }
    default:
      throw new Error(
        `unknown subcommand: ${sub ?? "(none)"} (task-key | decide | started; see the header)`,
      );
  }
}

if (isMainModule(import.meta.url)) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
    process.exit(1);
  }
}
