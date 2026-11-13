#!/usr/bin/env node
// Permanently deletes Drafto user accounts by email, for an operator cleaning
// up unused sign-ups. Optionally emails each deleted user (--notify).
//
// Deletion follows apps/web/src/lib/account/delete-user.ts, the app's own
// account deletion:
//   1. strict sweep of the user's files in the attachments bucket (any error
//      stops before the account is touched),
//   2. delete the auth user, which cascades to profiles, notebooks, notes,
//      note history and API keys,
//   3. best-effort sweep for a file uploaded in between,
//   4. check that the auth user, the user's rows and files are gone.
// With --notify, the email goes out only after step 4 confirms the deletion.
//
// What it refuses, per user (the others still run):
//   - an admin (profiles.is_admin),
//   - a user who owns any note, trashed ones included. The privacy policy
//     (apps/web/src/app/privacy/page.tsx, "Account approval") only says we may
//     delete accounts that hold no notes; change both together.
//   - an email that matches no user.
// The whole run refuses unattended sessions (DRAFTO_UNATTENDED=1) and
// `node --test`, before reading any key file.
//
// Keys, never printed:
//   - Service-role key: the DEV: or PROD: line of --keys-txt, by default
//     ~/drafto-secrets/supabase service keys.txt.
//   - Resend key (only with --notify): RESEND_API_KEY from the environment,
//     else from --resend-env, by default ~/drafto-secrets/account-approval-secrets.env.
//
// Usage:
//   pnpm users:delete -- --project prod|dev [--execute] [--notify]
//        [--reason "<one line>"] [--keys-txt <f>] [--resend-env <f>] <email>...
//
// Without --execute it only prints the plan: each user's id and what they own.
// Exit 0 when every user was deleted (and emailed, with --notify) or for a plan
// or --help, 1 when anything was refused or failed, 2 on bad arguments.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { isMainModule } from "./lib/is-main.mjs";
import { PROJECTS, defaultKeysTxtPath, readServiceKey } from "./lib/service-keys-txt.mjs";
import { parseEnvFile } from "./lib/verify-lane.mjs";
import { UNATTENDED_VAR } from "./run-dev-live-tests.mjs";

export { PROJECTS };
export const BUCKET = "attachments"; // packages/shared/src/constants.ts BUCKET_NAME
// Every public table keyed to a user. note_content_history has no FK to
// auth.users, so the cascade reaches it only through notes.
export const OWNED_TABLES = Object.freeze([
  "profiles",
  "notebooks",
  "notes",
  "attachments",
  "note_content_history",
  "api_keys",
]);
export const EMAIL_FROM = "Drafto <hello@drafto.eu>"; // apps/web/src/env.ts EMAIL_FROM default
export const EMAIL_REPLY_TO = "support@drafto.eu";
export const SIGNUP_URL = "https://drafto.eu/signup";
const PAGE = 1000;

const USAGE = `Usage: pnpm users:delete -- --project prod|dev [--execute] [--notify]
       [--reason "<one line>"] [--keys-txt <file>] [--resend-env <file>] <email>...

Without --execute, prints what each user owns and deletes nothing.
--notify  email each user after their account is confirmed deleted (Resend).
--reason  optional sentence added to that email.`;

export class UsageError extends Error {}

/** Parses argv (without node and the script path). Throws UsageError. */
export function parseArgs(argv) {
  const opts = {
    project: null,
    execute: false,
    notify: false,
    reason: null,
    keysTxt: defaultKeysTxtPath(),
    resendEnv: path.join(homedir(), "drafto-secrets", "account-approval-secrets.env"),
    emails: [],
    help: false,
  };
  const valueOf = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--execute") opts.execute = true;
    else if (a === "--notify") opts.notify = true;
    else if (a === "--project") opts.project = valueOf(i++, a);
    else if (a === "--reason") opts.reason = valueOf(i++, a);
    else if (a === "--keys-txt") opts.keysTxt = valueOf(i++, a);
    else if (a === "--resend-env") opts.resendEnv = valueOf(i++, a);
    else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else opts.emails.push(a.trim().toLowerCase());
  }
  if (opts.help) return opts;
  if (!Object.hasOwn(PROJECTS, opts.project ?? "")) {
    throw new UsageError("--project must be prod or dev");
  }
  if (!opts.emails.length) throw new UsageError("give at least one email");
  const bad = opts.emails.find((e) => !/^[^\s@]+@[^\s@]+$/.test(e));
  if (bad) throw new UsageError(`not an email address: ${bad}`);
  opts.emails = [...new Set(opts.emails)];
  if (opts.reason !== null) {
    opts.reason = opts.reason.replace(/[\r\n]+/g, " ").trim();
    if (!opts.reason) throw new UsageError("--reason is empty");
  }
  return opts;
}

/** Why this process must not run, or null. */
export function refusalReason({ env = process.env, execArgv = process.execArgv } = {}) {
  // Any value counts, so an unexpected one fails closed.
  if (env[UNATTENDED_VAR]) {
    return `${UNATTENDED_VAR} is set: deleting accounts is for interactive sessions only`;
  }
  if (env.NODE_TEST_CONTEXT || execArgv.includes("--test")) {
    return "running under node --test; run it as pnpm users:delete instead";
  }
  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The "account deleted" email. Colors mirror EMAIL_COLORS in
 * apps/web/src/lib/email/templates.ts (ADR-0020).
 */
export function buildDeletionEmail({ email, reason = null }) {
  const reasonLine = reason || null;
  const text = [
    "Hello,",
    "",
    `We have deleted your Drafto account (${email}) and everything stored in it.`,
    ...(reasonLine ? ["", reasonLine] : []),
    "",
    `If you'd like to use Drafto again, you're welcome to sign up again: ${SIGNUP_URL}`,
    `If you think this was a mistake, reply to this email or write to ${EMAIL_REPLY_TO}.`,
    "",
    "— Drafto",
  ].join("\n");
  const p = (inner) => `<p style="margin: 0 0 16px;">${inner}</p>`;
  const html = `<!doctype html>
<html><body style="margin: 0; background: #fff8f5;">
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f1b17; line-height: 1.5; max-width: 560px; margin: 0 auto; padding: 32px 24px;">
${p("Hello,")}
${p(`We have deleted your Drafto account (<strong>${escapeHtml(email)}</strong>) and everything stored in it.`)}
${reasonLine ? p(escapeHtml(reasonLine)) : ""}
${p(`If you&#39;d like to use Drafto again, you&#39;re welcome to <a href="${SIGNUP_URL}" style="color: #3525cd;">sign up again</a>.`)}
${p(`If you think this was a mistake, reply to this email or write to <a href="mailto:${EMAIL_REPLY_TO}" style="color: #3525cd;">${EMAIL_REPLY_TO}</a>.`)}
<p style="margin: 24px 0 0; color: #6b6360;">— Drafto</p>
</div>
</body></html>`;
  return { subject: "Your Drafto account has been deleted", text, html };
}

/** A small Supabase admin client over fetch: auth admin, PostgREST and Storage. */
export function createSupabaseAdmin({ ref, serviceKey, fetchImpl = fetch }) {
  const base = `https://${ref}.supabase.co`;
  async function req(method, urlPath, { body, headers = {} } = {}) {
    const res = await fetchImpl(`${base}${urlPath}`, {
      method,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`${method} ${urlPath.split("?")[0]} -> ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  async function listFiles(prefix) {
    const files = [];
    for (let offset = 0; ; offset += PAGE) {
      const entries = await req("POST", `/storage/v1/object/list/${BUCKET}`, {
        body: { prefix, limit: PAGE, offset, sortBy: { column: "name", order: "asc" } },
      });
      for (const e of entries) {
        const p = `${prefix}/${e.name}`;
        // Folders come back with a null id; files always carry one.
        if (e.id === null) files.push(...(await listFiles(p)));
        else files.push(p);
      }
      if (entries.length < PAGE) return files;
    }
  }

  return {
    async findUsersByEmail(emails) {
      const wanted = new Set(emails);
      const found = new Map();
      for (let page = 1; ; page++) {
        const { users } = await req("GET", `/auth/v1/admin/users?page=${page}&per_page=${PAGE}`);
        for (const u of users) {
          const e = (u.email ?? "").toLowerCase();
          if (wanted.has(e)) found.set(e, u);
        }
        if (users.length < PAGE) return found;
      }
    },
    async userExists(id) {
      const res = await fetchImpl(`${base}/auth/v1/admin/users/${id}`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      await res.text();
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`GET /auth/v1/admin/users/{id} -> ${res.status}`);
      return true;
    },
    async owned(id) {
      // Exact counts from Content-Range, no rows; the profile row also
      // carries the admin flag.
      const counts = {};
      const [profile] = await Promise.all([
        req("GET", `/rest/v1/profiles?select=is_admin&id=eq.${id}`),
        ...OWNED_TABLES.map(async (table) => {
          const col = table === "profiles" ? "id" : "user_id";
          const res = await fetchImpl(
            `${base}/rest/v1/${table}?select=${col}&${col}=eq.${id}&limit=0`,
            {
              headers: {
                apikey: serviceKey,
                Authorization: `Bearer ${serviceKey}`,
                Prefer: "count=exact",
              },
            },
          );
          await res.text();
          const total = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
          if (!res.ok || !total) throw new Error(`count ${table} -> ${res.status}`);
          counts[table] = Number(total[1]);
        }),
      ]);
      return {
        ...Object.fromEntries(OWNED_TABLES.map((t) => [t, counts[t]])),
        isAdmin: profile.some((r) => r.is_admin === true),
      };
    },
    listFiles,
    async removeFiles(paths) {
      for (let i = 0; i < paths.length; i += PAGE) {
        await req("DELETE", `/storage/v1/object/${BUCKET}`, {
          body: { prefixes: paths.slice(i, i + PAGE) },
        });
      }
    },
    async deleteAuthUser(id) {
      await req("DELETE", `/auth/v1/admin/users/${id}`);
    },
  };
}

/** Sends one email through Resend's HTTP API. Resolves to the Resend id. */
export async function sendResendEmail({ apiKey, to, subject, html, text, fetchImpl = fetch }) {
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [to],
      reply_to: EMAIL_REPLY_TO,
      subject,
      html,
      text,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend -> ${res.status} ${body.slice(0, 200)}`);
  return JSON.parse(body).id ?? null;
}

/** Why this user may not be deleted, or null. */
export function userRefusal(owned) {
  if (owned.isAdmin) return "is an admin";
  if (owned.notes > 0) {
    return `owns ${owned.notes} note(s); this script only deletes accounts with no notes`;
  }
  return null;
}

function summary(owned, files) {
  const { isAdmin, ...counts } = owned;
  return JSON.stringify({ ...counts, files, ...(isAdmin ? { admin: true } : {}) });
}

/**
 * Plans, and with opts.execute runs, the deletion. `log` gets one line per
 * event. Each user runs on their own: an error with one is logged and the
 * rest still run. Resolves to true when everything asked for succeeded.
 */
export async function run(opts, { admin, sendEmail, log = console.log }) {
  let ok = true;
  const users = await admin.findUsersByEmail(opts.emails);
  for (const email of opts.emails) {
    const user = users.get(email);
    if (!user) {
      log(`${email}: no such user — skipped`);
      ok = false;
      continue;
    }
    try {
      if (!(await runOne(opts, { admin, sendEmail, log }, email, user.id))) ok = false;
    } catch (err) {
      log(`  stopped by an error: ${err.message} — check this account by hand before rerunning`);
      ok = false;
    }
  }
  return ok;
}

async function runOne(opts, { admin, sendEmail, log }, email, id) {
  const owned = await admin.owned(id);
  const files = await admin.listFiles(id);
  log(`${email}: id=${id} ${summary(owned, files.length)}`);
  const refusal = userRefusal(owned);
  if (refusal) {
    log(`  refused: ${refusal}`);
    return false;
  }
  if (!opts.execute) {
    log(`  would delete${opts.notify ? " and email" : ""} (dry run; add --execute)`);
    return true;
  }

  try {
    await admin.removeFiles(files);
  } catch (err) {
    log(`  storage sweep failed, account untouched: ${err.message}`);
    return false;
  }
  // Re-check just before the delete: a note synced since the plan must not be
  // deleted with the account.
  const lateRefusal = userRefusal(await admin.owned(id));
  if (lateRefusal) {
    log(`  refused before deleting: ${lateRefusal} (its files were already removed)`);
    return false;
  }
  try {
    await admin.deleteAuthUser(id);
  } catch (err) {
    log(`  deleting the auth user failed: ${err.message}`);
    return false;
  }
  try {
    await admin.removeFiles(await admin.listFiles(id));
  } catch (err) {
    log(`  warning: second storage sweep failed: ${err.message}`);
  }

  const stillThere = await admin.userExists(id);
  const left = await admin.owned(id);
  const leftFiles = (await admin.listFiles(id)).length;
  const leftRows = OWNED_TABLES.reduce((n, t) => n + left[t], 0);
  if (stillThere || leftRows || leftFiles) {
    log(`  NOT fully deleted: authUser=${stillThere} ${summary(left, leftFiles)} — no email sent`);
    return false;
  }
  log("  deleted");

  if (!opts.notify) return true;
  try {
    const emailId = await sendEmail({
      to: email,
      ...buildDeletionEmail({ email, reason: opts.reason }),
    });
    log(`  emailed (Resend id ${emailId})`);
    return true;
  } catch (err) {
    log(`  email failed: ${err.message}`);
    return false;
  }
}

function readKeys(opts, env) {
  const { ref, serviceKey } = readServiceKey({ project: opts.project, keysTxt: opts.keysTxt });
  let resendKey = null;
  // A dry run never sends, so it doesn't need the Resend key.
  if (opts.notify && opts.execute) {
    resendKey =
      env.RESEND_API_KEY || parseEnvFile(readFileSync(opts.resendEnv, "utf8")).RESEND_API_KEY;
    if (!resendKey) throw new Error(`RESEND_API_KEY is not set and not in ${opts.resendEnv}`);
  }
  return { ref, serviceKey, resendKey };
}

async function main(argv, env = process.env) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const refusal = refusalReason({ env });
  if (refusal) {
    console.error(refusal);
    return 1;
  }
  const { ref, serviceKey, resendKey } = readKeys(opts, env);
  console.log(
    `Project ${opts.project} (${ref}) — ${opts.execute ? "DELETING" : "dry run"}` +
      `${opts.notify ? ", with email" : ""}`,
  );
  const admin = createSupabaseAdmin({ ref, serviceKey });
  const sendEmail = (msg) => sendResendEmail({ apiKey: resendKey, ...msg });
  return (await run(opts, { admin, sendEmail })) ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(1);
    },
  );
}
