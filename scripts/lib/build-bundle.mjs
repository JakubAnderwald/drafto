#!/usr/bin/env node
// Build a context bundle that Claude consumes.
//
// Pure functions (`buildInboundThreadBundle`, `buildGithubCommentBatchBundle`)
// for unit tests, plus a CLI that reads a single JSON object on stdin and
// prints the resulting bundle JSON to stdout. The bash entry point
// (`scripts/support-agent.sh`) shells out once per work unit instead of
// building bundles inline with `jq -n`, so the wiring stays consistent with
// what the unit tests cover.
//
// Stdin shape (inbound_thread — `--auto-classify` / `--dry-run`):
//   {
//     "pending":  { /* one Zoho list-pending entry — the latest message */ },
//     "thread":   { "threadId": "...", "messages": [...] } | [<msg>, ...] | null,
//     "headers":  { /* parsed headers of the latest message */ } | {},
//     "state":    { /* state.mjs payload */ } | { /* empty */ },
//     "config":   { "allowlist", "adminEmail", "oauthUserEmail", "phase",
//                   "now"? }
//   }
//
// Stdin shape (github_comment_batch — `--comment-sync`):
//   {
//     "kind":          "github_comment_batch",
//     "issue":         { "number", "title", "state" },
//     "comments":      [ { "id", "user": { "login" }, "body", "created_at"|"createdAt" }, ... ],
//     "zohoThreadId":  "8537837000001234567"
//   }
//
// Stdout: the bundle the prompt documents.

import {
  humanIntervened,
  checkRateLimit,
  shouldNotifyAdmin,
  isAutoReplyableEnvelope,
  parseAllowlist,
  THREAD_WINDOW_MS,
} from "./policy.mjs";
import { emptyState } from "./state.mjs";
import { isMainModule } from "./is-main.mjs";

export function buildInboundThreadBundle({
  pending,
  thread,
  headers,
  state,
  config,
  nowIso = new Date().toISOString(),
} = {}) {
  const headersObj = headers && typeof headers === "object" ? headers : {};
  const stateObj = state && typeof state === "object" ? state : emptyState();
  const cfg = config ?? {};

  // Normalise thread shape to {threadId, messages[]} regardless of caller.
  const normalisedThread = normaliseThread(thread, pending);
  const threadId = normalisedThread.threadId ?? pending?.threadId ?? null;
  // For un-threaded singletons (Zoho hasn't assigned a threadId yet) we key
  // off messageId so the per-thread cooldown still works once a threadId is
  // assigned later — at that point the message will be threaded with itself.
  const trackKey = threadId ?? pending?.messageId ?? pending?.id ?? null;

  const sender = pending?.fromAddress ?? pending?.sender ?? null;
  // The list-pending entry IS the latest message in the thread (Zoho returns
  // newest-first; lib keeps first occurrence). So its `fromAddress` is the
  // signal humanIntervened() needs.
  const lastMessageFrom = sender;
  const lastMessageAutoSubmitted = pickHeader(headersObj, "Auto-Submitted");

  const human = humanIntervened({ lastMessageFrom, lastMessageAutoSubmitted }, cfg.oauthUserEmail);
  const envelope = isAutoReplyableEnvelope(headersObj);
  const rateLimit = trackKey
    ? checkRateLimit(stateObj, trackKey, sender ?? "", nowIso)
    : { ok: false, reason: "no track key" };
  // `rateLimitOk` covers both the rate-limit caps AND the loop-guard envelope
  // check, so the prompt only has to look at one boolean before attempting any
  // auto-reply path. The reason string surfaces whichever gate tripped first
  // (envelope wins because that's the stronger signal).
  const rateLimitOk = envelope.ok && rateLimit.ok;
  const rateLimitReason = !envelope.ok ? envelope.reason : !rateLimit.ok ? rateLimit.reason : null;
  const notify = trackKey ? shouldNotifyAdmin(stateObj, trackKey, nowIso) : false;

  const history = trackKey ? historyFor(stateObj, trackKey, nowIso) : {};

  return {
    kind: "inbound_thread",
    thread: normalisedThread,
    headers: headersObj,
    history,
    state: {
      humanIntervened: human,
      rateLimitOk,
      rateLimitReason,
      shouldNotifyAdmin: notify,
      trackKey,
    },
    config: {
      allowlist: normaliseAllowlist(cfg.allowlist),
      adminEmail: cfg.adminEmail ?? "",
      oauthUserEmail: cfg.oauthUserEmail ?? "",
      phase: cfg.phase ?? "D",
    },
  };
}

function normaliseThread(thread, pending) {
  if (Array.isArray(thread)) {
    // zoho-cli get-thread returns a raw `[<msg>, ...]` array — the threadId
    // doesn't appear at the array level so fall back to the pending entry's.
    return { threadId: pending?.threadId ?? null, messages: thread };
  }
  if (thread && typeof thread === "object" && Array.isArray(thread.messages)) {
    return {
      threadId: thread.threadId ?? pending?.threadId ?? null,
      messages: thread.messages,
    };
  }
  // No thread input (or get-thread failed) — wrap the pending entry as the
  // sole message. Common for un-threaded singletons.
  return {
    threadId: pending?.threadId ?? null,
    messages: pending ? [pending] : [],
  };
}

function pickHeader(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function normaliseAllowlist(input) {
  if (Array.isArray(input)) {
    return input.map((s) => String(s).toLowerCase().trim()).filter(Boolean);
  }
  if (typeof input === "string") return parseAllowlist(input);
  return [];
}

// Phase F: GitHub-comment → Zoho-reply sync. The bash side fetches the
// support issue + new comments via gh CLI (`scripts/lib/github-sync.mjs`),
// then hands the raw shape to this builder. Mirrors the prompt's
// `github_comment_batch` documentation exactly — `kind`, `issue` (subset),
// `comments` (normalised to `{id, user.login, body, createdAt}`), and the
// linked `zoho_thread_id`. The runner pre-filters out bot-author comments
// before calling, but the prompt re-checks defensively.
export function buildGithubCommentBatchBundle({ issue, comments, zohoThreadId } = {}) {
  return {
    kind: "github_comment_batch",
    issue: {
      number: issue?.number ?? null,
      title: issue?.title ?? "",
      state: issue?.state ?? "open",
    },
    comments: (Array.isArray(comments) ? comments : []).map((c) => ({
      id: c?.id ?? null,
      user: { login: c?.user?.login ?? c?.author?.login ?? "" },
      body: c?.body ?? "",
      createdAt: c?.createdAt ?? c?.created_at ?? null,
    })),
    zoho_thread_id: zohoThreadId ?? "",
  };
}

function historyFor(state, trackKey, nowIso) {
  const entry = state?.threads?.[trackKey];
  if (!entry) return {};
  // policy.mjs::bumpCounters prunes the autoReplies array on WRITE, but if a
  // thread hasn't been auto-replied since some entries fell out of the 24h
  // window, the array can still hold stale ISO timestamps. Filter at READ
  // time too so the prompt sees a true 24h-windowed count, not "count at
  // last bump".
  const now = Date.parse(nowIso);
  const recentAutoReplies = Array.isArray(entry.autoReplies)
    ? entry.autoReplies.filter((t) => now - Date.parse(t) < THREAD_WINDOW_MS)
    : [];
  return {
    autoReplyCount24h: recentAutoReplies.length,
    lastAdminNotificationAt: entry.lastAdminNotificationAt ?? null,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) throw new Error("build-bundle: empty stdin");
  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    throw new Error(`build-bundle: invalid stdin JSON: ${err.message}`);
  }
  let bundle;
  if (input.kind === "github_comment_batch") {
    bundle = buildGithubCommentBatchBundle({
      issue: input.issue,
      comments: input.comments,
      // Accept both shapes — bash uses `zohoThreadId` (camelCase, matches the
      // CLI flag), while the prompt documents the on-bundle field as
      // `zoho_thread_id` (snake_case). Builder normalises to snake on output.
      zohoThreadId: input.zohoThreadId ?? input.zoho_thread_id,
    });
  } else {
    const cfg = input.config ?? {};
    bundle = buildInboundThreadBundle({
      pending: input.pending ?? null,
      thread: input.thread ?? null,
      headers: input.headers ?? {},
      state: input.state ?? emptyState(),
      config: cfg,
      nowIso: cfg.now ?? new Date().toISOString(),
    });
  }
  process.stdout.write(JSON.stringify(bundle, null, 2) + "\n");
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
    process.exit(1);
  });
}
