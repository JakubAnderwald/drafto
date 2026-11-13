// Read-only checks of the DEV Supabase project (huhzactreblzcogqkbsd), scoped
// to one of the factory's own accounts (ADR-0073). A verification run uses it
// to confirm what a scenario step did to the data: "no attachment row was
// added", "the deleted note's file is gone", "usage is back to 0".
//
// The dev service-role key never reaches the model. The run's supervisor writes
// private/dev-inspect.cfg (mode 600, a guard-protected name: the key file's path
// and each account's email file), and bin/dev-inspect runs this module in a
// fresh process that reads it. Every request is a GET, a storage listing or one
// of READ_RPCS, always filtered to the account's own user id, and the output
// is counts, ids, object names and sizes. A command that names another table,
// another account or anything else is refused before any request is made.
//
// Commands (`dev-inspect [--as user|admin] <command> [options]`):
//   whoami                                  → {account, id}
//   rows <table> [--note U] [--notebook U]  → {table, count}
//   objects [--note U]                      → {count, totalBytes, objects: [{name, size}]}
//   profile                                 → {isApproved, isAdmin, storageQuotaBytes}
//   usage                                   → {usedBytes, objectBytes, quotaBytes}
//   orphans                                 → {count, objects: [names]}
//
// Exit 0 with one JSON line on stdout; 2 with {error} for a refused command or
// a failed request. Errors name the request, never a key or a header.

import * as nodeFs from "node:fs";
import {
  accountFileProblem,
  adminAccountFileProblem,
  readAccountFile,
  readAdminAccountFile,
} from "./browser-report.mjs";
import { DEV_SUPABASE_URL, keyFileProblem, parseKeyFile } from "./browser-signin.mjs";

export const BUCKET = "attachments"; // packages/shared/src/constants.ts BUCKET_NAME
export const ACCOUNTS = Object.freeze(["user", "admin"]);

// The user-owned tables a check may count, and the filters each one takes.
// Every count is also filtered to the account's own user_id.
export const INSPECT_TABLES = Object.freeze({
  notebooks: { notebook: "id" },
  notes: { note: "id", notebook: "notebook_id" },
  attachments: { note: "note_id" },
  note_content_history: { note: "note_id" },
  api_keys: {},
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAGE = 1000;
const MAX_OBJECTS = 500;
const REQUEST_TIMEOUT_MS = 20_000;

export class InspectUsageError extends Error {}

const USAGE =
  "usage: dev-inspect [--as user|admin] whoami|profile|usage|orphans|" +
  "objects [--note <uuid>]|rows <" +
  Object.keys(INSPECT_TABLES).join("|") +
  "> [--note <uuid>] [--notebook <uuid>]";

/** argv → {account, command, table?, filters}. Throws InspectUsageError. */
export function parseInspectArgs(argv) {
  const args = [...argv];
  let account = "user";
  const filters = {};
  const positional = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === "--as") {
      account = args.shift();
      if (!ACCOUNTS.includes(account)) {
        throw new InspectUsageError(`--as must be one of: ${ACCOUNTS.join(", ")}\n${USAGE}`);
      }
    } else if (arg === "--note" || arg === "--notebook") {
      const value = args.shift();
      if (!UUID_RE.test(value ?? "")) throw new InspectUsageError(`${arg} needs a uuid`);
      filters[arg.slice(2)] = value;
    } else if (arg.startsWith("-")) {
      throw new InspectUsageError(`unknown option ${arg}\n${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  const [command, ...rest] = positional;
  switch (command) {
    case "whoami":
    case "profile":
    case "usage":
    case "orphans":
      if (rest.length || Object.keys(filters).length) {
        throw new InspectUsageError(`${command} takes no arguments\n${USAGE}`);
      }
      return { account, command, filters };
    case "objects":
      if (rest.length || filters.notebook) {
        throw new InspectUsageError(`objects takes only --note\n${USAGE}`);
      }
      return { account, command, filters };
    case "rows": {
      const [table, ...extra] = rest;
      if (!Object.hasOwn(INSPECT_TABLES, table ?? "") || extra.length) {
        throw new InspectUsageError(
          `rows needs one of: ${Object.keys(INSPECT_TABLES).join(", ")}\n${USAGE}`,
        );
      }
      for (const key of Object.keys(filters)) {
        if (!Object.hasOwn(INSPECT_TABLES[table], key)) {
          throw new InspectUsageError(`rows ${table} can't filter by --${key}`);
        }
      }
      return { account, command, table, filters };
    }
    default:
      throw new InspectUsageError(
        command ? `unknown command ${command}\n${USAGE}` : `missing command\n${USAGE}`,
      );
  }
}

/**
 * A read-only client for the dev project: GETs, the storage listing and the
 * read-only RPCs in READ_RPCS. Nothing here can write.
 */
export const READ_RPCS = Object.freeze([
  "storage_usage_bytes",
  "storage_object_bytes",
  "orphaned_attachment_objects",
]);

export function createDevReader({ serviceKey, url = DEV_SUPABASE_URL, fetchImpl = fetch }) {
  if (url !== DEV_SUPABASE_URL) throw new Error("dev-inspect reads the dev project only");
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  async function call(method, urlPath, { body, extraHeaders = {} } = {}) {
    let res;
    try {
      res = await fetchImpl(`${url}${urlPath}`, {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`${method} ${urlPath.split("?")[0]} failed: ${err.name ?? "error"}`);
    }
    const text = await res.text();
    if (!res.ok) {
      // PostgREST's error code (e.g. 42703, PGRST202) is safe to keep; the
      // body's message isn't shown.
      let code = null;
      try {
        code = typeof JSON.parse(text)?.code === "string" ? JSON.parse(text).code : null;
      } catch {
        // not JSON
      }
      const err = new Error(
        `${method} ${urlPath.split("?")[0]} -> ${res.status}${code ? ` (${code})` : ""}`,
      );
      err.status = res.status;
      err.code = code;
      throw err;
    }
    return { res, json: text ? JSON.parse(text) : null };
  }

  return {
    async userIdByEmail(email) {
      const wanted = email.toLowerCase();
      for (let page = 1; page <= 50; page++) {
        const { json } = await call("GET", `/auth/v1/admin/users?page=${page}&per_page=${PAGE}`);
        const users = json?.users ?? [];
        const hit = users.find((u) => (u.email ?? "").toLowerCase() === wanted);
        if (hit) return hit.id;
        if (users.length < PAGE) return null;
      }
      return null;
    },
    async count(table, column, filters) {
      const query = [`select=${column}`, "limit=0"];
      for (const [col, value] of Object.entries(filters)) query.push(`${col}=eq.${value}`);
      const { res } = await call("GET", `/rest/v1/${table}?${query.join("&")}`, {
        extraHeaders: { Prefer: "count=exact" },
      });
      const total = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
      if (!total) throw new Error(`count ${table}: no Content-Range`);
      return Number(total[1]);
    },
    async select(table, columns, filters) {
      const query = [`select=${columns}`];
      for (const [col, value] of Object.entries(filters)) query.push(`${col}=eq.${value}`);
      return (await call("GET", `/rest/v1/${table}?${query.join("&")}`)).json ?? [];
    },
    async listObjects(prefix) {
      const out = [];
      // Past the cap every level stops, not only the folder that hit it.
      const full = () => out.length > MAX_OBJECTS;
      const walk = async (dir) => {
        for (let offset = 0; !full(); offset += PAGE) {
          const { json } = await call("POST", `/storage/v1/object/list/${BUCKET}`, {
            body: { prefix: dir, limit: PAGE, offset, sortBy: { column: "name", order: "asc" } },
          });
          const entries = json ?? [];
          for (const e of entries) {
            const p = `${dir}/${e.name}`;
            // Folders come back with a null id; files always carry one.
            if (e.id === null) await walk(p);
            else out.push({ name: p, size: Number(e.metadata?.size ?? 0) });
            if (full()) return;
          }
          if (entries.length < PAGE) return;
        }
      };
      await walk(prefix);
      return out;
    },
    async rpc(name, args) {
      if (!READ_RPCS.includes(name)) throw new Error(`${name} is not a read-only RPC`);
      return (await call("POST", `/rest/v1/rpc/${name}`, { body: args })).json;
    },
  };
}

/**
 * Whether an error means "dev doesn't have this column or function yet" (the
 * per-user quota migration, #794): PostgREST's undefined-column (42703) or
 * function-not-found (PGRST202, 42883) codes, or a 404. Anything else, a
 * timeout or a 5xx, is a real failure and is reported as one.
 */
export function isMissingFeature(err) {
  return err?.status === 404 || ["42703", "42883", "PGRST202", "PGRST204"].includes(err?.code);
}

const UNAVAILABLE = "unavailable on dev (needs the per-user storage quota migration)";

/** Runs one parsed command for the account with user id <userId>. */
export async function runInspect(parsed, { reader, userId, email }) {
  switch (parsed.command) {
    case "whoami":
      return { account: parsed.account, id: userId };
    case "rows": {
      const own = INSPECT_TABLES[parsed.table];
      const filters = { user_id: userId };
      for (const [key, value] of Object.entries(parsed.filters)) filters[own[key]] = value;
      return { table: parsed.table, count: await reader.count(parsed.table, "id", filters) };
    }
    case "objects": {
      const prefix = parsed.filters.note ? `${userId}/${parsed.filters.note}` : userId;
      const objects = await reader.listObjects(prefix);
      const truncated = objects.length > MAX_OBJECTS;
      const shown = objects.slice(0, MAX_OBJECTS).map((o) => ({
        // Relative to the account's folder: the account's id is in whoami.
        name: o.name.slice(userId.length + 1),
        size: o.size,
      }));
      return {
        count: shown.length,
        truncated,
        totalBytes: shown.reduce((n, o) => n + o.size, 0),
        objects: shown,
      };
    }
    case "profile": {
      // storage_quota_bytes exists once the per-user quota migration is on dev.
      let rows;
      let quota = true;
      try {
        rows = await reader.select("profiles", "is_approved,is_admin,storage_quota_bytes", {
          id: userId,
        });
      } catch (err) {
        if (!isMissingFeature(err)) throw err;
        quota = false;
        rows = await reader.select("profiles", "is_approved,is_admin", { id: userId });
      }
      const p = rows[0] ?? {};
      return {
        isApproved: p.is_approved ?? null,
        isAdmin: p.is_admin ?? null,
        storageQuotaBytes: quota ? (p.storage_quota_bytes ?? null) : UNAVAILABLE,
      };
    }
    case "usage": {
      const safe = async (fn) => {
        try {
          return await fn();
        } catch (err) {
          if (isMissingFeature(err)) return UNAVAILABLE;
          throw err;
        }
      };
      return {
        usedBytes: await safe(() => reader.rpc("storage_usage_bytes", { uid: userId })),
        objectBytes: await safe(() => reader.rpc("storage_object_bytes", { uid: userId })),
        quotaBytes: await safe(async () => {
          const rows = await reader.select("profiles", "storage_quota_bytes", { id: userId });
          return rows[0]?.storage_quota_bytes ?? null;
        }),
      };
    }
    case "orphans": {
      let names;
      try {
        names = await reader.rpc("orphaned_attachment_objects", {
          max_rows: 1000,
          only_user: userId,
        });
      } catch (err) {
        if (isMissingFeature(err)) return { count: UNAVAILABLE, objects: [] };
        throw err;
      }
      // A `setof text` function answers a JSON array of strings.
      const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === "string");
      return { count: list.length, objects: list.map((n) => n.slice(userId.length + 1)) };
    }
    default:
      throw new InspectUsageError(`unknown command ${parsed.command}`);
  }
}

/**
 * The run's inspect config (private/dev-inspect.cfg, JSON): {keyFile,
 * accounts: {user: accountFile, admin?: adminAccountFile}}. The user's file is
 * the browser runner's account file; the admin's holds only
 * FACTORY_BROWSER_ADMIN_EMAIL (ADR-0073).
 */
export function readAccountEmail(file, account) {
  // The test account's file is the browser runner's own: read it the same way.
  if (account === "user") {
    const problem = accountFileProblem(file);
    if (problem) throw new Error(`the user account file is ${problem}`);
    return readAccountFile(file).email;
  }
  // The admin's file holds only an email (no password: it signs in by link).
  const problem = adminAccountFileProblem(file);
  if (problem) throw new Error(`the ${account} account file is ${problem}`);
  return readAdminAccountFile(file).email;
}

/** Everything one invocation does, given its config. Returns {exitCode, out}. */
export async function inspectMain(argv, { config, fs = nodeFs, fetchImpl = fetch }) {
  let parsed;
  try {
    parsed = parseInspectArgs(argv);
  } catch (err) {
    if (err instanceof InspectUsageError) return { exitCode: 2, out: { error: err.message } };
    throw err;
  }
  let serviceKey = null;
  try {
    const accountFile = config?.accounts?.[parsed.account];
    if (!accountFile) {
      return { exitCode: 2, out: { error: `this run has no ${parsed.account} account` } };
    }
    const keyProblem = keyFileProblem(config.keyFile);
    if (keyProblem) return { exitCode: 2, out: { error: `the dev key file is ${keyProblem}` } };
    ({ serviceRoleKey: serviceKey } = parseKeyFile(fs.readFileSync(config.keyFile, "utf8")));
    const email = readAccountEmail(accountFile, parsed.account);
    const reader = createDevReader({ serviceKey, fetchImpl });
    const userId = await reader.userIdByEmail(email);
    if (!userId)
      return { exitCode: 2, out: { error: `no dev user for the ${parsed.account} account` } };
    const out = await runInspect(parsed, { reader, userId, email });
    return { exitCode: 0, out: redact({ account: parsed.account, ...out }, serviceKey) };
  } catch (err) {
    return { exitCode: 2, out: redact({ error: err.message }, serviceKey) };
  }
}

// Belt and braces: nothing above puts the key in its output, but a value the
// API echoes back must not carry it either.
function redact(out, serviceKey) {
  if (!serviceKey) return out;
  const text = JSON.stringify(out);
  return text.includes(serviceKey) ? { error: "output withheld: it contained the dev key" } : out;
}
