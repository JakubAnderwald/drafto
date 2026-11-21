// Live check of the per-user note content quota (ADR 0090) against the DEV
// Supabase project. It talks to GoTrue and PostgREST with plain fetch, the path
// mobile and desktop (supabase-js) and a tampering client holding the public
// anon key and their own JWT would use.
//
// What it checks, from supabase/migrations/20261121000001_per_user_content_quota.sql:
//   - the notes trigger refuses an insert or a growing update that would take
//     content usage over the quota (message `content_quota_exceeded`, with the
//     usage in `details`);
//   - a write that doesn't grow a note passes even when the user is over the
//     quota, so they can always edit down and clean up;
//   - an unlimited (NULL) user is never refused;
//   - archive_note_content() keeps a capped user's history within their quota;
//   - the API roles can read only their own usage, can't call the per-user
//     helper, the admin RPC or the storage overrun report, and can't lift their
//     own content quota.
//
// Opt-in: it runs only when NEXT_PUBLIC_SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY are exported and NEXT_PUBLIC_SUPABASE_URL's origin
// is exactly the dev project over HTTPS. The CI scripts job exports none of
// them, so it skips there, and it refuses any other project or a plain-http
// origin.
//
// Run it with `pnpm test:live:supabase -- --only content-quota`, which reads the
// keys from this machine's files and sets DRAFTO_LIVE_REQUIRED=1, so a missing
// key fails the run instead of skipping it. Every user created here is deleted
// in the `after` hook, which cascades their notes and history.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// The quota's error code and default come from packages/shared. Plain Node can't
// import that TypeScript on every supported version, so read the literals; a
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

const CONTENT_QUOTA_EXCEEDED_CODE = sharedConstant("CONTENT_QUOTA_EXCEEDED_CODE");
const DEFAULT_CONTENT_QUOTA_BYTES = sharedConstant("DEFAULT_CONTENT_QUOTA_BYTES");

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

async function call(path, { method = "GET", key, token, body, prefer } = {}) {
  const headers = { apikey: key, Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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

/** Incompressible note content of roughly `chars` bytes. */
function content(chars) {
  return {
    type: "doc",
    text: randomBytes(Math.ceil(chars / 2))
      .toString("hex")
      .slice(0, chars),
  };
}

const createdIds = [];

/** An approved, signed-in user with <quota> (bytes, null = unlimited) and one notebook. */
async function createUser(label, quota) {
  const email = `content-quota-live+${label}-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
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
  if (quota !== undefined) fields.content_quota_bytes = quota;
  await setProfile(id, fields);

  const session = await call("/auth/v1/token?grant_type=password", {
    method: "POST",
    ...ANON,
    body: { email, password },
  });
  assert.equal(session.status, 200, `sign in ${label}: ${formatResponse(session)}`);

  const notebook = await call("/rest/v1/notebooks", {
    method: "POST",
    ...SERVICE,
    body: { user_id: id, name: "Content quota live test" },
    prefer: "return=representation",
  });
  assert.equal(notebook.status, 201, `notebook for ${label}: ${formatResponse(notebook)}`);

  return {
    id,
    notebookId: notebook.body[0].id,
    auth: { key: anonKey, token: session.body.access_token },
  };
}

async function setProfile(id, fields) {
  const res = await call(`/rest/v1/profiles?id=eq.${id}`, {
    method: "PATCH",
    ...SERVICE,
    body: fields,
    prefer: "return=representation",
  });
  assert.equal(res.status, 200, `profile ${id}: ${formatResponse(res)}`);
  assert.equal(res.body.length, 1, `profile ${id} not found`);
}

function insertNote(user, body, auth = user.auth) {
  return call("/rest/v1/notes", {
    method: "POST",
    ...auth,
    body: { user_id: user.id, notebook_id: user.notebookId, title: "Quota", content: body },
    prefer: "return=representation",
  });
}

function updateNote(user, noteId, body) {
  return call(`/rest/v1/notes?id=eq.${noteId}`, {
    method: "PATCH",
    ...user.auth,
    body: { content: body },
    prefer: "return=representation",
  });
}

const rpc = (fn, auth, args = {}) =>
  call(`/rest/v1/rpc/${fn}`, { method: "POST", ...auth, body: args });

async function myUsage(user) {
  const res = await rpc("get_my_content_usage", user.auth);
  assert.equal(res.status, 200, `get_my_content_usage: ${formatResponse(res)}`);
  assert.equal(res.body.length, 1);
  return { used: Number(res.body[0].used_bytes), quota: res.body[0].quota_bytes };
}

function assertRefused(res, label) {
  assert.equal(res.status, 400, `${label}: ${formatResponse(res)}`);
  assert.equal(res.body?.code, "P0001", `${label}: ${formatResponse(res)}`);
  assert.equal(res.body?.message, CONTENT_QUOTA_EXCEEDED_CODE, `${label}: ${formatResponse(res)}`);
  assert.match(res.body?.details ?? "", /used_bytes=\d+ quota_bytes=\d+/);
}

describe(
  "per-user note content quota (dev project)",
  { skip: !canRun && !liveRequired && "dev keys not set" },
  () => {
    let limited;
    let unlimited;
    let plain;

    before(async () => {
      if (!canRun) return;
      [limited, unlimited, plain] = await Promise.all([
        createUser("limited", 2000),
        createUser("unlimited", null),
        createUser("plain"),
      ]);
    });

    after(async () => {
      for (const id of createdIds) {
        const res = await call(`/auth/v1/admin/users/${id}`, { method: "DELETE", ...SERVICE });
        if (!res.ok) console.error(`could not delete live-test user ${id}: ${formatResponse(res)}`);
      }
    });

    it(
      "refuses an insert and a growing update past the quota, and lets non-growing writes through",
      { timeout: 30_000 },
      async () => {
        const first = await insertNote(limited, content(600));
        assert.equal(first.status, 201, `first note: ${formatResponse(first)}`);
        const noteId = first.body[0].id;
        const afterFirst = await myUsage(limited);
        assert.ok(afterFirst.used >= 600, `usage counts the note: ${afterFirst.used}`);
        assert.equal(afterFirst.quota, 2000);

        assertRefused(await insertNote(limited, content(1800)), "insert past the quota");

        // An update replaces the note's content: 600 -> 1800 fits in 2000, 2500 doesn't.
        const grow = await updateNote(limited, noteId, content(1800));
        assert.equal(grow.status, 200, `growing update within the quota: ${formatResponse(grow)}`);
        assertRefused(
          await updateNote(limited, noteId, content(2500)),
          "growing update past the quota",
        );

        // Put the user over the quota, as an admin lowering it would.
        await setProfile(limited.id, { content_quota_bytes: 100 });

        const shrink = await updateNote(limited, noteId, content(50));
        assert.equal(
          shrink.status,
          200,
          `shrinking update over the quota: ${formatResponse(shrink)}`,
        );

        const title = await call(`/rest/v1/notes?id=eq.${noteId}`, {
          method: "PATCH",
          ...limited.auth,
          body: { title: "Renamed", is_trashed: true },
          prefer: "return=representation",
        });
        assert.equal(
          title.status,
          200,
          `title / trash update over the quota: ${formatResponse(title)}`,
        );

        assertRefused(
          await updateNote(limited, noteId, content(400)),
          "growing again over the quota",
        );

        const del = await call(`/rest/v1/notes?id=eq.${noteId}`, {
          method: "DELETE",
          ...limited.auth,
        });
        assert.ok([200, 204].includes(del.status), `delete over the quota: ${formatResponse(del)}`);
        assert.equal((await myUsage(limited)).used, 0);
      },
    );

    it(
      "never refuses a large compressed note over the quota for unchanged content, trash or shrinking, nor a re-sent create",
      { timeout: 30_000 },
      async () => {
        // ~100 KB of repetitive text is stored compressed (a few KB), while NEW is
        // measured uncompressed: the case that must not look like growth.
        const big = { type: "doc", text: "drafto ".repeat(15_000) };
        const user = await createUser("compressed", 500_000);
        const note = await insertNote(user, big);
        assert.equal(note.status, 201, `big note: ${formatResponse(note)}`);
        const row = note.body[0];

        // Over the quota, as an admin lowering it would put them.
        await setProfile(user.id, { content_quota_bytes: 100 });

        // Mobile and desktop send content with every update.
        const same = await call(`/rest/v1/notes?id=eq.${row.id}`, {
          method: "PATCH",
          ...user.auth,
          body: { content: big, title: "Trashed", is_trashed: true },
          prefer: "return=representation",
        });
        assert.equal(same.status, 200, `unchanged content over the quota: ${formatResponse(same)}`);

        // The re-sent create: an upsert of a row the server already has.
        const resend = await call("/rest/v1/notes?on_conflict=id", {
          method: "POST",
          ...user.auth,
          body: {
            id: row.id,
            user_id: user.id,
            notebook_id: user.notebookId,
            title: "Trashed",
            content: big,
          },
          prefer: "resolution=merge-duplicates,return=representation",
        });
        assert.ok(
          [200, 201].includes(resend.status),
          `re-sent create over the quota: ${formatResponse(resend)}`,
        );

        const shrink = await updateNote(user, row.id, {
          type: "doc",
          text: "drafto ".repeat(10_000),
        });
        assert.equal(shrink.status, 200, `shrinking a compressed note: ${formatResponse(shrink)}`);

        assertRefused(
          await updateNote(user, row.id, { type: "doc", text: "drafto ".repeat(12_000) }),
          "growing the compressed note over the quota",
        );
      },
    );

    it("never refuses an unlimited user", { timeout: 30_000 }, async () => {
      // Past a tiny quota is enough to show NULL skips the check; the default
      // quota itself is too large to write in a test.
      const res = await insertNote(unlimited, content(5000));
      assert.equal(res.status, 201, `unlimited insert: ${formatResponse(res)}`);
      assert.equal((await myUsage(unlimited)).quota, null);
    });

    it("keeps a capped user's note history within their quota", { timeout: 60_000 }, async () => {
      const capped = await createUser("history", 3000);
      const note = await insertNote(capped, content(900));
      assert.equal(note.status, 201, `history note: ${formatResponse(note)}`);
      const noteId = note.body[0].id;

      // Same-size rewrites don't grow the note, so all pass; each archives ~900 bytes.
      for (let i = 0; i < 8; i++) {
        const res = await updateNote(capped, noteId, content(900));
        assert.equal(res.status, 200, `rewrite ${i}: ${formatResponse(res)}`);
      }

      const history = await call(
        `/rest/v1/note_content_history?user_id=eq.${capped.id}&select=id`,
        SERVICE,
      );
      assert.equal(history.status, 200, `history: ${formatResponse(history)}`);
      assert.ok(history.body.length >= 1, "the newest version is kept");
      assert.ok(
        history.body.length <= 3,
        `history capped at the quota: ${history.body.length} rows`,
      );
    });

    it(
      "gives a user only their own usage, and keeps the helper, admin RPC, overrun report and their quota out of reach",
      { timeout: 30_000 },
      async () => {
        assert.deepEqual(await myUsage(plain), { used: 0, quota: DEFAULT_CONTENT_QUOTA_BYTES });

        const helper = await rpc("content_usage_bytes", plain.auth, { uid: unlimited.id });
        assert.ok(
          [401, 403, 404].includes(helper.status),
          `content_usage_bytes: ${formatResponse(helper)}`,
        );

        const overruns = await rpc("storage_quota_overruns", plain.auth);
        assert.ok(
          [401, 403, 404].includes(overruns.status),
          `storage_quota_overruns: ${formatResponse(overruns)}`,
        );

        const adminRpc = await rpc("admin_content_usage", plain.auth);
        assert.equal(adminRpc.status, 403, `admin_content_usage: ${formatResponse(adminRpc)}`);
        assert.equal(adminRpc.body?.code, "42501");

        const anon = await rpc("get_my_content_usage", ANON);
        assert.ok(
          [401, 403, 404].includes(anon.status) || (anon.status === 200 && anon.body.length === 0),
          `anon usage: ${formatResponse(anon)}`,
        );

        const lift = await call(`/rest/v1/profiles?id=eq.${plain.id}`, {
          method: "PATCH",
          ...plain.auth,
          body: { content_quota_bytes: null },
          prefer: "return=representation",
        });
        assert.equal(lift.status, 403, `self-lift: ${formatResponse(lift)}`);
        assert.equal(lift.body?.code, "42501");

        // A row filed under someone else's user_id is refused by RLS, not answered
        // with that user's usage.
        const foreign = await insertNote(limited, content(10), plain.auth);
        assert.notEqual(foreign.status, 201, `foreign insert: ${formatResponse(foreign)}`);
        assert.notEqual(foreign.body?.message, CONTENT_QUOTA_EXCEEDED_CODE);

        const service = await rpc("storage_quota_overruns", SERVICE);
        assert.equal(service.status, 200, `service overruns: ${formatResponse(service)}`);
        assert.ok(Array.isArray(service.body));
      },
    );
  },
);
