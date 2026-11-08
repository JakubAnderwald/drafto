// Live check of the per-user attachment storage quota (issue #794, ADR 0069)
// against the DEV Supabase project. It talks to GoTrue, PostgREST and Storage
// with plain fetch, the same path mobile and desktop (supabase-js) and a
// tampering client holding the public anon key and their own JWT would use.
//
// What it checks, from supabase/migrations/20261108000001_per_user_storage_quota.sql:
//   - the attachments trigger refuses a row that would take usage over the
//     quota (message `storage_quota_exceeded`) and allows landing exactly on it;
//   - the mobile/desktop retry (an upsert with ON CONFLICT DO NOTHING of a row
//     that already exists) is let through and doesn't count twice;
//   - the bucket's INSERT and UPDATE policies refuse an upload once usage
//     reaches the quota, and allow one for an unlimited (NULL) user;
//   - the API roles can't call the internal per-user helpers, can read only
//     their own usage, can't call the admin RPC, and can't lift their own quota.
//
// Opt-in: it runs only when NEXT_PUBLIC_SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY are exported and NEXT_PUBLIC_SUPABASE_URL's origin
// is exactly the dev project over HTTPS. The CI scripts job exports none of
// them, so it skips there, and it refuses any other project or a plain-http
// origin, so it can never touch production or send a key in cleartext.
//
// Run it with `pnpm test:live:supabase -- --only storage-quota`, which reads
// the keys from this machine's files and sets DRAFTO_LIVE_REQUIRED=1, so a
// missing key fails the run instead of skipping it.
//
// Creating users fires the dev project's new-signup webhook, if dev has one
// configured. Every object uploaded here and every user created here is
// deleted in the `after` hook (objects first).

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// The quota's error code, default and bucket come from packages/shared, the
// source every app imports. This file runs under plain Node, which can't import
// that TypeScript on every supported version, so it reads the literals; a
// renamed or reshaped constant fails the file instead of drifting.
const SHARED_CONSTANTS = readFileSync(
  new URL("../../packages/shared/src/constants.ts", import.meta.url),
  "utf8",
);

function sharedConstant(name) {
  const match = SHARED_CONSTANTS.match(
    new RegExp(`^export const ${name} = (?:"([^"]*)"|(\\d+));`, "m"),
  );
  if (!match) throw new Error(`packages/shared/src/constants.ts has no literal ${name}`);
  return match[1] ?? Number(match[2]);
}

const STORAGE_QUOTA_EXCEEDED_CODE = sharedConstant("STORAGE_QUOTA_EXCEEDED_CODE");
const DEFAULT_STORAGE_QUOTA_BYTES = sharedConstant("DEFAULT_STORAGE_QUOTA_BYTES");
const BUCKET = sharedConstant("BUCKET_NAME");

// A tiny quota keeps every case to a few bytes of rows and objects.
const TINY_QUOTA = 1000;

const DEV_PROJECT_REF = "huhzactreblzcogqkbsd";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function isDevProject(url) {
  try {
    return new URL(url).origin === `https://${DEV_PROJECT_REF}.supabase.co`;
  } catch {
    return false;
  }
}

const canRun = anonKey !== "" && serviceRoleKey !== "" && isDevProject(supabaseUrl);
const origin = canRun ? new URL(supabaseUrl).origin : "";

// `pnpm test:live:supabase` (scripts/run-dev-live-tests.mjs) sets
// DRAFTO_LIVE_REQUIRED=1. There a skip would read as a pass, so a run that
// can't reach dev fails instead, naming the variables (never their values).
const liveRequired = process.env.DRAFTO_LIVE_REQUIRED === "1";

function missingVars() {
  const missing = [];
  if (supabaseUrl === "") missing.push("NEXT_PUBLIC_SUPABASE_URL");
  else if (!isDevProject(supabaseUrl))
    missing.push(`NEXT_PUBLIC_SUPABASE_URL (not https://${DEV_PROJECT_REF}.supabase.co)`);
  if (anonKey === "") missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (serviceRoleKey === "") missing.push("SUPABASE_SERVICE_ROLE_KEY");
  return missing;
}

if (liveRequired && !canRun) {
  it("has what it needs to run against the dev project (DRAFTO_LIVE_REQUIRED=1)", () => {
    assert.fail(
      `DRAFTO_LIVE_REQUIRED=1, but the live test can't run. Missing or wrong: ${missingVars().join(", ")}`,
    );
  });
}
const SERVICE = { key: serviceRoleKey, token: serviceRoleKey };
const ANON = { key: anonKey, token: anonKey };

/** One request. `body` is sent as JSON, `raw` ({data, type}) as-is. */
async function call(path, { method = "GET", key, token, body, raw, prefer } = {}) {
  const headers = { apikey: key, Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (raw !== undefined) headers["Content-Type"] = raw.type;
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: raw !== undefined ? raw.data : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, ok: res.ok, body: json };
}

const formatResponse = (res) => `HTTP ${res.status}: ${JSON.stringify(res.body)}`;

const createdIds = [];
// "{uid}/{noteId}" folders that may hold objects, and the objects known to exist.
const createdFolders = [];
const uploadedPaths = new Set();

/**
 * An approved user with <quota> (bytes, or null for unlimited) set through the
 * service role, signed in, with one notebook and one note.
 */
async function createUser(label, quota) {
  const email = `storage-quota-live+${label}-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
  const password = randomUUID();
  const res = await call("/auth/v1/admin/users", {
    method: "POST",
    ...SERVICE,
    body: { email, password, email_confirm: true },
  });
  assert.ok(res.ok, `create ${label}: ${formatResponse(res)}`);
  const id = res.body.id;
  createdIds.push(id);

  const fields = { is_approved: true };
  if (quota !== undefined) fields.storage_quota_bytes = quota;
  const profile = await call(`/rest/v1/profiles?id=eq.${id}`, {
    method: "PATCH",
    ...SERVICE,
    body: fields,
    prefer: "return=representation",
  });
  assert.equal(profile.status, 200, `approve ${label}: ${formatResponse(profile)}`);
  assert.equal(profile.body.length, 1, `profile of ${label} not found`);

  const session = await call("/auth/v1/token?grant_type=password", {
    method: "POST",
    ...ANON,
    body: { email, password },
  });
  assert.equal(session.status, 200, `sign in ${label}: ${formatResponse(session)}`);

  const notebook = await call("/rest/v1/notebooks", {
    method: "POST",
    ...SERVICE,
    body: { user_id: id, name: "Storage quota live test" },
    prefer: "return=representation",
  });
  assert.equal(notebook.status, 201, `notebook for ${label}: ${formatResponse(notebook)}`);
  const note = await call("/rest/v1/notes", {
    method: "POST",
    ...SERVICE,
    body: { user_id: id, notebook_id: notebook.body[0].id, title: "Storage quota live test" },
    prefer: "return=representation",
  });
  assert.equal(note.status, 201, `note for ${label}: ${formatResponse(note)}`);
  const noteId = note.body[0].id;
  createdFolders.push(`${id}/${noteId}`);

  return { id, noteId, auth: { key: anonKey, token: session.body.access_token } };
}

function attachmentRow(user, fileSize, id = randomUUID()) {
  return {
    id,
    note_id: user.noteId,
    user_id: user.id,
    file_name: "quota.txt",
    file_path: `${user.id}/${user.noteId}/quota-${id}.txt`,
    file_size: fileSize,
    mime_type: "text/plain",
  };
}

/** A plain insert, as the web confirm route does it. */
function insertAttachment(row, auth) {
  return call("/rest/v1/attachments", {
    method: "POST",
    ...auth,
    body: row,
    prefer: "return=representation",
  });
}

/** supabase-js `.upsert(rows, { onConflict: "id", ignoreDuplicates: true })`, as mobile/desktop do. */
function upsertAttachment(row, auth) {
  return call("/rest/v1/attachments?on_conflict=id", {
    method: "POST",
    ...auth,
    body: [row],
    prefer: "resolution=ignore-duplicates,return=representation",
  });
}

function rpc(name, auth, args = {}) {
  return call(`/rest/v1/rpc/${name}`, { method: "POST", ...auth, body: args });
}

async function myUsage(user) {
  const res = await rpc("get_my_storage_usage", user.auth);
  assert.equal(res.status, 200, `get_my_storage_usage: ${formatResponse(res)}`);
  assert.equal(res.body.length, 1, `get_my_storage_usage: ${formatResponse(res)}`);
  return res.body[0];
}

async function rowSizes(user) {
  const res = await call(`/rest/v1/attachments?user_id=eq.${user.id}&select=file_size`, {
    ...SERVICE,
  });
  assert.equal(res.status, 200, formatResponse(res));
  return res.body.map((r) => r.file_size).sort((a, b) => a - b);
}

/** POST adds an object (the INSERT policy); PUT overwrites one (the UPDATE policy). */
async function uploadObject(user, name, { method = "POST" } = {}) {
  const objectPath = `${user.id}/${user.noteId}/${name}`;
  const res = await call(`/storage/v1/object/${BUCKET}/${objectPath}`, {
    method,
    ...user.auth,
    raw: { data: "storage quota live test\n", type: "text/plain" },
  });
  if (res.ok) uploadedPaths.add(objectPath);
  return res;
}

// Storage answers an RLS refusal with 400 (body statusCode "403") or, on newer
// versions, 403, and the message "new row violates row-level security policy".
function assertRlsRefusal(res, what) {
  assert.ok([400, 403].includes(res.status), `${what}: ${formatResponse(res)}`);
  assert.match(JSON.stringify(res.body), /row-level security/i, `${what}: ${formatResponse(res)}`);
}

function assertQuotaRefusal(res, what) {
  assert.equal(res.status, 400, `${what}: ${formatResponse(res)}`);
  assert.equal(res.body?.code, "P0001", `${what}: ${formatResponse(res)}`);
  assert.equal(res.body?.message, STORAGE_QUOTA_EXCEEDED_CODE, `${what}: ${formatResponse(res)}`);
}

async function listFolder(folder) {
  const res = await call(`/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    ...SERVICE,
    body: { prefix: folder, limit: 100, offset: 0 },
  });
  if (!res.ok || !Array.isArray(res.body)) {
    console.warn(`[storage-quota.live] listing ${folder} failed:`, formatResponse(res));
    return [];
  }
  return res.body.filter((o) => o.id !== null).map((o) => `${folder}/${o.name}`);
}

describe(
  "per-user attachment storage quota (live, dev project)",
  {
    skip: canRun
      ? false
      : "set NEXT_PUBLIC_SUPABASE_URL (dev), NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY",
  },
  () => {
    let limited; // quota TINY_QUOTA: the attachments trigger and the upsert retry
    let uploader; // quota TINY_QUOTA: the storage policies
    let unlimited; // quota NULL, as admins have
    let plain; // the default quota, never changed

    before(
      async () => {
        limited = await createUser("limited", TINY_QUOTA);
        uploader = await createUser("uploader", TINY_QUOTA);
        unlimited = await createUser("unlimited", null);
        plain = await createUser("plain");
      },
      { timeout: 90_000 },
    );

    after(
      async () => {
        // Objects first: Supabase won't delete a user who still owns objects.
        const paths = new Set(uploadedPaths);
        for (const folder of createdFolders) {
          for (const p of await listFolder(folder)) paths.add(p);
        }
        if (paths.size > 0) {
          const res = await call(`/storage/v1/object/${BUCKET}`, {
            method: "DELETE",
            ...SERVICE,
            body: { prefixes: [...paths] },
          });
          if (!res.ok)
            console.warn("[storage-quota.live] cleanup of objects failed:", formatResponse(res));
        }
        // Deleting a user cascades to their notebooks, notes and attachment rows.
        for (const id of createdIds) {
          const res = await call(`/auth/v1/admin/users/${id}`, { method: "DELETE", ...SERVICE });
          if (!res.ok)
            console.warn(`[storage-quota.live] cleanup of ${id} failed:`, formatResponse(res));
        }
      },
      { timeout: 90_000 },
    );

    it(
      "refuses a row past the quota, allows one landing exactly on it, then refuses one more byte",
      { timeout: 30_000 },
      async () => {
        const over = await insertAttachment(attachmentRow(limited, TINY_QUOTA + 1), limited.auth);
        assertQuotaRefusal(over, "quota + 1 byte");

        const exact = await insertAttachment(attachmentRow(limited, TINY_QUOTA), limited.auth);
        assert.equal(exact.status, 201, `exactly the quota: ${formatResponse(exact)}`);

        const oneMore = await insertAttachment(attachmentRow(limited, 1), limited.auth);
        assertQuotaRefusal(oneMore, "1 byte at the quota");

        assert.deepEqual(await rowSizes(limited), [TINY_QUOTA]);
        assert.deepEqual(await myUsage(limited), {
          used_bytes: TINY_QUOTA,
          quota_bytes: TINY_QUOTA,
        });
      },
    );

    it(
      "lets the mobile/desktop upsert retry of an existing row through without counting it twice",
      { timeout: 30_000 },
      async () => {
        const [existing] = (
          await call(
            `/rest/v1/attachments?user_id=eq.${limited.id}&select=id,note_id,user_id,file_name,file_path,file_size,mime_type`,
            { ...SERVICE },
          )
        ).body;
        assert.ok(existing, "the first case left one row");

        // The user is at the quota, so this would be refused if it counted.
        const retry = await upsertAttachment(existing, limited.auth);
        assert.ok(retry.ok, `upsert retry: ${formatResponse(retry)}`);
        assert.deepEqual(retry.body, [], "ON CONFLICT DO NOTHING inserts nothing");

        assert.deepEqual(await rowSizes(limited), [TINY_QUOTA]);
        assert.equal((await myUsage(limited)).used_bytes, TINY_QUOTA);

        // A new row through the same upsert is still checked.
        const fresh = await upsertAttachment(attachmentRow(limited, 1), limited.auth);
        assertQuotaRefusal(fresh, "a new row upserted at the quota");
      },
    );

    it(
      "refuses storage uploads and overwrites once usage reaches the quota",
      { timeout: 30_000 },
      async () => {
        assert.equal((await rpc("can_store_attachment", uploader.auth)).body, true);
        const first = await uploadObject(uploader, "before.txt");
        assert.equal(first.status, 200, `upload under the quota: ${formatResponse(first)}`);

        const row = await insertAttachment(attachmentRow(uploader, TINY_QUOTA), uploader.auth);
        assert.equal(row.status, 201, `fill the quota: ${formatResponse(row)}`);
        assert.equal((await rpc("can_store_attachment", uploader.auth)).body, false);

        assertRlsRefusal(await uploadObject(uploader, "after.txt"), "upload at the quota");
        // The UPDATE policy checks the quota too, so an overwrite can't grow an object.
        assertRlsRefusal(
          await uploadObject(uploader, "before.txt", { method: "PUT" }),
          "overwrite at the quota",
        );
      },
    );

    it(
      "lets an unlimited (NULL) user add rows past the default quota and upload",
      { timeout: 30_000 },
      async () => {
        const big = await insertAttachment(
          attachmentRow(unlimited, DEFAULT_STORAGE_QUOTA_BYTES + 1),
          unlimited.auth,
        );
        assert.equal(big.status, 201, `row past the default quota: ${formatResponse(big)}`);
        assert.deepEqual(await myUsage(unlimited), {
          used_bytes: DEFAULT_STORAGE_QUOTA_BYTES + 1,
          quota_bytes: null,
        });

        assert.equal((await rpc("can_store_attachment", unlimited.auth)).body, true);
        const upload = await uploadObject(unlimited, "unlimited.txt");
        assert.equal(upload.status, 200, `unlimited upload: ${formatResponse(upload)}`);
      },
    );

    it(
      "gives a user only their own usage, and keeps the helpers, the admin RPC and their quota out of reach",
      { timeout: 30_000 },
      async () => {
        // A new profile gets the shared default.
        assert.deepEqual(await myUsage(plain), {
          used_bytes: 0,
          quota_bytes: DEFAULT_STORAGE_QUOTA_BYTES,
        });

        // The per-user helpers take any id, so the API roles must not reach them.
        for (const fn of ["storage_usage_bytes", "storage_object_bytes"]) {
          const res = await rpc(fn, plain.auth, { uid: unlimited.id });
          assert.ok([401, 403, 404].includes(res.status), `${fn}: ${formatResponse(res)}`);
        }

        const adminRpc = await rpc("admin_storage_usage", plain.auth);
        assert.equal(adminRpc.status, 403, `admin_storage_usage: ${formatResponse(adminRpc)}`);
        assert.equal(adminRpc.body?.code, "42501");

        const anon = await rpc("get_my_storage_usage", ANON);
        assert.ok([401, 403, 404].includes(anon.status), `anon usage: ${formatResponse(anon)}`);

        // The privilege guard (profile-guard covers it in full) stops a self-lift.
        const lift = await call(`/rest/v1/profiles?id=eq.${limited.id}`, {
          method: "PATCH",
          ...limited.auth,
          body: { storage_quota_bytes: null },
          prefer: "return=representation",
        });
        assert.equal(lift.status, 403, `self-lift: ${formatResponse(lift)}`);
        assert.equal(lift.body?.code, "42501");
        assert.equal((await myUsage(limited)).quota_bytes, TINY_QUOTA);
      },
    );
  },
);
