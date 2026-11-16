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
//   task-key --plan-comment <comment JSON> [--revision-comments <JSON array>]
//            [--issue-record <issue JSON>] [--phase <A|B|C|D>]
//       The task key, bare:
//       "plan:<id>@<digest>|rev:<id>@<digest>,…|issue:<digest>|phase:<phase>",
//       each digest a hash of a body (the issue's is the spec), so an edit to
//       any of them changes the key.
//   worktree-digest --path <worktree>
//       A hash of the worktree's uncommitted state (status, diff against HEAD,
//       untracked files' contents), bare. Exit 1 when git can't say.
//   decide --record <issue JSON> --worktree <worktree-cli add JSON>
//          --head <sha> --tree-digest <digest> --task-key <key>
//          [--newest-owner-comment-at <iso>]
//          [--pr-state OPEN|CLOSED|MERGED|""] [--enabled 0|1]
//          [--max-age-min <n>] [--now <iso>] [--projects-dir <dir>]
//       One JSON line: {"resume":true,"sessionId":…,"preHead":…} or
//       {"resume":false,"reason":…,"detail":…}.
//   started --session-id <uuid> --since <iso> [--projects-dir <dir>]
//       One JSON line: {"started":bool,"transcript":path|null}. Started means
//       the session's transcript has a real assistant record stamped at or
//       after <since>: a resume that wrote none never got going.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  "worktree-dirty-changed", // same HEAD, but its uncommitted files changed
  "task-changed", // a different or edited approved plan, or different feedback
  "new-feedback", // an OWNER comment arrived after the stopped run started
  "pr-closed", // the card's PR was closed or merged since
  "no-transcript", // claude has no <session>.jsonl to resume
]);

// Order ids by numeric value without Number(): comment ids are digit strings,
// and shorter-then-lexicographic is numeric order for them (and stable for
// anything else).
function byIdString(a, b) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

// A short, stable hash of a comment body. Line endings are normalised so the
// same text always hashes the same; any other edit changes it.
export function bodyDigest(body) {
  return createHash("sha256")
    .update(String(body ?? "").replace(/\r\n/g, "\n"))
    .digest("hex")
    .slice(0, 16);
}

// The factory passes raw GitHub comments ({id, body}: fetch_issue_comments,
// extract_plan_comment); the bundle's approvedPlan spells them commentId and
// bodyEnveloped. Either shape maps to the same id and body.
function commentId(c) {
  const id = String(c?.id ?? c?.commentId ?? "").trim();
  return id === "null" || id === "undefined" ? "" : id;
}

function commentBody(c) {
  return c?.body ?? c?.bodyEnveloped ?? "";
}

// "plan:<id>@<digest>|rev:<id>@<digest>,…|issue:<digest>" (revisions sorted by
// id, one entry per id). It names what the run was asked to do: a resumed
// session carries the plan, the feedback and the issue body (the spec) it was
// started with, while a fresh run's bundle reads them again. So a new or edited
// plan comment (an in-place edit keeps the id), a new or edited feedback
// comment, or an edited issue body must start a fresh session. So must a
// change of FACTORY_PHASE: the phase decides what the run may touch, and a
// session holds the phase scope it started with. "" when there is no plan id.
export function taskKey({ plan = null, revisions = [], issue = null, phase = "" } = {}) {
  const planId = commentId(plan);
  if (planId === "") return "";
  const byId = new Map();
  for (const c of Array.isArray(revisions) ? revisions : []) {
    const id = commentId(c);
    if (id !== "") byId.set(id, bodyDigest(commentBody(c)));
  }
  const revs = [...byId.keys()].sort(byIdString).map((id) => `${id}@${byId.get(id)}`);
  return (
    `plan:${planId}@${bodyDigest(commentBody(plan))}|rev:${revs.join(",")}` +
    `|issue:${bodyDigest(issue?.body)}|phase:${String(phase ?? "").trim()}`
  );
}

function gitOut(cwd, args, spawn) {
  const r = spawn("git", ["-C", cwd, ...args], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

// A hash of everything uncommitted in <wtPath>: `git status` (staged,
// unstaged, untracked paths), the diff of tracked files against HEAD, the
// staged diff (the index can change while the files on disk don't), and the
// contents of untracked files that aren't ignored. A stopped run's edits that
// never reached a commit are part of what its session remembers, so a change
// to them between the stop and the next start must start a fresh session.
// null when git can't say (not a repo, a broken index).
export function worktreeDigest(wtPath, { spawn = spawnSync } = {}) {
  const status = gitOut(wtPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], spawn);
  const diff = gitOut(
    wtPath,
    ["diff", "HEAD", "--binary", "--no-color", "--no-ext-diff", "--no-textconv"],
    spawn,
  );
  const staged = gitOut(
    wtPath,
    ["diff", "--cached", "--binary", "--no-color", "--no-ext-diff", "--no-textconv"],
    spawn,
  );
  const untracked = gitOut(wtPath, ["ls-files", "--others", "--exclude-standard", "-z"], spawn);
  if (status == null || diff == null || staged == null || untracked == null) return null;
  const hash = createHash("sha256");
  hash.update("status\0").update(status).update("\0diff\0").update(diff);
  hash.update("\0staged\0").update(staged).update("\0untracked\0");
  for (const file of untracked.toString("utf8").split("\0").filter(Boolean).sort()) {
    const blob = gitOut(wtPath, ["hash-object", "--", file], spawn);
    if (blob == null) return null;
    hash.update(file).update("\0").update(blob);
  }
  return hash.digest("hex");
}

function no(reason, detail = null) {
  return { resume: false, reason, detail };
}

// Should this --implement run resume the recorded session? Pure: the caller
// looks up the transcript (findTranscriptById) and passes its path.
//   record     the issue's factory-state record (factory:get-issue)
//   worktree   worktree-cli add's JSON for this run
//   head       the worktree's HEAD now
//   treeDigest the worktree's uncommitted state now (worktreeDigest())
//   taskKey    this run's task key (taskKey())
//   newestOwnerCommentAt  createdAt of the newest OWNER comment that isn't the
//              factory's own (no "<!-- drafto-factory" marker), or null
//   prState    the card's PR state (OPEN, CLOSED, MERGED), "" or null for none
//   transcript the recorded session's transcript path, or null
// Returns {resume:true, sessionId, preHead} — preHead is the PR head before
// the stopped run, "" when it had no PR — or {resume:false, reason, detail}.
export function decideResume({
  enabled = true,
  record = null,
  worktree = null,
  head = "",
  treeDigest = null,
  taskKey: key = "",
  newestOwnerCommentAt = null,
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
  if (!treeDigest || treeDigest !== record.implementResumeTreeDigest) {
    return no("worktree-dirty-changed");
  }
  if (!key || key !== record.implementResumeKey) return no("task-changed");
  // The key only names the feedback a run was given. On a first
  // implementation there is none (no lastFeedbackAt yet), so a comment the
  // reporter posts meanwhile must still start a fresh session, whose bundle
  // carries it (#842 review).
  const startedMs = Date.parse(String(record.implementResumeRunStartedAt ?? ""));
  if (Number.isNaN(startedMs)) return no("new-feedback", "no run start recorded");
  const newestMs = Date.parse(String(newestOwnerCommentAt ?? ""));
  if (!Number.isNaN(newestMs) && newestMs > startedMs) {
    return no("new-feedback", `owner comment at ${newestOwnerCommentAt}`);
  }
  if (prState && prState !== "OPEN") return no("pr-closed", prState);
  if (!transcript) return no("no-transcript");
  return {
    resume: true,
    sessionId: session,
    preHead: String(record.implementResumePreHead ?? ""),
  };
}

// Did a resumed session get going? True when the transcript has an assistant
// record stamped at or after <since> that isn't an API error or written by the
// CLI itself: the model answered. A resume that died first (a CLI error, an API error on the
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
    // The CLI writes some assistant records itself (model "<synthetic>": an
    // interruption note, a "no response requested" filler), not the model.
    if (record.message?.model === "<synthetic>") continue;
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
      return taskKey({
        plan: parseJsonFlag(flags["plan-comment"], "plan-comment"),
        revisions: parseJsonFlag(flags["revision-comments"], "revision-comments") ?? [],
        issue: parseJsonFlag(flags["issue-record"], "issue-record"),
        phase: flags.phase ?? "",
      });
    case "worktree-digest": {
      if (!flags.path) throw new Error("worktree-digest requires --path <worktree>");
      const digest = worktreeDigest(flags.path);
      if (digest == null) throw new Error(`git could not read the worktree at ${flags.path}`);
      return digest;
    }
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
        treeDigest: flags["tree-digest"] || null,
        taskKey: flags["task-key"] ?? "",
        newestOwnerCommentAt: flags["newest-owner-comment-at"] || null,
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
        `unknown subcommand: ${sub ?? "(none)"} (task-key | worktree-digest | decide | started; see the header)`,
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
