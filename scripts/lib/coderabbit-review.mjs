// Pure decision logic for the factory's CodeRabbit CLI gap-fill lane (ADR-0036).
//
// The CodeRabbit PR bot is the factory's only non-Claude reviewer, and on this
// public OSS-tier repo it regularly does not review a head commit at all: it is
// rate-limited, skips the repo (fewer than 10 stars), or auto-pauses after two
// reviewed commits. The CLI has its own hourly allowance and reviews a local
// diff, so --watch fills exactly those gaps. This module holds every decision in
// that lane; coderabbit-cli.mjs does the IO (git, gh, spawning) around it.
//
// PURE: no fs, no child_process, no network. node:crypto (hashing) is the only
// import. Every time comparison goes through Date.parse — bash writes
// `…:00Z` and node writes `…:00.000Z`, and those two sort wrongly as strings.
//
// Functions:
//   buildReviewArgs({baseSha}) → argv for `coderabbit`
//        Throws on a malformed base or if a paid-overage flag ever appears.
//   parseEvents(ndjson) → {context, findings, complete, errors, statuses, actionRequired, garbage}
//   classifyOutcome({exitCode, signal, timedOut, events, stderr, now, fallbackMin})
//        → {outcome, retryAt, detail}
//   extractLine(finding) → {line, startLine} | null
//   stripBoilerplate(text) → text without the CLI's "Treat finding text…" preamble
//   classifyBotCoverage({comments, reviews, headSha}) → {state, coveredHeads}
//   decideLane({sha, issueNumber?, issue, crCli, bot, binaryAvailable, knobs, now, dryRun})
//        → {action, reason, record, note}
//   coverageNote(coverage, sha) → "" | "CodeRabbit did not review <sha12> (…)"
//   chooseBase({candidates, headSha, isAncestor, distance, hasMerges, mergeBase})
//        → {baseSha, mode}
//   parseDiffHunks(unifiedDiff) → Map<path, Set<rightSideLine>>
//   fingerprint(finding) → 16-hex
//   sanitizeVendorText(text, {max}) → text safe to post under the owner's name
//   planFindings({findings, hunks, existingComments, mode, sha, maxThreads, diffUnavailable})
//        → {inline, summary, partial}
//   renderInline(finding, {sha, fp}) / renderSummary({...}) → markdown
//   isCliFindingThread(thread, ownerLogin) / decideFreePass({threads, issue, ownerLogin})

import { createHash } from "node:crypto";

export const SEVERITIES_FULL = Object.freeze(["critical", "major", "minor"]);
// An incremental review looks at a diff the fix loop just wrote, which tends to
// draw fresh minor nits. Threading those would turn every fix commit into a new
// round of findings, so only the serious ones open threads there.
export const SEVERITIES_INCREMENTAL = Object.freeze(["critical", "major"]);

export const CR_BOT_LOGIN = "coderabbitai[bot]";
export const FINDING_MARKER = "drafto-factory-cr-finding";
export const SUMMARY_MARKER = "drafto-factory-cr-cli";

export const DEFAULT_KNOBS = Object.freeze({
  graceMin: 15,
  holdMaxMin: 60,
  maxRunsPerCard: 2,
  maxPerHour: 3,
});

// Coverage values that mean "a CodeRabbit engine looked at this commit". Every
// other recorded coverage is a gap the In Test hand-off has to mention —
// including "cli-partial": a review whose serious findings only reached the
// collapsed summary comment has not put them in front of the fix loop.
const COVERED_KINDS = new Set(["bot", "cli", "cli-empty"]);

const SEVERITY_RANK = { critical: 0, major: 1, minor: 2, trivial: 3, info: 4, none: 5 };

const SHA40 = /^[0-9a-f]{40}$/;

// Built by concatenation so this file never contains the literal flag — the
// guard test greps scripts/ for it, and a literal here would be indistinguishable
// from a real use.
const PAID_OVERAGE_FLAG = "--use-" + "credits";

const MINUTE_MS = 60_000;

// No vendor wait is honoured past a day. A parsed "100000000 hours" (or an ISO
// date in year 9999) would otherwise pause the lane for good — or overflow
// Date and throw on every housekeeping tick, which never clears the run.
const MAX_RETRY_MS = 24 * 60 * MINUTE_MS;

// ── argv ────────────────────────────────────────────────────────────────────

export function buildReviewArgs({ baseSha } = {}) {
  const base = typeof baseSha === "string" ? baseSha.trim().toLowerCase() : "";
  if (!SHA40.test(base)) {
    throw new Error(
      `buildReviewArgs: baseSha must be a 40-hex commit, got ${JSON.stringify(baseSha)}`,
    );
  }
  const args = ["review", "--agent", "--base-commit", base];
  assertNoPaidFlags(args);
  return args;
}

// Drafto runs on free tiers only (CLAUDE.md, "Infrastructure cost discipline").
// The CLI's paid overage is opt-in per invocation, so refusing the flag here is
// the whole guarantee that an unattended loop can never run up a bill.
export function assertNoPaidFlags(args) {
  for (const arg of args ?? []) {
    if (String(arg).includes(PAID_OVERAGE_FLAG)) {
      throw new Error("refusing to run CodeRabbit with paid overage enabled");
    }
  }
}

// ── event stream ────────────────────────────────────────────────────────────

export function parseEvents(ndjson) {
  const out = {
    context: null,
    findings: [],
    complete: null,
    errors: [],
    statuses: [],
    actionRequired: null,
    garbage: 0,
  };
  for (const raw of String(ndjson ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      out.garbage++;
      continue;
    }
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
      out.garbage++;
      continue;
    }
    switch (ev.type) {
      case "review_context":
        out.context = ev;
        break;
      case "finding":
        out.findings.push(ev);
        break;
      case "complete":
        out.complete = ev;
        if (ev.status === "action_required") out.actionRequired ??= ev;
        break;
      case "error":
        out.errors.push(ev);
        break;
      case "status":
        out.statuses.push(ev);
        if (ev.status === "action_required") out.actionRequired ??= ev;
        break;
      case "action_required":
        out.actionRequired ??= ev;
        break;
      default:
        // heartbeat and any event type a newer CLI adds: informational only.
        break;
    }
  }
  return out;
}

const RATE_LIMIT_RE =
  /rate[\s_-]?limit|limit reached|too many requests|quota exceeded|used all \d* ?included reviews/i;
const AUTH_ERROR_TYPES = new Set(["auth", "authentication", "unauthorized", "unauthenticated"]);
const AUTH_RE =
  /not (?:signed|logged) in|\bsign[\s-]?in\b|\blog[\s-]?in\b|unauthori[sz]ed|unauthenticated|\b401\b|(?:token|session) (?:expired|invalid)|invalid (?:token|api key)/i;
const TRANSIENT_ERROR_TYPES = new Set(["connection", "network", "websocket"]);
const NETWORK_RE =
  /connect|network|websocket|socket|econnreset|etimedout|enotfound|eai_again|\b50[234]\b|service unavailable/i;

// Only a skip because the diff is empty means "reviewed, nothing to say". A
// skip for any other reason (too many files, an unsupported diff) reviewed
// nothing, and recording it as cli-empty would drop the In Test note.
const NO_CHANGES_RE = /no changes/i;

// Precedence matters, and one deviation from a flat "errors first" reading is
// deliberate: a `complete` event that reports a finished review (or a skip of
// an empty diff) wins over a stray recovered error or a supervisor timeout that
// fired after the CLI had already written its result. Only an action-required
// (billing) signal outranks it, because acting on that result would mean
// consenting to spend. A `complete` with any other status is a failed review:
// it ranks below the recognisable errors, and is never ok, whatever the exit code.
export function classifyOutcome({
  exitCode = null,
  signal = null,
  timedOut = false,
  events,
  stderr = "",
  now = new Date().toISOString(),
  fallbackMin = 60,
} = {}) {
  const ev = typeof events === "string" || events == null ? parseEvents(events) : events;
  const errors = Array.isArray(ev.errors) ? ev.errors : [];
  const findings = Array.isArray(ev.findings) ? ev.findings : [];
  const errText = String(stderr ?? "");
  const nowMs = parseMs(now) ?? Date.now();
  const fallback = Number(fallbackMin);
  const fallbackMs =
    Number.isFinite(fallback) && fallback >= 0 ? fallback * MINUTE_MS : 60 * MINUTE_MS;

  const onDemand = errors.find(
    (e) => e?.metadata?.onDemandReviewAvailable === true && e?.errorType !== "rate_limit",
  );
  if (ev.actionRequired || onDemand) {
    return {
      outcome: "action_required",
      retryAt: retryIso(nowMs, nowMs + fallbackMs),
      detail: "CodeRabbit asked for usage-based billing consent; never granted",
    };
  }

  const complete = ev.complete;
  // The skip reason is on the complete event; the setup status event that
  // announced the skip carries the same message, so it stands in when absent.
  const skipStatus = (Array.isArray(ev.statuses) ? ev.statuses : []).find(
    (s) => s?.status === "review_skipped",
  );
  const skipMessage =
    complete?.status === "review_skipped"
      ? String(complete.message || skipStatus?.message || "")
      : "";
  if (complete?.status === "review_completed") {
    const count = Number.isFinite(Number(complete.findings))
      ? Number(complete.findings)
      : findings.length;
    if (count === 0 && findings.length === 0) {
      return { outcome: "empty", retryAt: null, detail: `complete:${complete.status}` };
    }
    // The vendor said it found something but no finding line survived parsing
    // (garbled NDJSON). Recording that as a clean review would silently drop
    // every finding, so it is a failed run instead.
    if (findings.length === 0) {
      return {
        outcome: "error",
        retryAt: null,
        detail: `complete:${complete.status} reported ${count} findings but none could be parsed`,
      };
    }
    return {
      outcome: "ok",
      retryAt: null,
      detail: `complete:${complete.status} findings=${findings.length}`,
      // Fewer parsed than reported: what was parsed still gets posted, but the
      // commit is only partly reviewed (the caller records cli-partial).
      ...(count > findings.length ? { incomplete: true } : {}),
    };
  }
  if (complete?.status === "review_skipped" && NO_CHANGES_RE.test(skipMessage)) {
    return { outcome: "empty", retryAt: null, detail: `complete:${complete.status}` };
  }

  const rateErr = errors.find(
    (e) => e?.errorType === "rate_limit" || RATE_LIMIT_RE.test(String(e?.message ?? "")),
  );
  if (rateErr || (errors.length === 0 && RATE_LIMIT_RE.test(errText))) {
    const texts = [rateErr?.message, rateErr?.metadata?.policyGuidance, errText].filter(Boolean);
    const waitMs = parseWaitTime(rateErr?.metadata?.waitTime) ?? firstRelativeWait(texts) ?? null;
    let retryMs = waitMs != null ? nowMs + waitMs : firstFutureIso(texts, nowMs);
    if (retryMs == null) retryMs = nowMs + fallbackMs;
    return {
      outcome: "rate_limited",
      retryAt: retryIso(nowMs, retryMs),
      detail: String(rateErr?.message ?? "rate limit").slice(0, 200),
    };
  }

  const authErr = errors.find(
    (e) =>
      AUTH_ERROR_TYPES.has(String(e?.errorType ?? "").toLowerCase()) ||
      AUTH_RE.test(String(e?.message ?? "")),
  );
  if (authErr || (errors.length === 0 && AUTH_RE.test(errText))) {
    return {
      outcome: "auth",
      retryAt: null,
      detail: String(authErr?.message ?? "authentication failed").slice(0, 200),
    };
  }

  const netErr = errors.find(
    (e) =>
      TRANSIENT_ERROR_TYPES.has(String(e?.errorType ?? "").toLowerCase()) ||
      (e?.recoverable === true && NETWORK_RE.test(String(e?.message ?? ""))),
  );
  if (netErr || (errors.length === 0 && !timedOut && exitCode !== 0 && NETWORK_RE.test(errText))) {
    return {
      outcome: "transient",
      retryAt: null,
      detail: String(netErr?.message ?? errText.trim() ?? "network error").slice(0, 200),
    };
  }

  if (timedOut) {
    return { outcome: "timeout", retryAt: null, detail: "review exceeded its wall-clock cap" };
  }

  if (complete) {
    // review_failed, a skip that reviewed nothing, or a status a newer CLI
    // adds: the vendor says it finished, but not with a review of this diff.
    const status = oneLine(complete.status ?? "unknown");
    const message = oneLine(skipMessage || complete.message || "");
    const detail = message ? `complete:${status}: ${message}` : `complete:${status}`;
    return { outcome: "error", retryAt: null, detail: detail.slice(0, 200) };
  }

  if (exitCode === 0 && findings.length > 0) {
    return {
      outcome: "ok",
      retryAt: null,
      detail: `no complete event; salvaged ${findings.length} finding(s)`,
    };
  }

  const firstErr = errors[0]?.message ?? errText.trim().split("\n").pop() ?? "";
  const how = signal ? `signal ${signal}` : `exit ${exitCode}`;
  return {
    outcome: "error",
    retryAt: null,
    detail: `${how}${firstErr ? `: ${String(firstErr).slice(0, 200)}` : ""}`,
  };
}

const UNIT_MS = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: MINUTE_MS,
  min: MINUTE_MS,
  mins: MINUTE_MS,
  minute: MINUTE_MS,
  minutes: MINUTE_MS,
  h: 60 * MINUTE_MS,
  hr: 60 * MINUTE_MS,
  hrs: 60 * MINUTE_MS,
  hour: 60 * MINUTE_MS,
  hours: 60 * MINUTE_MS,
};
// `(?![a-z])`, not `\b`: in compact forms like "1h30m" the unit is followed by
// a digit, which is also a word character, so `\b` never matched there and the
// leading "1h" was silently dropped.
const UNIT_PAIR_RE =
  /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)(?![a-z])/gi;

// "50 minutes", "1 hour 5 minutes", "30 seconds" → milliseconds (summed),
// capped at MAX_RETRY_MS. A digit run too long for a double is Infinity, which
// the cap also absorbs.
export function parseWaitTime(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  let total = 0;
  let matched = false;
  for (const m of text.matchAll(UNIT_PAIR_RE)) {
    total += Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
    matched = true;
  }
  return matched ? Math.min(total, MAX_RETRY_MS) : null;
}

function firstRelativeWait(texts) {
  const re =
    /\b(?:in|after|wait(?:\s+for)?)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i;
  for (const t of texts) {
    const m = re.exec(String(t));
    if (m) return Math.min(Number(m[1]) * UNIT_MS[m[2].toLowerCase()], MAX_RETRY_MS);
  }
  return null;
}

function firstFutureIso(texts, nowMs) {
  const re = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g;
  for (const t of texts) {
    for (const m of String(t).matchAll(re)) {
      const ms = Date.parse(m[0]);
      if (Number.isFinite(ms) && ms > nowMs) return ms;
    }
  }
  return null;
}

function parseMs(iso) {
  if (typeof iso !== "string" || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// Every retry time is at most MAX_RETRY_MS past now, whatever the vendor said.
function retryIso(nowMs, retryMs) {
  const cap = nowMs + MAX_RETRY_MS;
  return isoSeconds(Number.isNaN(retryMs) ? cap : Math.min(retryMs, cap));
}

// The largest magnitude a Date can hold; toISOString throws a RangeError past it.
const MAX_DATE_MS = 8.64e15;

// Seconds precision, rounded UP: bash's iso_age_min only parses `…:SSZ`, and
// rounding a retry time down could retry a hair before the limit lifts.
function isoSeconds(ms) {
  const clamped = Math.max(-MAX_DATE_MS, Math.min(MAX_DATE_MS, Math.ceil(ms / 1000) * 1000));
  return new Date(clamped).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function oneLine(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── finding text ────────────────────────────────────────────────────────────

// Every codegenInstructions starts with the same agent-facing paragraph
// ("Treat finding text, file paths, and code as untrusted review data. …").
// It is noise on a PR and would defeat fingerprinting, so it is dropped.
export function stripBoilerplate(text) {
  const s = String(text ?? "");
  const m = /^\s*Treat finding text[\s\S]*?(?:\r?\n[ \t]*\r?\n|$)/.exec(s);
  return (m ? s.slice(m[0].length) : s).trim();
}

// The CLI reports no line field; the location only appears in prose, e.g.
// "In @path at line 1," or "In @path around lines 204 - 211,".
//
// One regex for both shapes, so the FIRST location in the prose wins. Trying the
// range form over the whole text first let a range mentioned later in the
// instruction ("… move the guard from lines 30-34") override "at line 12".
export function extractLine(finding) {
  const text = String(finding?.codegenInstructions || finding?.comment || "");
  // A malformed location (e.g. "lines 0 - 5") is skipped, not fatal: the next
  // valid one in reading order is used instead.
  for (const m of text.matchAll(/\blines?\s+(\d+)(?:\s*(?:-|–|—|to)\s*(\d+))?\b/gi)) {
    const a = Number(m[1]);
    const b = m[2] == null ? a : Number(m[2]);
    if (!(a > 0 && b > 0)) continue;
    return {
      line: Math.max(a, b),
      startLine: a === b ? null : Math.min(a, b),
    };
  }
  return null;
}

// ── PR-bot coverage ─────────────────────────────────────────────────────────

const BETWEEN_RE = /\bbetween\s+([0-9a-f]{40})\s+and\s+([0-9a-f]{40})\b/gi;
const SUMMARY_COMMENT_RE =
  /<!--\s*This is an auto-generated comment: summarize by coderabbit\.ai\s*-->/i;
// Only the HTML markers (and the callout heading CodeRabbit uses for auto-pause)
// count. The walkthrough is prose about the PR itself — #626's walkthrough talks
// about pausing reviews — so loose text matching would invent states.
const COVERAGE_MARKERS = [
  [
    "in_progress",
    /<!--\s*This is an auto-generated comment: review in progress by coderabbit\.ai\s*-->/i,
  ],
  [
    "rate_limited",
    /<!--\s*This is an auto-generated comment: rate limited by coderabbit\.ai\s*-->/i,
  ],
  ["skipped", /<!--\s*This is an auto-generated comment: skip review by coderabbit\.ai\s*-->/i],
  ["paused", /<!--\s*This is an auto-generated comment: review paused by coderabbit\.ai\s*-->/i],
  ["paused", /^\s*>\s*#{1,6}\s*Reviews paused\s*$/im],
];

// Login alone is spoofable in GraphQL (`coderabbitai`), but a REST user of
// type "Bot" named "coderabbitai[bot]" can only be the GitHub App itself.
export function isTrustedBotItem(item) {
  return item?.user?.type === "Bot" && item?.user?.login === CR_BOT_LOGIN;
}

function headsIn(body) {
  const heads = [];
  for (const m of String(body ?? "").matchAll(BETWEEN_RE)) heads.push(m[2].toLowerCase());
  return heads;
}

function markerState(body) {
  for (const [state, re] of COVERAGE_MARKERS) if (re.test(body)) return state;
  return null;
}

// Verified against #620/#621/#626/#627/#628:
//   - an EMPTY-body bot review is a reply to a thread, not a review, so a bot
//     review's commit_id says nothing about coverage;
//   - a NON-EMPTY review body names the range it reviewed ("between A and B");
//   - the summary comment is edited in place, and a rate-limited one (#627)
//     still lists the range it WOULD have reviewed — so markers beat `between`;
//   - a zero-finding review (#626) creates no review object at all; only the
//     marker-free summary's `between … and HEAD` records it.
export function classifyBotCoverage({ comments = [], reviews = [], headSha } = {}) {
  const head = String(headSha ?? "").toLowerCase();
  const reviewHeads = [];
  for (const review of reviews ?? []) {
    if (!isTrustedBotItem(review) || !String(review.body ?? "").trim()) continue;
    for (const h of headsIn(review.body)) if (!reviewHeads.includes(h)) reviewHeads.push(h);
  }

  const summaries = (comments ?? [])
    .map((c, idx) => ({ c, idx, body: String(c?.body ?? "") }))
    .filter(
      ({ c, body }) => isTrustedBotItem(c) && (SUMMARY_COMMENT_RE.test(body) || markerState(body)),
    );
  summaries.sort(
    (x, y) =>
      (parseMs(x.c.updated_at ?? x.c.created_at) ?? 0) -
        (parseMs(y.c.updated_at ?? y.c.created_at) ?? 0) || x.idx - y.idx,
  );
  const latest = summaries.length ? summaries[summaries.length - 1].body : "";
  const marker = latest ? markerState(latest) : null;
  const summaryHeads = latest && !marker ? headsIn(latest) : [];

  const coveredHeads = [...reviewHeads];
  for (const h of summaryHeads) if (!coveredHeads.includes(h)) coveredHeads.push(h);

  let state = "absent";
  if (head && reviewHeads.includes(head)) state = "covered";
  else if (marker) state = marker;
  else if (head && summaryHeads.includes(head)) state = "covered";
  return { state, coveredHeads };
}

// ── lane gate ───────────────────────────────────────────────────────────────

const COVERAGE_REASONS = {
  budget: "the CodeRabbit CLI hourly review allowance was used up",
  "hold-expired": "no CodeRabbit review finished within the hold window",
  "cap-reached": "the per-card CodeRabbit CLI run cap was reached",
  "cli-unavailable":
    "the CodeRabbit CLI was unavailable (missing, signed out, or failing its health check)",
  "cli-failed": "the CodeRabbit CLI review failed",
  "cli-partial":
    "some CodeRabbit CLI findings could not be opened as review threads; see the CLI summary comment",
};

// How long past its own wall-clock deadline a run may keep its card on hold:
// housekeeping's overdue grace (10 min) + its posting give-up window (60 min) +
// 10 min slack for ticks. Past that, housekeeping is evidently not finishing
// the run (it throws every tick, or the state can't be saved), and the card
// must not wait on it forever.
const IN_FLIGHT_OVERRUN_MS = 80 * MINUTE_MS;

// Did the factory's own CodeRabbit CLI lane review <headSha>, and how well?
//
// The lane records its verdict in factory state, but a PR merged by hand has no
// card, so this reads what the lane stamped on the PR: the summary comment's
// marker carries both the SHA and the coverage kind.
//
// It reads the kind rather than inferring it. An earlier version of this function
// tried to recover it from the summary prose and was wrong in both directions: a
// run where findings failed to parse renders identically to a clean one (so it
// called an uncovered commit covered), while a finding legitimately routed to the
// summary made it call a covered commit partial.
//
// Only the repo owner counts. The factory posts as the owner, and without that
// check any PR author could paste the marker into a comment and manufacture
// coverage for their own branch — the same reasoning as isTrustedBotItem.
//
// Unknown is not coverage. A marker with no kind predates this stamping, and the
// most conservative kind wins when several comments carry the marker, so a later
// comment quoting an older one can never upgrade the verdict.
export function classifyCliCoverage({ comments = [], headSha, ownerLogin } = {}) {
  const head = String(headSha ?? "").toLowerCase();
  if (!SHA40.test(head) || !ownerLogin) return { state: "absent" };
  const marker = new RegExp(
    `<!--\\s*${SUMMARY_MARKER}\\s+sha=${head}(?:\\s+kind=([a-z-]+))?\\s*-->`,
    "i",
  );

  let seen = false;
  let best = null; // most conservative wins
  for (const c of comments ?? []) {
    if (c?.user?.login !== ownerLogin) continue;
    const m = marker.exec(String(c?.body ?? ""));
    if (!m) continue;
    seen = true;
    const kind = (m[1] ?? "").toLowerCase();
    const state = kind === "cli" || kind === "cli-empty" ? "cli" : kind || "cli-partial";
    if (state !== "cli") best = best ?? state;
  }
  if (!seen) return { state: "absent" };
  return { state: best ?? "cli" };
}

export function coverageNote(coverage, sha) {
  if (coverage == null || coverage === "" || COVERED_KINDS.has(coverage)) return "";
  const why = COVERAGE_REASONS[coverage] ?? String(coverage);
  return `CodeRabbit did not review ${String(sha ?? "").slice(0, 12)} (${why})`;
}

// First match wins; see CONTRACTS / ADR-0036 for the rationale of the order.
// Only one CLI review may run at a time — the spike showed a second concurrent
// run dying with a WebSocket error — so "another run in flight" is a hold, not a
// failure. Every hold is bounded by holdMaxMin measured from when the SHA first
// converged — except this card's own run, which is bounded by the run's
// deadline plus IN_FLIGHT_OVERRUN_MS — so a card can never wait on CodeRabbit
// indefinitely.
export function decideLane({
  sha,
  issueNumber = null,
  issue = {},
  crCli = {},
  bot = null,
  binaryAvailable = false,
  knobs = {},
  now = new Date().toISOString(),
  dryRun = false,
} = {}) {
  const k = { ...DEFAULT_KNOBS, ...stripUndefined(knobs) };
  const head = String(sha ?? "").toLowerCase();
  const nowMs = parseMs(now) ?? Date.now();
  const convergedMs = parseMs(issue?.crConvergedAt) ?? nowMs;
  const ageMin = (nowMs - convergedMs) / MINUTE_MS;
  const holdDeadlineMs = convergedMs + Number(k.holdMaxMin) * MINUTE_MS;
  const botState = bot?.state ?? "absent";
  const inFlight = crCli?.inFlight ?? null;

  const decide = (action, reason, record = null, note = null) => {
    const resolvedNote = note ?? (record ? coverageNote(record, head) : "");
    if (!dryRun) return { action, reason, record, note: resolvedNote };
    // A dry run observes: it never holds a card, starts a run or records a
    // decision, but it still reports what it would have done.
    return {
      action: "promote",
      reason: `dry-run:${action}:${reason}`,
      record: null,
      note: resolvedNote,
    };
  };

  if (issue?.crCoverageSha && String(issue.crCoverageSha).toLowerCase() === head) {
    return decide(
      "promote",
      `decided:${issue.crCoverage ?? "unknown"}`,
      null,
      coverageNote(issue.crCoverage, head),
    );
  }

  const inFlightIsOurs =
    inFlight &&
    String(inFlight.sha ?? "").toLowerCase() === head &&
    (issueNumber == null || String(inFlight.issue) === String(issueNumber));
  if (inFlightIsOurs) {
    // A run with no readable deadline falls back to its start, then to the
    // card's own hold deadline: an unbounded hold is never the fallback.
    const anchorMs = parseMs(inFlight.deadlineAt) ?? parseMs(inFlight.startedAt) ?? holdDeadlineMs;
    if (nowMs >= anchorMs + IN_FLIGHT_OVERRUN_MS) {
      return decide("promote", "cli-in-flight-expired", "hold-expired");
    }
    return decide("hold", "cli-in-flight");
  }

  if (botState === "covered") return decide("promote", "bot-covered", "bot");

  if (botState === "in_progress") {
    if (nowMs < holdDeadlineMs) return decide("hold", "bot-in-progress");
    return decide("promote", "bot-in-progress-expired", "hold-expired");
  }
  if (botState === "absent" && ageMin < Number(k.graceMin)) {
    // The grace period is a wait like any other: it must not outlive the hold
    // deadline, or a misconfigured graceMin > holdMaxMin holds a card forever.
    if (nowMs < holdDeadlineMs) return decide("hold", "bot-grace");
    return decide("promote", "bot-grace-expired", "hold-expired");
  }

  if (!binaryAvailable) return decide("promote", "cli-unavailable", "cli-unavailable");

  if ((Number(issue?.crCliRuns) || 0) >= Number(k.maxRunsPerCard)) {
    return decide("promote", "cap-reached", "cap-reached");
  }

  if (nowMs >= holdDeadlineMs) return decide("promote", "hold-expired", "hold-expired");

  const pausedUntilMs = parseMs(crCli?.pausedUntil);
  const paused = pausedUntilMs != null ? pausedUntilMs > nowMs : crCli?.paused === true;
  if (paused) {
    const why = String(crCli?.pausedReason ?? "");
    // Only the lane's own budget pauses (a vendor rate limit, a billing prompt)
    // are worth waiting out: they lift on a schedule the vendor gave us. Any
    // other pause — auth, doctor, an operator's pause with a free-form reason,
    // or one with no usable end — means the CLI is not going to review this
    // commit, so holding the card would only delay it.
    if (BUDGET_PAUSE_REASONS.has(why) && pausedUntilMs != null) {
      if (pausedUntilMs <= holdDeadlineMs) return decide("hold", "cli-paused");
      return decide("promote", "cli-paused-past-deadline", "budget");
    }
    return decide("promote", `cli-paused:${pauseLabel(why, pausedUntilMs)}`, "cli-unavailable");
  }

  if (inFlight) return decide("hold", "cli-busy");

  if ((Number(crCli?.usedLastHour) || 0) >= Number(k.maxPerHour)) {
    const nextMs = parseMs(crCli?.nextSlotAt);
    if (nextMs != null && nextMs <= holdDeadlineMs) return decide("hold", "cli-budget-wait");
    return decide("promote", "budget", "budget");
  }

  return decide("start", `gap:${botState}`);
}

// The pause reasons coderabbit-cli.mjs sets itself from a vendor budget signal.
const BUDGET_PAUSE_REASONS = new Set(["rate_limited", "action_required"]);

// An operator's reason is free text; keep the decision reason one log-safe token.
function pauseLabel(why, pausedUntilMs) {
  if (why) return why.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 40);
  return pausedUntilMs == null ? "indefinite" : "unspecified";
}

function stripUndefined(obj) {
  const out = {};
  for (const [key, v] of Object.entries(obj ?? {}))
    if (v !== undefined && v !== null && v !== "") out[key] = v;
  return out;
}

// ── base selection ──────────────────────────────────────────────────────────

// The nearest already-reviewed ancestor makes the review incremental — e.g. the
// bot reviewed SHA1 and SHA2, paused, and the CLI reviews only SHA2..SHA3. A
// merge commit in that range (an update-branch from main) would drag all of
// main's changes into the diff, so that case, and "no reviewed ancestor"
// (force push), fall back to a full review against the merge-base.
export function chooseBase({
  candidates = [],
  headSha,
  isAncestor,
  distance,
  hasMerges,
  mergeBase,
} = {}) {
  const head = String(headSha ?? "").toLowerCase();
  const seen = new Set();
  let best = null;
  let bestDistance = Infinity;
  for (const raw of candidates ?? []) {
    if (typeof raw !== "string") continue;
    const c = raw.trim().toLowerCase();
    if (!SHA40.test(c) || c === head || seen.has(c)) continue;
    seen.add(c);
    if (!safeCall(isAncestor, c, false)) continue;
    const d = Number(safeCall(distance, c, NaN));
    if (!Number.isFinite(d) || d <= 0) continue;
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  // A failed merge probe must fail SAFE: assume merges, review the full diff.
  if (best && !safeCall(hasMerges, best, true)) return { baseSha: best, mode: "incremental" };
  const mb = String(mergeBase ?? "")
    .trim()
    .toLowerCase();
  if (!SHA40.test(mb))
    throw new Error("chooseBase: a 40-hex mergeBase is required for a full review");
  return { baseSha: mb, mode: "full" };
}

function safeCall(fn, arg, fallback) {
  if (typeof fn !== "function") return fallback;
  try {
    return fn(arg);
  } catch {
    return fallback;
  }
}

// ── diff hunks ──────────────────────────────────────────────────────────────

// RIGHT-side lines GitHub will accept an inline comment on: added and context
// lines inside a hunk. Hunk bodies are consumed by their header counts, not by
// sniffing prefixes, so a removed line that itself begins "-- " (rendering as
// "--- ") can't be mistaken for a file header.
export function parseDiffHunks(unifiedDiff) {
  const hunks = new Map();
  const lines = String(unifiedDiff ?? "").split("\n");
  let block = null;
  let current = null;
  let newLine = 0;
  let remOld = 0;
  let remNew = 0;

  const finalize = () => {
    if (block && !block.deleted) {
      const p = block.newPath ?? block.headerPath;
      if (p && !hunks.has(p)) hunks.set(p, new Set());
    }
  };

  for (let raw of lines) {
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    if (remOld > 0 || remNew > 0) {
      const ch = raw[0];
      if (ch === "\\") continue;
      if (ch === " " || raw === "") {
        current?.add(newLine);
        newLine++;
        remOld--;
        remNew--;
        continue;
      }
      if (ch === "+") {
        current?.add(newLine);
        newLine++;
        remNew--;
        continue;
      }
      if (ch === "-") {
        remOld--;
        continue;
      }
      // Malformed counts: end the hunk and read this line as a header.
      remOld = 0;
      remNew = 0;
    }
    if (raw.startsWith("diff --git ")) {
      finalize();
      block = {
        headerPath: parseGitHeaderPath(raw.slice("diff --git ".length)),
        newPath: null,
        deleted: false,
      };
      current = null;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      block ??= { headerPath: null, newPath: null, deleted: false };
      const p = parseDiffPath(raw.slice(4), "b/");
      if (p === null) block.deleted = true;
      else block.newPath = p;
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("deleted file mode")) {
      if (block) block.deleted = true;
      continue;
    }
    if (raw.startsWith("rename to ")) {
      if (block) block.newPath = unquotePath(raw.slice("rename to ".length));
      continue;
    }
    const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (h && block && !block.deleted) {
      const p = block.newPath ?? block.headerPath;
      if (!p) continue;
      if (!hunks.has(p)) hunks.set(p, new Set());
      current = hunks.get(p);
      remOld = h[1] === undefined ? 1 : Number(h[1]);
      newLine = Number(h[2]);
      remNew = h[3] === undefined ? 1 : Number(h[3]);
    }
  }
  finalize();
  return hunks;
}

function parseDiffPath(text, prefix) {
  let t = text.replace(/\t$/, "");
  if (t === "/dev/null") return null;
  t = unquotePath(t);
  return t.startsWith(prefix) ? t.slice(prefix.length) : t;
}

// `diff --git a/P b/P`: only trusted when unquoted and both halves agree (a
// path containing " b/" would otherwise be ambiguous). It is the fallback for
// blocks with no `+++` line — binary files and pure renames/mode changes.
function parseGitHeaderPath(rest) {
  if (rest.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(rest);
    if (!m) return null;
    const b = unquotePath(`"${m[2]}"`);
    return b.startsWith("b/") ? b.slice(2) : b;
  }
  const len = (rest.length - 5) / 2;
  if (!Number.isInteger(len) || len <= 0) return null;
  const a = rest.slice(2, 2 + len);
  if (rest.slice(0, 2) !== "a/" || rest.slice(2 + len, 5 + len) !== " b/") return null;
  return rest.slice(5 + len) === a ? a : null;
}

// git C-quotes paths with special or non-ASCII bytes: "a/caf\303\251.md".
function unquotePath(p) {
  if (!(p.length >= 2 && p.startsWith('"') && p.endsWith('"'))) return p;
  const bytes = [];
  const body = p.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[i + 1];
    if (/[0-7]/.test(next ?? "")) {
      const oct = body.slice(i + 1, i + 4);
      bytes.push(parseInt(oct, 8));
      i += 3;
      continue;
    }
    const map = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
    bytes.push(map[next] ?? next.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

// ── fingerprint + sanitising ────────────────────────────────────────────────

// The fingerprint names a finding's WORDING, so a renumbered file doesn't
// re-raise it. Only the leading location phrase ("In @path at line N," /
// "In @path around lines A - B,") moves with renumbering, so only it is dropped
// before hashing. Digits elsewhere are content — "retry 3 times" and "retry 5
// times" are different advice. Two findings with the same wording at different
// lines share a fingerprint; planFindings tells those apart by line.
export function fingerprint(finding) {
  const raw = stripBoilerplate(finding?.codegenInstructions || finding?.comment || "");
  const text = stripLocationPhrase(raw, finding?.fileName)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return createHash("sha1")
    .update(`${String(finding?.fileName ?? "")}\n${text}`)
    .digest("hex")
    .slice(0, 16);
}

const LOCATION_TAIL = String.raw`(?:\s+(?:at|around|on|near|in)\s+lines?\s+\d+(?:\s*(?:-|–|—|to)\s*\d+)?)?\s*[,:]\s*`;
const BARE_LOCATION_RE =
  /^(?:at|around|on|near|in)\s+lines?\s+\d+(?:\s*(?:-|–|—|to)\s*\d+)?\s*[,:]\s*/i;

function stripLocationPhrase(text, fileName) {
  const name = String(fileName ?? "");
  // The finding's own fileName first: a path containing a comma would end the
  // generic `@\S+?` early and leave the line number in the hashed text.
  const patterns = name ? [new RegExp(`^in\\s+@${escapeRegExp(name)}${LOCATION_TAIL}`, "i")] : [];
  patterns.push(new RegExp(`^in\\s+@\\S+?${LOCATION_TAIL}`, "i"), BARE_LOCATION_RE);
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return text.slice(m[0].length);
  }
  return text;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ZWSP = "\u200b";

// Vendor text is posted under the repo owner's identity on a public PR, and is
// later read back by the fix loop. So it must not be able to:
//   - forge a factory marker (every `<!-- … -->` is stripped, including ones an
//     earlier strip would reassemble, and bare marker tokens are broken);
//   - ping anyone (@mentions outside code get a zero-width space);
//   - offer a one-click "commit suggestion" as the owner (suggestion → diff);
//   - flood the thread (length cap, keeping code fences balanced).
export function sanitizeVendorText(text, { max = 4000 } = {}) {
  let t = String(text ?? "");
  let prev;
  do {
    prev = t;
    t = t.replace(/<!--[\s\S]*?-->/g, "");
  } while (t !== prev);
  t = t.replace(/<!--[\s\S]*$/, "");
  t = t.replace(/^([ \t]*)(`{3,}|~{3,})[ \t]*suggestion\b/gim, "$1$2diff");
  t = t.replace(/drafto-factory-/gi, (m) => `${m.slice(0, -1)}${ZWSP}-`);
  t = t.replace(/\bfp=/g, `fp${ZWSP}=`);
  t = outsideCode(t, (s) =>
    s.replace(/(^|[^\w`@])@([A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9._-]+)?)/g, `$1@${ZWSP}$2`),
  );
  if (t.length > max) {
    t = t.slice(0, max);
    if (((t.match(/^[ \t]*(?:`{3,}|~{3,})/gm) ?? []).length & 1) === 1) t += "\n```";
    t += "\n…(truncated)";
  }
  return t;
}

// Every @ GitHub could read as a mention — after the start or any non-word
// character, a backtick included — gets a zero-width space, code or not. For a
// single-line summary bullet, where no fenced block can exist and a stray
// backtick run decides what GitHub treats as code, telling code from prose is
// exactly the guess that let a mention through.
function neutralizeMentions(text) {
  return String(text ?? "").replace(
    /(^|\W)@([A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9._-]+)?)/g,
    `$1@${ZWSP}$2`,
  );
}

// Apply fn only to prose: fenced blocks and inline code spans pass through, so
// a package name like `@supabase/supabase-js` in a snippet stays copy-pasteable
// (GitHub doesn't notify for mentions inside code anyway).
function outsideCode(text, fn) {
  const re = /(^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\2[ \t]*$|(?![\s\S])))|(`[^`\n]*`)/gm;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(text.slice(last));
}

// ── planning + rendering ────────────────────────────────────────────────────

const SUMMARY_WHY = {
  severity: "below the thread threshold",
  "out-of-diff": "file not in the PR diff",
  "near-existing-thread": "within 3 lines of an existing review thread",
  "thread-cap": "thread cap reached",
  "summary-only": "head moved on while the review ran",
  "post-rejected": "GitHub rejected the review comment",
};

// An earlier thread carrying a finding's fingerprint answers it only this close
// to the finding's line; the same wording further away is another instance.
const FP_LINE_WINDOW = 20;

// Decide, per finding, whether it opens an inline thread or is only listed in
// the summary. `mode` is "full" | "incremental" | "summary-only" — the last for
// a run whose line numbers no longer match the PR head (it moved on while the
// review ran).
//
// `diffUnavailable`: GitHub would not return the PR diff (it refuses past
// 20,000 lines or 300 files, which no retry fixes), so no line can be checked
// against a hunk. A finding serious enough for a thread then opens a FILE-level
// thread — those need no hunk, and the prose still names the line — instead of
// hiding in the collapsed summary where nothing acts on it.
//
// `partial` is true when a finding serious enough for a thread was left in the
// summary only because the thread cap was reached: the review's coverage is
// then incomplete and the In Test hand-off has to say so.
//
// existingComments are the PR's review comments as {path, line, original_line,
// body, trusted, resolved, outdated}. The caller joins each to its review
// thread, so `line` is the thread's CURRENT line and resolved/outdated are the
// thread's flags — null when the thread state could not be read.
//   - The fp= de-dup reads every trusted comment, resolved and outdated ones
//     included: a finding the fix loop already answered stays answered. It only
//     matches near the same code (FP_LINE_WINDOW): the existing comment's line
//     is its thread's current line, else original_line, else the line its own
//     prose names; with no line on either side it matches on the fp alone.
//   - The near-existing-thread demotion reads only LIVE threads: unresolved, not
//     outdated, and not this run's own findings. A resolved or outdated thread
//     marks code a fix commit just rewrote — exactly where the lane's main use
//     case (reviewing --watch fix commits) finds new problems — and this run's
//     own threads are only there because an earlier attempt of this same post
//     got partway. Unknown thread state never demotes: a duplicate thread costs
//     one fix-loop reply; a finding buried in a collapsed summary costs a bug.
//   - A critical finding is never demoted for proximity.
export function planFindings({
  findings = [],
  hunks = new Map(),
  existingComments = [],
  mode = "full",
  sha,
  maxThreads = 10,
  diffUnavailable = false,
} = {}) {
  const hunkMap = hunks instanceof Map ? hunks : new Map(Object.entries(hunks ?? {}));
  const severities = mode === "incremental" ? SEVERITIES_INCREMENTAL : SEVERITIES_FULL;
  // Defence in depth: the caller already drops untrusted authors, but a comment
  // explicitly marked untrusted must never suppress or divert a finding.
  const existing = (Array.isArray(existingComments) ? existingComments : []).filter(
    (c) => c && typeof c === "object" && c.trusted !== false,
  );
  let ownRunTag = null;
  try {
    ownRunTag = `<!-- ${FINDING_MARKER} sha=${shortSha(sha)} `;
  } catch {
    ownRunTag = null; // no usable sha: nothing can be recognised as this run's
  }
  const liveThreads = existing.filter(
    (c) =>
      c.resolved === false &&
      c.outdated === false &&
      !(ownRunTag && String(c.body ?? "").includes(ownRunTag)),
  );
  const seen = new Set();
  const inline = [];
  const summary = [];
  let partial = false;

  const sorted = (findings ?? [])
    .map((f, idx) => ({ f, idx, loc: extractLine(f) }))
    .sort(
      (a, b) =>
        rank(a.f.severity) - rank(b.f.severity) ||
        String(a.f.fileName ?? "").localeCompare(String(b.f.fileName ?? "")) ||
        (a.loc?.line ?? Infinity) - (b.loc?.line ?? Infinity) ||
        a.idx - b.idx,
    );

  for (const { f, loc } of sorted) {
    const fp = fingerprint(f);
    // Reported twice in this run, or already posted on an earlier one: the
    // thread, and whatever answer the fix loop gave it, stands. Re-raising it
    // would loop. The same wording at another line (one nit on two imports) is
    // a separate finding, so the run-local key includes the line.
    const key = `${fp}:${loc?.line ?? ""}`;
    if (seen.has(key) || existing.some((c) => answersFinding(c, fp, loc, ownRunTag))) continue;
    seen.add(key);
    const severity = String(f.severity ?? "").toLowerCase();
    const path = String(f.fileName ?? "");
    const toSummary = (why) =>
      summary.push({
        fileName: path,
        severity,
        text: sanitizeVendorText(stripBoilerplate(f.codegenInstructions || f.comment || ""), {
          max: 600,
        }),
        fp,
        why,
      });

    if (mode === "summary-only") {
      toSummary("summary-only");
      continue;
    }
    if (!severities.includes(severity)) {
      toSummary("severity");
      continue;
    }
    let anchor = null;
    if (!diffUnavailable) {
      if (!hunkMap.has(path)) {
        toSummary("out-of-diff");
        continue;
      }
      anchor = pickAnchor(loc, hunkMap.get(path));
    }
    // original_line is never consulted here: it is where the thread sat on an
    // older commit, not where that code is now.
    const near =
      severity !== "critical" &&
      liveThreads.some((c) => {
        if (c.path !== path) return false;
        const line = Number.isInteger(c.line) ? c.line : null;
        // A file-level finding defers only to a file-level thread, and vice versa.
        if (anchor == null) return line == null;
        return line != null && Math.abs(line - anchor) <= 3;
      });
    if (near) {
      toSummary("near-existing-thread");
      continue;
    }
    if (inline.length >= maxThreads) {
      toSummary("thread-cap");
      partial = true;
      continue;
    }
    inline.push({
      path,
      line: anchor,
      subjectType: anchor == null ? "file" : "line",
      body: renderInline(f, { sha, fp }),
      fp,
      severity,
    });
  }
  return { inline, summary, partial };
}

function answersFinding(comment, fp, loc, ownRunTag = null) {
  const body = String(comment?.body ?? "");
  if (!body.includes(`fp=${fp}`)) return false;
  if (!loc) return true;
  const line = existingCommentLine(comment);
  // No thread line, no original_line and no line in its prose: nothing to tell
  // the two apart by, so the fp alone decides, as it does for a lineless finding.
  if (line == null) return true;
  // This run's own comment (a retry after a partial post): the ±20 window is for
  // code that moved between runs, but within one run nothing moved, so only the
  // exact line is the same finding. Otherwise a same-worded sibling a few lines
  // away that failed to post the first time would be dropped on the retry.
  if (ownRunTag && body.includes(ownRunTag)) return line === loc.line;
  return Math.abs(line - loc.line) <= FP_LINE_WINDOW;
}

// A file-level thread (the diff-unavailable fallback, or a 422 retry) has no
// line of its own on either side, but its body is the vendor prose, which names
// one — without it every re-run of a post would re-open those threads.
function existingCommentLine(comment) {
  if (Number.isInteger(comment.line)) return comment.line;
  if (Number.isInteger(comment.original_line)) return comment.original_line;
  return extractLine({ comment: String(comment.body ?? "") })?.line ?? null;
}

function rank(severity) {
  return SEVERITY_RANK[String(severity ?? "").toLowerCase()] ?? 6;
}

// GitHub anchors a range comment on its LAST line, so prefer that; fall back to
// the first line, then any line of the range that is inside a hunk.
function pickAnchor(loc, rightLines) {
  if (!loc || !(rightLines instanceof Set)) return null;
  if (rightLines.has(loc.line)) return loc.line;
  if (loc.startLine != null) {
    if (rightLines.has(loc.startLine)) return loc.startLine;
    for (let l = loc.startLine; l <= loc.line; l++) if (rightLines.has(l)) return l;
  }
  return null;
}

const INLINE_FOOTER =
  "<sub>Automated, unverified vendor finding (CodeRabbit CLI, posted by the Drafto factory). Reply with fixed / no change needed, then resolve.</sub>";

export function renderInline(finding, { sha, fp } = {}) {
  const sha12 = shortSha(sha);
  const print = /^[0-9a-f]{16}$/.test(String(fp ?? "")) ? fp : fingerprint(finding);
  const severity = /^[a-z]+$/.test(String(finding?.severity ?? "")) ? finding.severity : "unknown";
  const parts = [stripBoilerplate(finding?.codegenInstructions || finding?.comment || "")];
  for (const suggestion of Array.isArray(finding?.suggestions) ? finding.suggestions : []) {
    const code = String(suggestion ?? "");
    if (!code.trim()) continue;
    const longest = Math.max(2, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    parts.push(`${fence}\n${code}\n${fence}`);
  }
  // Mentions are neutralized across the WHOLE vendor text, code included. The
  // fence detection in sanitizeVendorText approximates CommonMark (longer
  // closers, 4-space indents, unclosed or backtick-info fences all fool it), and
  // a missed case pings a real user from the owner's account. A ZWSP inside a
  // snippet is the cheaper failure.
  const vendor = neutralizeMentions(sanitizeVendorText(parts.join("\n\n")));
  return [
    // The header stands alone so a fence opening the vendor text starts its own
    // line, and GitHub renders it as the block it looks like.
    `**[CodeRabbit CLI · ${severity}]**\n\n${vendor}`,
    INLINE_FOOTER,
    `<!-- ${FINDING_MARKER} sha=${sha12} fp=${print} -->`,
  ].join("\n\n");
}

export function renderSummary({
  sha,
  baseSha = null,
  mode = "full",
  outcome = "ok",
  inline = [],
  summary = [],
  stale = false,
  // The coverage kind this run is recorded as. It goes in the marker because the
  // prose cannot carry it: a run is "cli-partial" when the vendor reported more
  // findings than survived parsing, and that fact appears nowhere in the rendered
  // text. Anything reading coverage back off the PR (a PR with no factory card
  // has only the PR) would otherwise have to guess, and guess wrong.
  kind = null,
} = {}) {
  const head = String(sha ?? "").toLowerCase();
  if (!SHA40.test(head)) throw new Error("renderSummary: sha must be a 40-hex commit");
  const inlineCount = Array.isArray(inline) ? inline.length : Number(inline) || 0;
  const items = Array.isArray(summary) ? summary : [];
  const range =
    mode === "incremental" && baseSha
      ? `the changes in \`${shortSha(baseSha)}..${shortSha(head)}\` (incremental)`
      : `the full PR diff at \`${shortSha(head)}\`${baseSha ? ` (base \`${shortSha(baseSha)}\`)` : ""}`;

  const lines = [`### CodeRabbit CLI review — \`${shortSha(head)}\``, ""];
  lines.push(
    `The CodeRabbit PR bot did not review this commit, so the factory ran the CodeRabbit CLI on ${range}. Outcome: \`${String(outcome).replace(/[^a-z_-]/gi, "")}\`.`,
  );
  lines.push("");
  if (stale) {
    lines.push(
      "> The PR head moved on while this review ran, so no threads were opened; the findings are listed here for reference only.",
    );
  } else {
    lines.push(`Opened ${inlineCount} inline thread${inlineCount === 1 ? "" : "s"}.`);
  }
  if (items.length) {
    const shown = items.slice(0, 30);
    lines.push(
      "",
      `<details><summary>${items.length} finding${items.length === 1 ? "" : "s"} not opened as threads</summary>`,
      "",
    );
    for (const item of shown) {
      const sev = /^[a-z]+$/.test(String(item?.severity ?? "")) ? item.severity : "unknown";
      // A backtick or line break in the name would end the code span early.
      const file = String(item?.fileName ?? "").replace(/[\p{Cc}\p{Zl}\p{Zp}`]/gu, "");
      const why = SUMMARY_WHY[item?.why] ?? String(item?.why ?? "").replace(/[^\w -]/g, "");
      const text = neutralizeMentions(
        sanitizeVendorText(oneLine(item?.text), { max: 600 }).replace(/\s*\n\s*/g, " "),
      );
      lines.push(`- **${sev}** \`${file}\` — ${text} _(${why})_`);
    }
    if (items.length > shown.length) lines.push(`- …and ${items.length - shown.length} more`);
    lines.push("", "</details>");
  }
  lines.push(
    "",
    "<sub>Automated, unverified vendor findings (CodeRabbit CLI, posted by the Drafto factory).</sub>",
    "",
    `<!-- ${SUMMARY_MARKER} sha=${head}${/^[a-z-]+$/.test(String(kind ?? "")) ? ` kind=${kind}` : ""} -->`,
  );
  return lines.join("\n");
}

function shortSha(sha) {
  const s = String(sha ?? "").toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(s)) throw new Error(`invalid commit sha: ${JSON.stringify(sha)}`);
  return s.slice(0, 12);
}

// ── fix-loop attempt exemption ──────────────────────────────────────────────

// A thread counts as a CLI finding only if the repo owner's identity (the Mac
// mini's gh login) opened it AND it carries the finding marker. The author check
// is what stops a public commenter pasting the marker to dodge the retry budget.
export function isCliFindingThread(thread, ownerLogin) {
  const first = thread?.comments?.[0];
  if (!ownerLogin || !first) return false;
  return (
    first?.author?.login === ownerLogin &&
    String(first?.body ?? "").includes(`<!-- ${FINDING_MARKER} `)
  );
}

// One free fix pass per CLI run: the pass answering a CLI run's threads doesn't
// spend a retry attempt, but a second pass on the same run's threads does, so
// ADR-0035's "a thread loop can't run forever" bound still holds.
export function decideFreePass({ threads = [], issue = {}, ownerLogin } = {}) {
  const list = Array.isArray(threads) ? threads : [];
  const exempt =
    list.length > 0 &&
    list.every((t) => isCliFindingThread(t, ownerLogin)) &&
    Boolean(issue?.crLastCoveredSha) &&
    issue?.crCliFreePassSha !== issue?.crLastCoveredSha;
  return { exempt };
}
