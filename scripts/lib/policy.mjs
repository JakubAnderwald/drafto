// Pure-function policy layer. No IO. Easy to unit test.
//
// Responsibilities:
//   - Decide whether an inbound envelope is auto-reply-safe (loop avoidance).
//   - Enforce auto-reply rate limits (per-thread/24h, per-sender/1h, daily global).
//   - Detect "human intervened" — the OAuth user replied via Zoho webmail/mobile
//     (i.e. you stepped in manually), so the agent must back off.
//   - Gate admin-notification emails behind a 24h-per-thread cooldown.
//   - Test allowlist membership.

export const THREAD_24H_CAP = 3;
export const SENDER_1H_CAP = 5;
export const DAILY_GLOBAL_CAP = 100;
export const ADMIN_NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const THREAD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SENDER_WINDOW_MS = 60 * 60 * 1000;

const LOOP_HEADER_PATTERNS = {
  // RFC 3834: any value other than "no" means it's auto-submitted.
  autoSubmitted: (v) => typeof v === "string" && v.trim().toLowerCase() !== "no",
  // RFC 2076-ish: bulk/junk/list precedence ⇒ don't auto-reply.
  precedence: (v) => /^(bulk|junk|list)$/i.test((v ?? "").trim()),
};

const NOREPLY_LOCALPART = /^(no.?reply|mailer-daemon|postmaster)$/i;

export function isAutoReplyableEnvelope(headers) {
  if (!headers || typeof headers !== "object") return { ok: true, reason: null };
  const get = (name) => {
    const k = Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase());
    return k ? headers[k] : undefined;
  };

  if (LOOP_HEADER_PATTERNS.autoSubmitted(get("Auto-Submitted"))) {
    return { ok: false, reason: "Auto-Submitted header present" };
  }
  if (LOOP_HEADER_PATTERNS.precedence(get("Precedence"))) {
    return { ok: false, reason: `Precedence: ${get("Precedence")}` };
  }
  // DSN — delivery status notification. Two common signals:
  if (get("X-Failed-Recipients")) {
    return { ok: false, reason: "DSN: X-Failed-Recipients present" };
  }
  const ct = get("Content-Type") ?? "";
  if (/multipart\/report/i.test(ct) && /report-type=\s*"?delivery-status/i.test(ct)) {
    return { ok: false, reason: "DSN: multipart/report; report-type=delivery-status" };
  }
  return { ok: true, reason: null };
}

export function isBlockedSenderAddress(email) {
  if (typeof email !== "string") return true;
  const local = email.split("@")[0] ?? "";
  return NOREPLY_LOCALPART.test(local);
}

export function checkRateLimit(state, threadId, sender, nowIso = new Date().toISOString()) {
  const now = Date.parse(nowIso);
  const senderLower = (sender ?? "").toLowerCase();

  const threadEntry = state.threads?.[threadId];
  const threadHits = (threadEntry?.autoReplies ?? []).filter(
    (t) => now - Date.parse(t) < THREAD_WINDOW_MS,
  );
  if (threadHits.length >= THREAD_24H_CAP) {
    return { ok: false, reason: `thread cap: ${threadHits.length}/${THREAD_24H_CAP} in 24h` };
  }

  const senderEntry = state.senders?.[senderLower];
  const senderHits = (senderEntry?.autoReplies ?? []).filter(
    (t) => now - Date.parse(t) < SENDER_WINDOW_MS,
  );
  if (senderHits.length >= SENDER_1H_CAP) {
    return { ok: false, reason: `sender cap: ${senderHits.length}/${SENDER_1H_CAP} in 1h` };
  }

  const day = nowIso.slice(0, 10);
  const dailyCount = state.global?.autoRepliesByDay?.[day] ?? 0;
  if (dailyCount >= DAILY_GLOBAL_CAP) {
    return { ok: false, reason: `daily global cap: ${dailyCount}/${DAILY_GLOBAL_CAP}` };
  }

  return { ok: true, reason: null };
}

export function bumpCounters(state, threadId, sender, nowIso = new Date().toISOString()) {
  const senderLower = (sender ?? "").toLowerCase();
  const now = Date.parse(nowIso);

  state.threads ??= {};
  state.threads[threadId] ??= { autoReplies: [], lastAdminNotificationAt: null };
  state.threads[threadId].autoReplies = [
    ...(state.threads[threadId].autoReplies ?? []).filter(
      (t) => now - Date.parse(t) < THREAD_WINDOW_MS,
    ),
    nowIso,
  ];

  state.senders ??= {};
  state.senders[senderLower] ??= { autoReplies: [] };
  state.senders[senderLower].autoReplies = [
    ...(state.senders[senderLower].autoReplies ?? []).filter(
      (t) => now - Date.parse(t) < SENDER_WINDOW_MS,
    ),
    nowIso,
  ];

  const day = nowIso.slice(0, 10);
  state.global ??= { autoRepliesByDay: {} };
  state.global.autoRepliesByDay ??= {};
  state.global.autoRepliesByDay[day] = (state.global.autoRepliesByDay[day] ?? 0) + 1;
  return state;
}

// Returns true when the most recent message in the thread was sent by the
// OAuth user themselves AND the message does NOT carry the agent's
// `Auto-Submitted: auto-replied` marker. In other words: the human (you)
// replied via Zoho webmail / mobile, and the agent must back off.
export function humanIntervened({ lastMessageFrom, lastMessageAutoSubmitted }, oauthUserEmail) {
  if (!lastMessageFrom || !oauthUserEmail) return false;
  if (lastMessageFrom.toLowerCase() !== oauthUserEmail.toLowerCase()) return false;
  // If the last message claims to be auto-replied (anything other than "no"),
  // that's the agent itself — not a human intervention.
  if (LOOP_HEADER_PATTERNS.autoSubmitted(lastMessageAutoSubmitted)) return false;
  return true;
}

export function shouldNotifyAdmin(state, threadId, nowIso = new Date().toISOString()) {
  const last = state.threads?.[threadId]?.lastAdminNotificationAt;
  if (!last) return true;
  return Date.parse(nowIso) - Date.parse(last) >= ADMIN_NOTIFY_COOLDOWN_MS;
}

export function bumpNotification(state, threadId, nowIso = new Date().toISOString()) {
  state.threads ??= {};
  state.threads[threadId] ??= { autoReplies: [], lastAdminNotificationAt: null };
  state.threads[threadId].lastAdminNotificationAt = nowIso;
  return state;
}

// Top-level gate: should we fire an admin notification for this escalation?
// Combines all three suppression rules so the agent runner has a single
// boolean to check.
//   - sender in allowlist     → suppress (you sent it; you know)
//   - human intervened        → suppress (you're already in the thread)
//   - within 24h cooldown     → suppress (already nudged today)
export function shouldFireAdminNotification(
  state,
  threadId,
  {
    sender,
    allowlist,
    humanIntervened: humanIntervenedFlag,
    nowIso = new Date().toISOString(),
  } = {},
) {
  if (humanIntervenedFlag) return { ok: false, reason: "humanIntervened" };
  if (sender && isAllowlistedSender(sender, allowlist)) {
    return { ok: false, reason: "allowlisted-sender" };
  }
  if (!shouldNotifyAdmin(state, threadId, nowIso)) {
    return { ok: false, reason: "cooldown" };
  }
  return { ok: true, reason: null };
}

export function parseAllowlist(envValue) {
  if (typeof envValue !== "string") return [];
  return envValue
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowlistedSender(email, allowlist) {
  if (typeof email !== "string") return false;
  const normalized = email.toLowerCase().trim();
  const list = Array.isArray(allowlist) ? allowlist : parseAllowlist(allowlist);
  return list.includes(normalized);
}
