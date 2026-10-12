// Pure decision logic for the factory's Greptile review hold (ADR-0047).
//
// Greptile is a second AI reviewer, running as its GitHub App on Greptile's free
// open-source plan. greptile.json has it review a PR once, when the PR opens
// (`triggerOnUpdates: false`), so the question here is "has Greptile reviewed
// this PR?", not "has it reviewed this commit?". With FACTORY_GREPTILE_GATE=1,
// --watch holds a converged In Review card until it has, for at most
// FACTORY_GREPTILE_HOLD_MAX_MIN counted from when the PR opened, then promotes
// the card with a one-line note for the In Test comment.
//
// Greptile is never review coverage in the ADR-0036 sense: CodeRabbit (the PR
// bot plus the CLI gap-fill) stays the recorded signal, and nothing here feeds
// classifyBotCoverage or runCoverage. It is never a required check either. A
// silent Greptile (quota used up, OSS plan not active, app not installed) costs
// a bounded wait and a note, never a stuck card.
//
// PURE: no fs, no child_process, no network, no process.env. Every time
// comparison goes through Date.parse: GitHub writes `…:00Z` and node writes
// `…:00.000Z`, and those two sort wrongly as strings.
//
// Functions:
//   isTrustedGreptileItem(item) → boolean
//   classifyGreptileActivity({reviews, comments}) → "reviewed" | "absent"
//   readGreptileKnobs(env) → {holdMaxMin}
//   decideGreptileGate({activity, pr, prCreatedAt, knobs, now})
//        → {action: "hold"|"promote", reason, note}
//   greptileInTestNote({activity, pr, prCreatedAt, knobs, now}) → note string
//   greptileUnknownNote(pr, why) → "Greptile review status of PR #N unknown (…)"

export const GREPTILE_BOT_LOGIN = "greptile-apps[bot]";

export const DEFAULT_GREPTILE_KNOBS = Object.freeze({ holdMaxMin: 30 });

// The longest hold an override may ask for. A day is far past any real review,
// and a bigger number is far more likely a typo than a wish to park a card.
export const MAX_GREPTILE_HOLD_MIN = 1440;

const MINUTE_MS = 60_000;

// A PR "opened" further in the future than this is a garbage timestamp, not
// clock skew. Trusting it would hold the card until that date.
const MAX_CLOCK_SKEW_MS = 5 * MINUTE_MS;

// Greptile's PR summary comment opens with one of these headings ("Greptile
// Summary" on older reviews, "Greptile Overview" on newer ones). A Greptile
// comment without one (a reply to an @-mention, a quota or skip notice) is not
// a finished review.
const SUMMARY_HEADING_RE = /\bGreptile\s+(?:Summary|Overview)\b/i;

// Login alone is spoofable in GraphQL, but a REST user of type "Bot" named
// "greptile-apps[bot]" can only be the Greptile GitHub App itself — the same
// rule as coderabbit-review.mjs's isTrustedBotItem.
export function isTrustedGreptileItem(item) {
  return item?.user?.type === "Bot" && item?.user?.login === GREPTILE_BOT_LOGIN;
}

// Has the Greptile App finished a review of the PR? Either signal counts:
//   - a submitted PR review with a body (Greptile's "N files reviewed, M
//     comments" review). An empty-bodied review is a reply on a thread, and
//     PENDING is a draft only its author can see;
//   - an issue comment carrying the summary heading.
// Anything else, including activity from a user who merely shares the name,
// is "absent".
export function classifyGreptileActivity(input) {
  const { reviews = [], comments = [] } = input ?? {};
  for (const review of Array.isArray(reviews) ? reviews : []) {
    if (!isTrustedGreptileItem(review)) continue;
    if (String(review?.state ?? "").toUpperCase() === "PENDING") continue;
    if (String(review?.body ?? "").trim()) return "reviewed";
  }
  for (const comment of Array.isArray(comments) ? comments : []) {
    if (isTrustedGreptileItem(comment) && SUMMARY_HEADING_RE.test(String(comment?.body ?? ""))) {
      return "reviewed";
    }
  }
  return "absent";
}

function holdMinutes(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_GREPTILE_HOLD_MIN
    ? value
    : DEFAULT_GREPTILE_KNOBS.holdMaxMin;
}

// Read once per command. A garbage override falls back to the default rather
// than disabling the hold (0) or making it unbounded (NaN compares false, so a
// NaN deadline would never pass).
export function readGreptileKnobs(env = {}) {
  const raw = env?.FACTORY_GREPTILE_HOLD_MAX_MIN;
  return {
    holdMaxMin: holdMinutes(
      typeof raw === "string" && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN,
    ),
  };
}

function parseMs(iso) {
  if (typeof iso !== "string" || !iso.trim()) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function greptileUnknownNote(pr, why) {
  return `Greptile review status of PR #${pr} unknown (${why})`;
}

function notReviewedNote(pr, why) {
  return `Greptile did not review PR #${pr} (${why})`;
}

// First match wins:
//   1. reviewed                          → promote, no note
//   2. no usable PR open time            → promote with a note (never an unbounded hold)
//   3. inside the window, unreadable     → hold (bounded by the window)
//   4. inside the window, not reviewed   → hold
//   5. window passed                     → promote with a note
// "activity" is "reviewed" | "absent" | "unavailable" (the reviews or comments
// could not be read). Any other value is treated as "absent".
export function decideGreptileGate(input) {
  const { activity, pr, prCreatedAt, knobs, now } = input ?? {};
  if (activity === "reviewed") {
    return { action: "promote", reason: "greptile-reviewed", note: "" };
  }
  const holdMaxMin = holdMinutes(knobs?.holdMaxMin);
  const unreadable = activity === "unavailable";
  const nowMs = parseMs(now);
  const createdMs = parseMs(prCreatedAt);
  if (nowMs === null || createdMs === null || createdMs > nowMs + MAX_CLOCK_SKEW_MS) {
    return {
      action: "promote",
      reason: "greptile-no-window",
      note: unreadable
        ? greptileUnknownNote(pr, "its reviews could not be read")
        : notReviewedNote(
            pr,
            "the PR's opening time could not be read, so the factory did not wait",
          ),
    };
  }
  const inWindow = nowMs < createdMs + holdMaxMin * MINUTE_MS;
  if (unreadable) {
    return inWindow
      ? { action: "hold", reason: "greptile-unreadable", note: "" }
      : {
          action: "promote",
          reason: "greptile-unreadable-expired",
          note: greptileUnknownNote(pr, "its reviews could not be read"),
        };
  }
  return inWindow
    ? { action: "hold", reason: "greptile-wait", note: "" }
    : {
        action: "promote",
        reason: "greptile-hold-expired",
        note: notReviewedNote(pr, `no review within ${holdMaxMin} min of the PR opening`),
      };
}

// The note for an In Test scenario re-written after the promotion. The card has
// already left In Review, so there is nothing to hold: a decision that would
// hold still owes the tester a line saying Greptile hasn't reviewed yet.
export function greptileInTestNote(input) {
  const decision = decideGreptileGate(input);
  if (decision.action === "promote") return decision.note;
  const pr = input?.pr;
  return decision.reason === "greptile-unreadable"
    ? greptileUnknownNote(pr, "its reviews could not be read")
    : `Greptile has not reviewed PR #${pr} yet`;
}
