#!/usr/bin/env node
// Zoho Mail CLI used by the support agent.
//
// Subcommands (all argv-driven so Claude Code can invoke them via Bash):
//   list-pending                            → JSON array of Inbox messages
//                                             that don't yet carry a terminal
//                                             Drafto/Support/* label.
//   get-thread <threadId>                   → full thread JSON (messages + headers).
//   get-headers <messageId>                 → parsed header object for one message.
//   reply <threadId> --body-file <path>     → posts a reply in-thread; sender is
//                                             always the OAuth user (no --from).
//   send --to <addr> --subject <s>          → sends a fresh non-reply email; sender
//        --body-file <path>                   always the OAuth user. Used for admin
//                                             notifications.
//   add-label <threadId> <labelName>        → applies a label; refuses any name not
//                                             under "Drafto/Support/". Creates the
//                                             label lazily if it doesn't exist yet.
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
// Endpoint paths reflect Zoho's documented Mail REST API. Phase A live
// verification may surface small adjustments — keep the paths in
// ZOHO_API_PATHS centralised so they can be changed in one place.

import { promises as fs } from "node:fs";
import { loadConfig, getAccessToken, invalidateAccessToken, _resetForTests } from "./zoho-auth.mjs";

const SUPPORT_NAMESPACE = "Drafto/Support/";

// Centralised endpoint paths. Templated with ${accountId}, ${messageId}, etc.
// at call time. Documented against zoho.com/mail/help/api/ as of Apr 2026.
//
// Thread-level mutations (applying labels, moving folders) all go through the
// unified `PUT /updatethread` endpoint with a `mode` parameter — see
// https://www.zoho.com/mail/help/api/put-label-thread.html and
// https://www.zoho.com/mail/help/api/put-move-thread.html.
const ZOHO_API_PATHS = {
  folders: (accountId) => `/api/accounts/${accountId}/folders`,
  labels: (accountId) => `/api/accounts/${accountId}/labels`,
  messagesView: (accountId) => `/api/accounts/${accountId}/messages/view`,
  threadDetails: (accountId, threadId) =>
    `/api/accounts/${accountId}/messages/${encodeURIComponent(threadId)}/details`,
  messageHeader: (accountId, messageId) =>
    `/api/accounts/${accountId}/messages/${encodeURIComponent(messageId)}/header`,
  sendOrReply: (accountId) => `/api/accounts/${accountId}/messages`,
  updateThread: (accountId) => `/api/accounts/${accountId}/updatethread`,
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
    const name = l.labelName ?? l.name;
    if (name) _labelsByName.set(name, l);
  }
  return _labelsByName;
}

async function ensureLabel(name) {
  const labels = await listLabels();
  if (labels.has(name)) return labels.get(name);
  const cfg = await loadConfig();
  const created = await zohoApi("POST", ZOHO_API_PATHS.labels(cfg.accountId), {
    body: { labelName: name },
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
  // Inbox + Needs-Human stays "pending" from the agent's POV.
  return labelName !== `${SUPPORT_NAMESPACE}Needs-Human`;
}

function messageHasTerminalLabel(msg) {
  const labels = msg.labels ?? msg.labelInfo ?? [];
  return labels.some((l) => isTerminalSupportLabel(l.labelName ?? l.name ?? l));
}

export async function listPending() {
  const cfg = await loadConfig();
  const folders = await listFolders();
  const inbox = folders.get("Inbox");
  if (!inbox) throw new Error('Could not locate Zoho "Inbox" folder');
  const inboxId = inbox.folderId ?? inbox.id;
  const res = await zohoApi("GET", ZOHO_API_PATHS.messagesView(cfg.accountId), {
    query: { folderId: inboxId, includeto: "true", limit: 200 },
  });
  const arr = res.data ?? res.messages ?? [];
  return arr.filter((m) => !messageHasTerminalLabel(m));
}

export async function getThread(threadId) {
  if (!threadId) throw new Error("threadId required");
  const cfg = await loadConfig();
  const res = await zohoApi("GET", ZOHO_API_PATHS.threadDetails(cfg.accountId, threadId));
  return res.data ?? res;
}

export async function getHeaders(messageId) {
  if (!messageId) throw new Error("messageId required");
  const cfg = await loadConfig();
  const res = await zohoApi("GET", ZOHO_API_PATHS.messageHeader(cfg.accountId, messageId));
  // Zoho returns headers as an object or as a CRLF-delimited string depending
  // on the endpoint variant; normalise to a plain {Name: value} object.
  const raw = res.data?.header ?? res.data ?? res.header ?? res;
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

export async function moveToFolder(threadId, folderName) {
  if (!threadId) throw new Error("threadId required");
  assertSupportNamespace(folderName, "folder");
  const cfg = await loadConfig();
  const folder = await ensureFolder(folderName);
  const folderId = folder.folderId ?? folder.id;
  // PUT /updatethread, mode=moveMessage. See:
  // https://www.zoho.com/mail/help/api/put-move-thread.html
  // NOTE: per the docs, `folderId` here is the SOURCE folder for threads, not
  // the destination — Zoho implies the destination from the move mode. Our use
  // case (moving Inbox→Resolved/Spam) needs destination semantics, so we send
  // `destFolderId` as well; if Zoho ignores it during Phase B live verification,
  // switch to per-message moves via /messages/{id}/moveTo or fall back to
  // label-only organisation. Flagged as TODO(phase-B).
  const res = await zohoApi("PUT", ZOHO_API_PATHS.updateThread(cfg.accountId), {
    body: { mode: "moveMessage", threadId: [threadId], destFolderId: folderId },
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
      return getHeaders(positional[0]);
    case "reply":
      return replyToThread(positional[0], flags["body-file"]);
    case "send":
      return sendFresh({ to: flags.to, subject: flags.subject, bodyFile: flags["body-file"] });
    case "add-label":
      return addLabel(positional[0], positional[1]);
    case "move-to-folder":
      return moveToFolder(positional[0], positional[1]);
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        "Usage: zoho-cli.mjs <list-pending|get-thread|get-headers|reply|send|add-label|move-to-folder> [args]\n",
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
