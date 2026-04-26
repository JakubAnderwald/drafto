// Persistent state for the real-time support agent.
//
// File: <repo-root>/logs/support-state.json — gitignored, perms 0600.
// Loaded once per agent run, mutated in memory by policy.mjs and the agent
// loop, written back atomically (temp file + rename) at the end.
//
// Schema:
//   {
//     issues: {
//       "<n>": {
//         lastGithubCommentSyncAt: ISO-8601,        // cursor for comment-sync
//         lastIssueStateSync:      ISO-8601,        // cursor for state-sync
//         lastKnownState: {
//           state:        "open" | "closed",
//           state_reason: null | "completed" | "not_planned" | "duplicate" | "reopened"
//         }
//       }
//     },
//     threads: {
//       "<zohoThreadId>": {
//         autoReplies:              [ISO-8601, ...],   // last 24h, for ≤3 cap
//         lastAdminNotificationAt:  ISO-8601 | null     // for 24h cooldown
//       }
//     },
//     senders: {
//       "<email-lower>": {
//         autoReplies: [ISO-8601, ...]                 // last 1h, for ≤5 cap
//       }
//     },
//     global: {
//       autoRepliesByDay: { "YYYY-MM-DD": number }     // daily global cap
//     }
//   }

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const DEFAULT_STATE_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "logs",
  "support-state.json",
);

export function emptyState() {
  return { issues: {}, threads: {}, senders: {}, global: { autoRepliesByDay: {} } };
}

export async function loadState(filePath = DEFAULT_STATE_PATH) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return mergeWithDefaults(parsed);
  } catch (err) {
    if (err.code === "ENOENT") return emptyState();
    throw err;
  }
}

export async function saveState(state, filePath = DEFAULT_STATE_PATH) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const suffix = randomBytes(6).toString("hex");
  const tmp = `${filePath}.${suffix}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

function mergeWithDefaults(parsed) {
  const base = emptyState();
  if (!parsed || typeof parsed !== "object") return base;
  return {
    issues: parsed.issues && typeof parsed.issues === "object" ? parsed.issues : base.issues,
    threads: parsed.threads && typeof parsed.threads === "object" ? parsed.threads : base.threads,
    senders: parsed.senders && typeof parsed.senders === "object" ? parsed.senders : base.senders,
    global: {
      autoRepliesByDay:
        parsed.global?.autoRepliesByDay && typeof parsed.global.autoRepliesByDay === "object"
          ? parsed.global.autoRepliesByDay
          : base.global.autoRepliesByDay,
    },
  };
}
