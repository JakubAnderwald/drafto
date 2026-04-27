#!/usr/bin/env node
// Zoho Mail CLI used by the support agent.
//
// Subcommands (all argv-driven so Claude Code can invoke them via Bash):
//   list-pending                            → JSON array of Inbox threads
//                                             (deduped by threadId) that don't
//                                             yet carry a terminal
//                                             Drafto/Support/* label.
//   get-thread <threadId>                   → array of messages in the thread,
//                                             oldest-first. Each entry carries
//                                             messageId + folderId + subject
//                                             + addresses (no headers).
//   get-headers <folderId> <messageId>      → parsed header object for one
//                                             message. Zoho's header endpoint
//                                             requires the folder id of the
//                                             message, so list-pending /
//                                             get-thread surface it.
//   reply <threadId> --body-file <path>     → posts a reply in-thread; sender is
//                                             always the OAuth user (no --from).
//   send --to <addr> --subject <s>          → sends a fresh non-reply email; sender
//        --body-file <path>                   always the OAuth user. Used for admin
//                                             notifications.
//   add-label <threadId> <labelName>        → applies a label to a thread; refuses
//                                             any name not under "Drafto/Support/".
//                                             Creates the label lazily if it
//                                             doesn't exist yet.
//   add-message-label <messageId> <label>   → same as add-label but targets a
//                                             single message (used for inbound
//                                             singletons that Zoho hasn't yet
//                                             assigned a threadId to).
//   move-to-folder <threadId> <folder>      → moves a thread to a folder; refuses
//                                             any name not under "Drafto/Support/".
//                                             Creates the folder lazily.
//
// Auth: refresh-token-based via zoho-auth.mjs. On INVALID_OAUTHTOKEN the CLI
// invalidates the cached access_token and retries the request exactly once.
//
// All subcommands print JSON to stdout and exit 0 on success. On failure they
// print a single-line JSON {"error": "..."} to stderr and exit non-zero.
//
// Endpoint paths reflect Zoho's documented Mail REST API as verified live
// against account 8620967000000002002 in April 2026. Keep the paths in
// ZOHO_API_PATHS centralised so they can be changed in one place.

import { promises as fs } from "node:fs";
import { loadConfig, getAccessToken, invalidateAccessToken, _resetForTests } from "./zoho-auth.mjs";

const SUPPORT_NAMESPACE = "Drafto/Support/";

// Closed allowlist of permitted label *suffixes* under the support
// namespace. Without this, an LLM call could invent new labels (e.g.
// "Drafto/Support/Stuck") that pass the namespace prefix check but fragment
// the state machine. Phase F will add `Linked-Issue/<n>` here once we settle
// on its 25-char-limit-friendly form.
const SUPPORT_LABEL_SUFFIXES = new Set([
  "Seen", // Phase C: agent has acknowledged the thread (label-only mode).
  "NeedsHuman", // Phase D: escalated; awaits human review. (25 chars — Zoho cap.)
  "Spam", // Phase D: classified spam; thread moves to Spam folder too.
  "Resolved", // Phase E onward: agent finished with the thread (Resolved folder).
  "Replied", // Phase E onward: agent posted an auto-reply.
]);
// Folders are looser — Phase D only uses Spam, Phase E+ uses Resolved.
const SUPPORT_FOLDER_SUFFIXES = new Set(["Spam", "Resolved"]);

// Centralised endpoint paths. Templated with ${accountId}, ${messageId}, etc.
// at call time. Documented against zoho.com/mail/help/api/ as of Apr 2026.
//
// Thread label changes go through `PUT /updatethread` with mode=applyLabel
// (https://www.zoho.com/mail/help/api/put-label-thread.html). Folder moves go
// through `PUT /updatemessage` with `destfolderId` — `/updatethread`'s
// `folderId` is documented as the SOURCE folder, not the destination, so we
// use `/updatemessage` (which accepts a thread ID via `threadId`) for moves
// (https://www.zoho.com/mail/help/api/put-move-message.html).
const ZOHO_API_PATHS = {
  folders: (accountId) => `/api/accounts/${accountId}/folders`,
  labels: (accountId) => `/api/accounts/${accountId}/labels`,
  // Both Inbox listing and per-thread message listing go through the same
  // endpoint, parameterised by query string (folderId vs threadId). Returns
  // {data: [{messageId, threadId, folderId, subject, fromAddress, ...}]}.
  messagesView: (accountId) => `/api/accounts/${accountId}/messages/view`,
  // The header endpoint is folder-scoped, not message-id-scoped. Hitting the
  // unscoped variant returns 404 URL_RULE_NOT_CONFIGURED. The response is
  // {data: {headerContent: "<CRLF-delimited raw headers>"}}.
  messageHeader: (accountId, folderId, messageId) =>
    `/api/accounts/${accountId}/folders/${encodeURIComponent(folderId)}/messages/${encodeURIComponent(messageId)}/header`,
  sendOrReply: (accountId) => `/api/accounts/${accountId}/messages`,
  updateThread: (accountId) => `/api/accounts/${accountId}/updatethread`,
  updateMessage: (accountId) => `/api/accounts/${accountId}/updatemessage`,
};

let fetchImpl = globalThis.fetch;
let _foldersByName = null;
let _labelsByName = null;

export function _setFetchForTests(impl) {
  fetchImpl = impl ?? globalThis.fetch;
  _resetForTests({ fetchImpl: impl });
  _foldersByName = null;
  _labelsByName = null;
}

async function zohoApi(method, urlPath, { query, body, _retry = false } = {}) {
  const cfg = await loadConfig();
  const url = new URL(`https://${cfg.mailHost}${urlPath}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const token = await getAccessToken();
  const res = await fetchImpl(url.toString(), {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !_retry) {
    invalidateAccessToken();
    return zohoApi(method, urlPath, { query, body, _retry: true });
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { _raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      `Zoho ${method} ${urlPath} failed: ${res.status} ${parsed?.data?.errorCode ?? parsed?.status?.code ?? ""}`,
    );
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

// ── Discovery helpers (cached per process) ──────────────────────────────────

async function listFolders() {
  if (_foldersByName) return _foldersByName;
  const cfg = await loadConfig();
  const res = await zohoApi("GET", ZOHO_API_PATHS.folders(cfg.accountId));
  const arr = res.data ?? res.folders ?? [];
  _foldersByName = new Map();
  for (const f of arr) {
    const name = f.folderName ?? f.name;
    if (name) _foldersByName.set(name, f);
  }
  return _foldersByName;
}

async function listLabels() {
  if (_labelsByName) return _labelsByName;
  const cfg = await loadConfig();
  const res = await zohoApi("GET", ZOHO_API_PATHS.labels(cfg.accountId));
  const arr = res.data ?? res.labels ?? [];
  _labelsByName = new Map();
  for (const l of arr) {
    // Zoho's POST/GET use `displayName` for the label's human-readable name.
    // Older docs / mocks may surface `labelName` or `name`; accept any.
    const name = l.displayName ?? l.labelName ?? l.name;
    if (name) _labelsByName.set(name, l);
  }
  return _labelsByName;
}

// Inverse of listLabels — used when filtering messages by label, since
// /messages/view returns labels as a flat `labelId: ["<id>", ...]` array.
async function listLabelsById() {
  const byName = await listLabels();
  const byId = new Map();
  for (const label of byName.values()) {
    const id = label.labelId ?? label.tagId ?? label.id;
    const name = label.displayName ?? label.labelName ?? label.name;
    if (id !== undefined && id !== null && name) byId.set(String(id), name);
  }
  return byId;
}

async function ensureLabel(name) {
  const labels = await listLabels();
  if (labels.has(name)) return labels.get(name);
  const cfg = await loadConfig();
  // POST /labels expects `displayName` (Zoho calls them "tags" internally;
  // posting `labelName` returns 404 EXTRA_KEY_FOUND_IN_JSON).
  // https://www.zoho.com/mail/help/api/post-create-new-label.html
  const created = await zohoApi("POST", ZOHO_API_PATHS.labels(cfg.accountId), {
    body: { displayName: name },
  });
  const obj = created.data ?? created;
  labels.set(name, obj);
  return obj;
}

async function ensureFolder(name) {
  const folders = await listFolders();
  if (folders.has(name)) return folders.get(name);
  const cfg = await loadConfig();
  const created = await zohoApi("POST", ZOHO_API_PATHS.folders(cfg.accountId), {
    body: { folderName: name },
  });
  const obj = created.data ?? created;
  folders.set(name, obj);
  return obj;
}

// ── Subcommands ─────────────────────────────────────────────────────────────

function isTerminalSupportLabel(labelName) {
  if (typeof labelName !== "string") return false;
  if (!labelName.startsWith(SUPPORT_NAMESPACE)) return false;
  // Inbox + NeedsHuman stays "pending" from the agent's POV.
  // Note: Zoho enforces a 25-char displayName max, so the label is
  // `Drafto/Support/NeedsHuman` (25) without the hyphen — see PR #344
  // discussion for the live ENOLABEL repro.
  return labelName !== `${SUPPORT_NAMESPACE}NeedsHuman`;
}

function messageHasTerminalLabel(msg, idToName) {
  // Real Zoho /messages/view surface: a flat `labelId: ["<id>", ...]` array.
  // Resolve IDs via the labels cache.
  const ids = Array.isArray(msg.labelId) ? msg.labelId : [];
  for (const id of ids) {
    const name = idToName.get(String(id));
    if (name && isTerminalSupportLabel(name)) return true;
  }
  // Fallback for tests / endpoint variants that return label objects inline.
  const objs = msg.labels ?? msg.labelInfo ?? [];
  return objs.some((l) => isTerminalSupportLabel(l.displayName ?? l.labelName ?? l.name ?? l));
}

export async function listPending() {
  const cfg = await loadConfig();
  const folders = await listFolders();
  const inbox = folders.get("Inbox");
  if (!inbox) throw new Error('Could not locate Zoho "Inbox" folder');
  const inboxId = inbox.folderId ?? inbox.id;
  const idToName = await listLabelsById();
  const res = await zohoApi("GET", ZOHO_API_PATHS.messagesView(cfg.accountId), {
    query: { folderId: inboxId, includeto: "true", limit: 200 },
  });
  const arr = res.data ?? res.messages ?? [];
  // Inbox listing returns one entry per *message*; two messages in the same
  // thread share a threadId and would otherwise be processed twice in one
  // run. Filter terminal labels first, then dedupe by threadId (falling back
  // to messageId when a message is not threaded), keeping the first
  // occurrence — Zoho returns newest-first so that's the most recent message.
  const filtered = arr.filter((m) => !messageHasTerminalLabel(m, idToName));
  const seen = new Set();
  const deduped = [];
  for (const m of filtered) {
    const key = m.threadId ?? m.messageId ?? m.id;
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
  }
  return deduped;
}

export async function getThread(threadId) {
  if (!threadId) throw new Error("threadId required");
  const cfg = await loadConfig();
  // /messages/view?threadId=<id> returns {data: [<msg>, ...]} — one entry per
  // message in the thread. The earlier /messages/{id}/details path tried
  // during Phase A returned 404 URL_RULE_NOT_CONFIGURED.
  const res = await zohoApi("GET", ZOHO_API_PATHS.messagesView(cfg.accountId), {
    query: { threadId, includeto: "true", limit: 200 },
  });
  return res.data ?? res.messages ?? [];
}

export async function getHeaders(folderId, messageId) {
  if (!folderId) throw new Error("folderId required");
  if (!messageId) throw new Error("messageId required");
  const cfg = await loadConfig();
  const res = await zohoApi(
    "GET",
    ZOHO_API_PATHS.messageHeader(cfg.accountId, folderId, messageId),
  );
  // Zoho returns headers as a CRLF-delimited string under data.headerContent.
  const headerContent = res.data?.headerContent ?? res.headerContent;
  if (typeof headerContent === "string") return parseRawHeaders(headerContent);
  // Defensive fallback: if the shape ever shifts (or in tests with a stub),
  // treat a string `data` as raw headers and an object `data` as already
  // parsed.
  const raw = res.data ?? res;
  if (typeof raw === "string") return parseRawHeaders(raw);
  return raw;
}

function parseRawHeaders(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    out[name] = out[name] ? `${out[name]}, ${value}` : value;
  }
  return out;
}

export async function replyToThread(threadId, bodyFile) {
  if (!threadId) throw new Error("threadId required");
  if (!bodyFile) throw new Error("--body-file required");
  const body = await fs.readFile(bodyFile, "utf8");
  const cfg = await loadConfig();
  // The OAuth user is always the sender — no --from flag is supported.
  // Threading: Zoho will preserve the conversation if we target a threadId.
  const payload = {
    fromAddress: cfg.primaryEmail,
    threadId,
    content: body,
    mailFormat: "plaintext",
    headers: { "Auto-Submitted": "auto-replied" },
    askReceipt: "no",
  };
  const res = await zohoApi("POST", ZOHO_API_PATHS.sendOrReply(cfg.accountId), { body: payload });
  return res.data ?? res;
}

export async function sendFresh({ to, subject, bodyFile }) {
  if (!to) throw new Error("--to required");
  if (!subject) throw new Error("--subject required");
  if (!bodyFile) throw new Error("--body-file required");
  const body = await fs.readFile(bodyFile, "utf8");
  const cfg = await loadConfig();
  const payload = {
    fromAddress: cfg.primaryEmail,
    toAddress: to,
    subject,
    content: body,
    mailFormat: "plaintext",
    headers: { "Auto-Submitted": "auto-generated" },
    askReceipt: "no",
  };
  const res = await zohoApi("POST", ZOHO_API_PATHS.sendOrReply(cfg.accountId), { body: payload });
  return res.data ?? res;
}

function assertSupportNamespace(name, kind) {
  if (
    typeof name !== "string" ||
    !name.startsWith(SUPPORT_NAMESPACE) ||
    name.length === SUPPORT_NAMESPACE.length ||
    name.includes("//") ||
    /[\x00-\x1f\x7f]/.test(name)
  ) {
    throw new Error(`${kind} must start with "${SUPPORT_NAMESPACE}" (got "${name}")`);
  }
  // Closed allowlist on the suffix — refuses arbitrary labels even if they
  // satisfy the prefix. The first live Phase D run produced an unintended
  // `Drafto/Support/Stuck` label because the prompt's documented label was
  // 26 chars (over Zoho's 25-char limit) and the agent improvised; this
  // guard makes that invisible drift impossible.
  const suffix = name.slice(SUPPORT_NAMESPACE.length);
  const allowlist = kind === "folder" ? SUPPORT_FOLDER_SUFFIXES : SUPPORT_LABEL_SUFFIXES;
  if (!allowlist.has(suffix)) {
    const allowed = [...allowlist].sort().join(", ");
    throw new Error(`${kind} suffix "${suffix}" not in allowlist (permitted: ${allowed})`);
  }
}

export async function addLabel(threadId, labelName) {
  if (!threadId) throw new Error("threadId required");
  assertSupportNamespace(labelName, "label");
  const cfg = await loadConfig();
  const label = await ensureLabel(labelName);
  const labelId = label.labelId ?? label.id;
  // PUT /updatethread, mode=applyLabel, with threadId/labelId as arrays. See:
  // https://www.zoho.com/mail/help/api/put-label-thread.html
  const res = await zohoApi("PUT", ZOHO_API_PATHS.updateThread(cfg.accountId), {
    body: { mode: "applyLabel", threadId: [threadId], labelId: [labelId] },
  });
  return res.data ?? res;
}

// Zoho assigns a threadId only after a message has at least one reply; until
// then a single inbound message has only a messageId. To prevent an unreplied
// singleton from re-appearing in list-pending every poll, we label it via
// /updatemessage instead of /updatethread.
export async function addMessageLabel(messageId, labelName) {
  if (!messageId) throw new Error("messageId required");
  assertSupportNamespace(labelName, "label");
  const cfg = await loadConfig();
  const label = await ensureLabel(labelName);
  const labelId = label.labelId ?? label.id;
  const res = await zohoApi("PUT", ZOHO_API_PATHS.updateMessage(cfg.accountId), {
    body: { mode: "applyLabel", messageId: [messageId], labelId: [labelId] },
  });
  return res.data ?? res;
}

export async function moveToFolder(threadId, folderName) {
  if (!threadId) throw new Error("threadId required");
  assertSupportNamespace(folderName, "folder");
  const cfg = await loadConfig();
  const folder = await ensureFolder(folderName);
  const folderId = folder.folderId ?? folder.id;
  // PUT /updatemessage with `destfolderId` (lowercase 'f' — capital-ID has been
  // observed to return EXTRA_KEY_FOUND_IN_JSON). `/updatemessage` accepts a
  // thread id via `threadId` to move the whole conversation in one call. See:
  // https://www.zoho.com/mail/help/api/put-move-message.html
  // If Phase B live verification surfaces "thread not found in Inbox" type
  // errors when threads sit in non-Inbox folders, add
  // `isFolderSpecific: true` + the source `folderId` to disambiguate.
  const res = await zohoApi("PUT", ZOHO_API_PATHS.updateMessage(cfg.accountId), {
    body: { mode: "moveMessage", destfolderId: folderId, threadId: [threadId] },
  });
  return res.data ?? res;
}

// ── CLI dispatch ────────────────────────────────────────────────────────────

// All current zoho-cli flags require a value (--to, --subject, --body-file).
// Treating any `--xxx` token as boolean would mis-parse `--body-file --to x`
// (the body-file flag silently becomes `true` and `--to` is consumed as a
// separate flag with `x` as its value). Both `--key=value` and `--key value`
// are accepted; missing values raise a clear error.
function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const eq = key.indexOf("=");
      if (eq !== -1) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
      } else if (i + 1 >= argv.length) {
        throw new Error(`Missing value for --${key}`);
      } else {
        flags[key] = argv[i + 1];
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function main(argv) {
  const [sub, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);
  switch (sub) {
    case "list-pending":
      return listPending();
    case "get-thread":
      return getThread(positional[0]);
    case "get-headers":
      return getHeaders(positional[0], positional[1]);
    case "reply":
      return replyToThread(positional[0], flags["body-file"]);
    case "send":
      return sendFresh({ to: flags.to, subject: flags.subject, bodyFile: flags["body-file"] });
    case "add-label":
      return addLabel(positional[0], positional[1]);
    case "add-message-label":
      return addMessageLabel(positional[0], positional[1]);
    case "move-to-folder":
      return moveToFolder(positional[0], positional[1]);
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        "Usage: zoho-cli.mjs <list-pending|get-thread <threadId>|get-headers <folderId> <messageId>|reply <threadId> --body-file <path>|send --to <addr> --subject <s> --body-file <path>|add-label <threadId> <label>|add-message-label <messageId> <label>|move-to-folder <threadId> <folder>>\n",
      );
      return null;
    default:
      throw new Error(`Unknown subcommand: ${sub}`);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2)).then(
    (out) => {
      if (out !== null && out !== undefined) {
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      }
    },
    (err) => {
      process.stderr.write(JSON.stringify({ error: err.message, body: err.body }) + "\n");
      process.exit(1);
    },
  );
}
