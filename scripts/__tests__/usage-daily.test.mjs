// Runs the activity-days migration (20261113000001_usage_daily.sql, ADR 0077)
// verbatim in PGlite (Postgres compiled to WASM, in process), after the two
// #820 product-metrics migrations it builds on, over stand-ins for the Supabase
// tables it reads. Unlike the dev live test (usage-daily.live.test.mjs), this
// can backdate sign-ups, saves and activity days, so it covers record_activity's
// day limits, the nightly rollup's attribution, and the week buckets and
// windows of metrics_active_users and metrics_retention.
//
// The stand-ins are the ones product-metrics.test.mjs uses, plus an auth.uid()
// that reads request.jwt.claim.sub like Supabase's does. A "signed-in user" is
// the authenticated role with that setting, inside one transaction. PGlite has
// no pg_cron, so the cron migration (20261113000002) is checked as text.
//
// History rows follow archive_note_content() (20260425000001): an overwrite
// archives the PRIOR content, archived_at = when the new content was saved,
// archived_by = the client that saved it.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationPath = (f) => path.join(REPO_ROOT, "supabase", "migrations", f);
const MIGRATIONS = [
  "20261112000001_note_text_chars.sql",
  "20261112000002_product_metrics.sql",
  "20261113000001_usage_daily.sql",
].map(migrationPath);
const CRON_MIGRATION = migrationPath("20261113000002_usage_daily_cron.sql");

const STUB_SQL = `
create role anon;
create role authenticated;
-- Supabase's service_role bypasses RLS; anon and authenticated don't.
create role service_role bypassrls;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  encrypted_password text,
  created_at timestamptz not null default now(),
  raw_app_meta_data jsonb
);
-- Supabase's auth.uid(): the JWT's sub claim, which PostgREST puts in
-- request.jwt.claim.sub; null when there is none.
create function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text,
  name text,
  metadata jsonb
);
grant select on storage.objects to service_role;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  is_approved boolean not null default false,
  is_admin boolean not null default false
);
create table public.notebooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Notebook'
);
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  notebook_id uuid not null references public.notebooks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled',
  content jsonb,
  is_trashed boolean not null default false,
  trashed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  file_size bigint not null
);
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  revoked_at timestamptz
);
create table public.note_content_history (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.notes(id) on delete cascade,
  user_id uuid not null,
  content jsonb,
  content_updated_at timestamptz not null,
  archived_at timestamptz not null default now(),
  archived_by text
);

grant select, insert, update, delete on table
  public.notebooks, public.notes, public.attachments, public.api_keys
  to authenticated, service_role;
grant select, update on table public.profiles to authenticated;
grant select, insert, update, delete on table public.profiles to service_role;
grant select on table public.note_content_history to authenticated, service_role;
`;

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** The day <n> days after <day>, both `YYYY-MM-DD` (UTC). */
const plusDays = (day, n) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** <day> (`YYYY-MM-DD`) at <hours>:<minutes>:<seconds> UTC. */
const at = (day, hours = 0, minutes = 0, seconds = 0) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + hours * HOUR + (minutes * 60 + seconds) * 1000);
const shift = (date, days, hours = 0) => new Date(date.getTime() + days * DAY + hours * HOUR);

/** BlockNote content holding <chars> characters of text. */
const contentOf = (chars) =>
  JSON.stringify([
    {
      id: "b",
      type: "paragraph",
      props: {},
      content: chars ? [{ type: "text", text: "x".repeat(chars), styles: {} }] : [],
      children: [],
    },
  ]);

async function freshDb() {
  const db = new PGlite();
  await db.exec(STUB_SQL);
  for (const file of MIGRATIONS) await db.exec(readFileSync(file, "utf8"));
  return db;
}

/** {today, w0}: the database's UTC date and this ISO week's Monday, as `YYYY-MM-DD`. */
async function anchors(db) {
  const { rows } = await db.query(
    `select (now() at time zone 'UTC')::date::text as today,
            date_trunc('week', now() at time zone 'UTC')::date::text as w0`,
  );
  return rows[0];
}

async function addUser(db, { email, createdAt, admin = false }) {
  const { rows } = await db.query(
    "insert into auth.users (email, created_at, raw_app_meta_data) values ($1, $2, $3) returning id",
    [email, createdAt.toISOString(), JSON.stringify({ provider: "email" })],
  );
  const id = rows[0].id;
  await db.query("insert into public.profiles (id, is_admin) values ($1, $2)", [id, admin]);
  const notebook = await db.query(
    "insert into public.notebooks (user_id) values ($1) returning id",
    [id],
  );
  return { id, email, notebookId: notebook.rows[0].id };
}

/**
 * A note saved as <versions> ({chars, at, client}), oldest first: created at
 * the first, holding the last, and each later save archiving the one before
 * it as a history row (archived_at = that save, archived_by = its client).
 */
async function addNote(db, user, versions) {
  const first = versions[0];
  const last = versions.at(-1);
  const { rows } = await db.query(
    `insert into public.notes (notebook_id, user_id, content, created_at, updated_at)
     values ($1, $2, $3, $4, $5) returning id`,
    [
      user.notebookId,
      user.id,
      contentOf(last.chars),
      first.at.toISOString(),
      last.at.toISOString(),
    ],
  );
  const noteId = rows[0].id;
  for (let i = 1; i < versions.length; i++) {
    await db.query(
      `insert into public.note_content_history
         (note_id, user_id, content, content_updated_at, archived_at, archived_by)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        noteId,
        user.id,
        contentOf(versions[i - 1].chars),
        versions[i - 1].at.toISOString(),
        versions[i].at.toISOString(),
        versions[i].client ?? null,
      ],
    );
  }
  return noteId;
}

/** A usage_daily row, written directly (as the superuser) to backdate it. */
const addDay = (db, user, day, client, contentChanges = 0) =>
  db.query(
    "insert into public.usage_daily (user_id, day, client, content_changes) values ($1, $2, $3, $4)",
    [user.id, day, client, contentChanges],
  );

/** Runs <sql> as <role>. */
async function asRole(db, role, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    return (await tx.query(sql, params)).rows;
  });
}

const asServiceRole = (db, sql, params) => asRole(db, "service_role", sql, params);

/** Runs <sql> as the signed-in user <userId> (null: no user), as PostgREST would. */
async function asUser(db, userId, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
    return (await tx.query(sql, params)).rows;
  });
}

/**
 * record_activity as <userId>, for the days <offsets> from today (UTC; a null
 * offset is a null day), computed in the same statement so a run across
 * midnight can't split them. Returns the function's result.
 */
async function record(db, userId, offsets, client) {
  const rows = await asUser(
    db,
    userId,
    `select public.record_activity(
       case when $1::int[] is null then null else array(
         select (now() at time zone 'UTC')::date + t.o
         from unnest($1::int[]) with ordinality as t(o, i)
         order by t.i
       ) end,
       $2
     ) as added`,
    [offsets, client],
  );
  return rows[0].added;
}

/** <user>'s rows as "<offset from today>:<client>", sorted. */
async function offsetsOf(db, userId) {
  const { rows } = await db.query(
    `select (u.day - (now() at time zone 'UTC')::date) as o, u.client
       from public.usage_daily u where u.user_id = $1`,
    [userId],
  );
  return rows.map((r) => `${r.o}:${r.client}`).sort();
}

/** Every usage_daily row of <day> as {"<email>:<client>": content_changes}. */
async function dayRows(db, day) {
  const { rows } = await db.query(
    `select u2.email, u.client, u.content_changes
       from public.usage_daily u join auth.users u2 on u2.id = u.user_id
      where u.day = $1`,
    [day],
  );
  return Object.fromEntries(rows.map((r) => [`${r.email}:${r.client}`, r.content_changes]));
}

const num = (v) => (v === null ? null : Number(v));

describe("usage_daily: table and record_activity (PGlite)", () => {
  let db;
  const users = {};

  before(async () => {
    db = await freshDb();
    const longAgo = new Date(Date.now() - 400 * DAY);
    for (const key of ["ann", "ben", "cat", "dan", "eve", "fay"]) {
      users[key] = await addUser(db, { email: `${key}@example.com`, createdAt: longAgo });
    }
  });

  after(async () => {
    await db?.close();
  });

  it("records today for the signed-in user only and returns the rows it added", async () => {
    assert.equal(await record(db, users.ann.id, [0], "web"), 1);
    assert.deepEqual(await offsetsOf(db, users.ann.id), ["0:web"]);
    assert.deepEqual(await offsetsOf(db, users.ben.id), []);
    // The same day from another client is another row.
    assert.equal(await record(db, users.ann.id, [0], "mobile-ios"), 1);
    assert.deepEqual(await offsetsOf(db, users.ann.id), ["0:mobile-ios", "0:web"]);
  });

  it("re-sending a recorded day is a no-op returning 0", async () => {
    await db.query(
      "update public.usage_daily set content_changes = 4 where user_id = $1 and client = 'web'",
      [users.ann.id],
    );
    assert.equal(await record(db, users.ann.id, [0], "web"), 0);
    const { rows } = await db.query(
      "select content_changes from public.usage_daily where user_id = $1 and client = 'web'",
      [users.ann.id],
    );
    assert.deepEqual(rows, [{ content_changes: 4 }], "an existing row is left alone");
  });

  it("drops future days, days over 30 back, null elements and duplicates", async () => {
    const added = await record(
      db,
      users.ben.id,
      [1, 7, -31, -30, null, -2, -2, 0, 0],
      "desktop-macos",
    );
    assert.equal(added, 3);
    assert.deepEqual(await offsetsOf(db, users.ben.id), [
      "-2:desktop-macos",
      "-30:desktop-macos",
      "0:desktop-macos",
    ]);
  });

  it("accepts 31 days in one call and rejects 32 without writing any", async () => {
    const days31 = Array.from({ length: 31 }, (_, i) => -i);
    assert.equal(await record(db, users.cat.id, days31, "mobile-android"), 31);
    assert.equal((await offsetsOf(db, users.cat.id)).length, 31);

    // 32 elements, even duplicates of valid days, are refused outright.
    await assert.rejects(
      record(db, users.dan.id, [...days31, 0], "web"),
      (err) => err.code === "22023" && /at most 31 days per call, got 32/.test(err.message),
    );
    assert.deepEqual(await offsetsOf(db, users.dan.id), []);
  });

  it("returns 0 and writes nothing for null or empty p_days", async () => {
    assert.equal(await record(db, users.dan.id, null, "web"), 0);
    assert.equal(await record(db, users.dan.id, [], "web"), 0);
    assert.equal(await record(db, users.dan.id, [null], "web"), 0);
    assert.deepEqual(await offsetsOf(db, users.dan.id), []);
  });

  it("rejects an unknown or null client tag", async () => {
    for (const [tag, shown] of [
      ["mobile", "mobile"],
      ["WEB", "WEB"],
      ["web-cron", "web-cron"],
      ["", ""],
      [null, "null"],
    ]) {
      await assert.rejects(
        record(db, users.dan.id, [0], tag),
        (err) => err.code === "22023" && err.message === `unknown client tag: ${shown}`,
        String(tag),
      );
    }
    assert.deepEqual(await offsetsOf(db, users.dan.id), []);
  });

  it("accepts each of the five client tags", async () => {
    for (const tag of ["web", "mobile-ios", "mobile-android", "desktop-macos", "web-mcp"]) {
      assert.equal(await record(db, users.eve.id, [0], tag), 1, tag);
    }
  });

  it("needs a signed-in user", async () => {
    await assert.rejects(
      record(db, null, [0], "web"),
      (err) => err.code === "42501" && /needs a signed-in user/.test(err.message),
    );
  });

  it("rejects a client tag the check constraint doesn't list", async () => {
    await assert.rejects(
      addDay(db, users.fay, "2026-01-01", "mobile"),
      (err) => err.code === "23514" && /usage_daily_client_check/.test(err.message),
    );
  });

  it("deletes a user's days with the user", async () => {
    const gone = await addUser(db, { email: "gone@example.com", createdAt: new Date() });
    assert.equal(await record(db, gone.id, [0, -1], "web"), 2);
    await db.query("delete from auth.users where id = $1", [gone.id]);
    assert.deepEqual(await offsetsOf(db, gone.id), []);
  });

  describe("permissions", () => {
    it("keeps the table off the Data API except for service_role, with RLS on", async () => {
      const { rows } = await db.query(
        `select
           has_table_privilege('anon', 'public.usage_daily', 'select,insert,update,delete') as anon,
           has_table_privilege('authenticated', 'public.usage_daily', 'select,insert,update,delete') as authenticated,
           has_table_privilege('service_role', 'public.usage_daily', 'select') as sr_select,
           has_table_privilege('service_role', 'public.usage_daily', 'insert') as sr_insert,
           has_table_privilege('service_role', 'public.usage_daily', 'update') as sr_update,
           has_table_privilege('service_role', 'public.usage_daily', 'delete') as sr_delete,
           (select relrowsecurity from pg_class where oid = 'public.usage_daily'::regclass) as rls,
           (select count(*)::int from pg_policies where tablename = 'usage_daily') as policies,
           exists (
             select 1 from pg_indexes
              where tablename = 'usage_daily' and indexdef like '%(day)'
           ) as day_index`,
      );
      assert.deepEqual(rows[0], {
        anon: false,
        authenticated: false,
        sr_select: true,
        sr_insert: true,
        sr_update: true,
        sr_delete: true,
        rls: true,
        policies: 0,
        day_index: true,
      });
    });

    it("denies a signed-in user reading or writing the table directly", async () => {
      for (const sql of [
        "select * from public.usage_daily",
        "insert into public.usage_daily (user_id, day, client) values (auth.uid(), current_date, 'web')",
        "update public.usage_daily set content_changes = 1",
        "delete from public.usage_daily where user_id = auth.uid()",
      ]) {
        await assert.rejects(
          asUser(db, users.fay.id, sql),
          (err) =>
            err.code === "42501" && /permission denied for table usage_daily/.test(err.message),
          sql,
        );
      }
    });

    it("lets only authenticated execute record_activity", async () => {
      for (const role of ["anon", "service_role"]) {
        await assert.rejects(
          db.transaction(async (tx) => {
            await tx.exec(`set local role ${role}`);
            await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [users.fay.id]);
            await tx.query("select public.record_activity(array[current_date], 'web')");
          }),
          (err) =>
            err.code === "42501" &&
            /permission denied for function record_activity/.test(err.message),
          role,
        );
      }
      await assert.rejects(
        asRole(db, "anon", "select * from public.usage_daily"),
        (err) => err.code === "42501",
      );
    });

    it("lets service_role upsert a day directly, as the MCP route does", async () => {
      const upsert = `insert into public.usage_daily (user_id, day, client)
                      values ($1, (now() at time zone 'UTC')::date, 'web-mcp')
                      on conflict (user_id, day, client) do nothing`;
      await asServiceRole(db, upsert, [users.fay.id]);
      await asServiceRole(db, upsert, [users.fay.id]);
      assert.deepEqual(await offsetsOf(db, users.fay.id), ["0:web-mcp"]);
    });

    it("pins search_path on every new function, with the intended owners' rights and grants", async () => {
      const expected = {
        "record_activity(date[], text)": {
          authenticated: true,
          service_role: false,
          definer: true,
        },
        "rollup_usage_daily(date)": { authenticated: false, service_role: true, definer: true },
        "metrics_cohort_activation(int)": {
          authenticated: false,
          service_role: true,
          definer: false,
        },
        "metrics_activation(int)": { authenticated: false, service_role: true, definer: false },
        "metrics_active_users(int)": { authenticated: false, service_role: true, definer: false },
        "metrics_retention(int)": { authenticated: false, service_role: true, definer: false },
      };
      for (const [fn, want] of Object.entries(expected)) {
        const { rows } = await db.query(
          `select
             has_function_privilege('anon', $1, 'execute') as anon,
             has_function_privilege('authenticated', $1, 'execute') as authenticated,
             has_function_privilege('service_role', $1, 'execute') as service_role,
             exists (
               select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                where x.grantee = 0 and x.privilege_type = 'EXECUTE'
             ) as public,
             p.prosecdef as definer,
             p.proconfig as config,
             obj_description(p.oid, 'pg_proc') is not null as commented
           from pg_proc p where p.oid = $1::regprocedure`,
          [`public.${fn}`],
        );
        assert.deepEqual(
          rows[0],
          {
            anon: false,
            public: false,
            config: ["search_path=public, pg_catalog"],
            commented: true,
            ...want,
          },
          fn,
        );
      }
      const { rows } = await db.query(
        "select obj_description('public.usage_daily'::regclass, 'pg_class') is not null as commented",
      );
      assert.equal(rows[0].commented, true);
    });
  });
});

describe("usage_daily: rollup_usage_daily (PGlite)", () => {
  let db;
  let today;
  let D; // the day rolled up explicitly: two days ago (UTC)
  const users = {};
  const result = async (sql, params) => (await asServiceRole(db, sql, params))[0].n;

  before(async () => {
    db = await freshDb();
    ({ today } = await anchors(db));
    D = plusDays(today, -2);
    const longAgo = at(plusDays(D, -40), 9);
    for (const key of ["u1", "u2", "u3", "u4", "u5", "u6"]) {
      users[key] = await addUser(db, { email: `${key}@example.com`, createdAt: longAgo });
    }
    const v = (day, hours, client, minutes = 0, seconds = 0) => ({
      chars: 10,
      at: at(day, hours, minutes, seconds),
      client,
    });
    const created = (user, day, hours) => addNote(db, user, [{ chars: 5, at: at(day, hours) }]);

    // u1 pinged from web and iOS. Overwrites on D: 3 web (both ends of the
    // day included), 2 iOS, 1 macOS (no ping from it), 1 untagged, 1 from
    // another tag; plus a note created on D. The saves just outside D don't
    // count for D.
    await addDay(db, users.u1, D, "web");
    await addDay(db, users.u1, D, "mobile-ios");
    await addDay(db, users.u1, plusDays(D, -1), "web", 7);
    await addNote(db, users.u1, [
      { chars: 10, at: longAgo },
      v(plusDays(D, -1), 23, "web", 59, 59),
      v(D, 0, "web"),
      v(D, 10, "web"),
      v(D, 12, "mobile-ios"),
      v(D, 12, "mobile-ios", 30),
      v(D, 13, "desktop-macos"),
      v(D, 14, null),
      v(D, 15, "web-cron"),
      v(D, 23, "web", 59, 59),
      v(plusDays(D, 1), 0, "web"),
    ]);
    await created(users.u1, D, 9);

    // u2 pinged from Android only: an untagged overwrite and two new notes go
    // there, and an MCP overwrite creates the web-mcp row.
    await addDay(db, users.u2, D, "mobile-android");
    await addNote(db, users.u2, [{ chars: 10, at: longAgo }, v(D, 8, null), v(D, 9, "web-mcp")]);
    await created(users.u2, D, 10);
    await created(users.u2, D, 11);

    // u3 has only untagged work on D and no row that day (only one the day
    // before), so it is dropped.
    await addDay(db, users.u3, plusDays(D, -1), "web");
    await addNote(db, users.u3, [{ chars: 10, at: longAgo }, v(D, 10, null)]);
    await created(users.u3, D, 11);

    // u4 never pinged: its MCP overwrite creates the row, which then takes
    // its untagged new note.
    await addNote(db, users.u4, [{ chars: 10, at: longAgo }, v(D, 10, "web-mcp")]);
    await created(users.u4, D, 12);

    // u5 opened the app and wrote nothing.
    await addDay(db, users.u5, D, "desktop-macos");

    // u6 pinged from Android and iOS: untagged work goes to iOS, the first in
    // the tag order (not the alphabetical first).
    await addDay(db, users.u6, D, "mobile-android");
    await addDay(db, users.u6, D, "mobile-ios");
    await addNote(db, users.u6, [{ chars: 10, at: longAgo }, v(D, 16, null)]);

    // A history row whose user no longer exists creates nothing.
    const anyNote = await addNote(db, users.u5, [{ chars: 1, at: longAgo }]);
    await db.query(
      `insert into public.note_content_history
         (note_id, user_id, content, content_updated_at, archived_at, archived_by)
       values ($1, gen_random_uuid(), null, $2, $3, 'web')`,
      [anyNote, longAgo.toISOString(), at(D, 12).toISOString()],
    );
  });

  after(async () => {
    await db?.close();
  });

  const EXPECTED_D = {
    "u1@example.com:web": 6, // 3 web + 1 untagged + 1 web-cron + 1 new note
    "u1@example.com:mobile-ios": 2,
    "u1@example.com:desktop-macos": 1,
    "u2@example.com:mobile-android": 3, // 1 untagged + 2 new notes
    "u2@example.com:web-mcp": 1,
    "u4@example.com:web-mcp": 2, // 1 MCP + 1 new note
    "u5@example.com:desktop-macos": 0,
    "u6@example.com:mobile-android": 0,
    "u6@example.com:mobile-ios": 1,
  };

  it("counts each tagged client's overwrites and puts untagged work on the first row", async () => {
    assert.equal(await result("select public.rollup_usage_daily($1) as n", [D]), 7);
    assert.deepEqual(await dayRows(db, D), EXPECTED_D);
  });

  it("leaves every other day alone", async () => {
    assert.deepEqual(await dayRows(db, plusDays(D, -1)), {
      "u1@example.com:web": 7,
      "u3@example.com:web": 0,
    });
    assert.deepEqual(await dayRows(db, plusDays(D, 1)), {});
  });

  it("gives the same result when run again", async () => {
    assert.equal(await result("select public.rollup_usage_daily($1) as n", [D]), 7);
    assert.deepEqual(await dayRows(db, D), EXPECTED_D);
  });

  it("converges after the day's counts were changed or a created row removed", async () => {
    await db.query("update public.usage_daily set content_changes = 50 where day = $1", [D]);
    await db.query(
      "delete from public.usage_daily where day = $1 and user_id = $2 and client = 'desktop-macos'",
      [D, users.u1.id],
    );
    assert.equal(await result("select public.rollup_usage_daily($1) as n", [D]), 7);
    assert.deepEqual(await dayRows(db, D), EXPECTED_D);
  });

  it("rolls up yesterday (UTC) by default", async () => {
    const yesterday = plusDays(today, -1);
    assert.equal(yesterday, plusDays(D, 1));
    // u1's web overwrite at 00:00 yesterday creates its web row.
    assert.equal(await result("select public.rollup_usage_daily() as n"), 1);
    assert.deepEqual(await dayRows(db, yesterday), { "u1@example.com:web": 1 });
    assert.deepEqual(await dayRows(db, D), EXPECTED_D);
  });

  it("deletes rows older than 13 months", async () => {
    const cutoffSql = "((now() at time zone 'UTC')::date - interval '13 months')::date";
    await db.query(
      `insert into public.usage_daily (user_id, day, client) values
         ($1, ${cutoffSql} - 1, 'web'),
         ($1, ${cutoffSql}, 'web'),
         ($1, ${cutoffSql} - 400, 'mobile-ios')`,
      [users.u5.id],
    );
    await asServiceRole(db, "select public.rollup_usage_daily($1)", [D]);
    const { rows } = await db.query(
      `select (u.day - ${cutoffSql})::int as from_cutoff, u.client
         from public.usage_daily u
        where u.user_id = $1 and u.day < (now() at time zone 'UTC')::date - 60`,
      [users.u5.id],
    );
    assert.deepEqual(rows, [{ from_cutoff: 0, client: "web" }]);
  });

  it("rejects a null p_day", async () => {
    await assert.rejects(
      asServiceRole(db, "select public.rollup_usage_daily(null)"),
      (err) => err.code === "22023" && /p_day must be a date/.test(err.message),
    );
  });

  it("can't be run by anon or authenticated", async () => {
    for (const role of ["anon", "authenticated"]) {
      await assert.rejects(
        asRole(db, role, "select public.rollup_usage_daily($1)", [D]),
        (err) =>
          err.code === "42501" &&
          /permission denied for function rollup_usage_daily/.test(err.message),
        role,
      );
    }
  });
});

describe("usage_daily: metrics_active_users (PGlite)", () => {
  let db;
  let w0;
  let today;
  const week = (k) => plusDays(w0, -7 * k);

  before(async () => {
    db = await freshDb();
    ({ w0, today } = await anchors(db));
    const longAgo = at(plusDays(w0, -400));
    const u = {};
    for (const key of ["u1", "u2", "u3"]) {
      u[key] = await addUser(db, { email: `${key}@example.com`, createdAt: longAgo });
    }
    const admin = await addUser(db, {
      email: "admin@example.com",
      createdAt: longAgo,
      admin: true,
    });
    const listed = await addUser(db, { email: "listed@example.com", createdAt: longAgo });
    await db.query("insert into public.metrics_excluded_users (user_id) values ($1)", [listed.id]);

    // Last week: u1 on two clients (one day with changes), u2 on Sunday, u3
    // over MCP with a change; the admin and the listed user don't count.
    await addDay(db, u.u1, week(1), "web", 2);
    await addDay(db, u.u1, plusDays(week(1), 3), "mobile-ios");
    await addDay(db, u.u2, plusDays(week(1), 6), "web");
    await addDay(db, u.u3, plusDays(week(1), 2), "web-mcp", 1);
    await addDay(db, admin, plusDays(week(1), 1), "web", 5);
    await addDay(db, listed, plusDays(week(1), 1), "desktop-macos", 3);
    // This week (Monday): u2 on Android.
    await addDay(db, u.u2, week(0), "mobile-android");
    // Three weeks ago: u1 on two days, once.
    await addDay(db, u.u1, week(3), "web");
    await addDay(db, u.u1, plusDays(week(3), 1), "web", 4);
    // Before the window asked for.
    await addDay(db, u.u3, week(4), "web");
  });

  after(async () => {
    await db?.close();
  });

  it("counts active users, writers and active users per client, per ISO week", async () => {
    const rows = await asServiceRole(
      db,
      `select week_start::text as w, iso_week, active_users, writers, by_client, week_complete
         from public.metrics_active_users(4)`,
    );
    assert.deepEqual(
      rows.map((r) => r.w),
      [week(3), week(2), week(1), week(0)],
    );
    const byWeek = Object.fromEntries(rows.map((r) => [r.w, r]));
    const expect = (k, activeUsers, writers, byClient, complete) => {
      const row = byWeek[week(k)];
      assert.deepEqual(
        [row.active_users, row.writers, row.by_client, row.week_complete],
        [activeUsers, writers, byClient, complete],
        `week ${k}`,
      );
      assert.match(row.iso_week, /^\d{4}-W\d{2}$/);
    };
    expect(3, 1, 1, { web: 1 }, true);
    expect(2, 0, 0, {}, true);
    expect(1, 3, 2, { web: 2, "mobile-ios": 1, "web-mcp": 1 }, true);
    expect(0, 1, 0, { "mobile-android": 1 }, false);
    assert.ok(week(0) <= today);
  });

  it("rejects a bad p_weeks", async () => {
    for (const bad of [0, 521, null]) {
      await assert.rejects(
        asServiceRole(db, "select * from public.metrics_active_users($1)", [bad]),
        (err) => err.code === "22023" && /p_weeks must be between 1 and 520/.test(err.message),
        String(bad),
      );
    }
  });
});

describe("usage_daily: metrics_retention and metrics_cohort_activation (PGlite)", () => {
  let db;
  let w0;
  const users = {};
  const week = (k) => plusDays(w0, -7 * k);
  // A sign-up on the Tuesday of week(k), 02:00 UTC; its UTC day.
  const signupOf = (k) => at(plusDays(week(k), 1), 2);
  const signupDay = (k) => plusDays(week(k), 1);

  /** A user who signs up in week(k) and activates, reaches first value only, or neither. */
  async function cohortUser(key, k, { reaches = "activation", admin = false, active = [] } = {}) {
    const signup = signupOf(k);
    const user = await addUser(db, { email: `${key}@example.com`, createdAt: signup, admin });
    if (reaches === "activation") {
      await addNote(db, user, [
        { chars: 60, at: shift(signup, 0, 1) },
        { chars: 70, at: shift(signup, 3), client: "web" },
      ]);
    } else if (reaches === "first value") {
      await addNote(db, user, [
        { chars: 60, at: shift(signup, 0, 1) },
        { chars: 80, at: shift(signup, 0, 5), client: "web" },
      ]);
    } else {
      await addNote(db, user, [{ chars: 20, at: shift(signup, 0, 1) }]);
    }
    for (const offset of active) await addDay(db, user, plusDays(signupDay(k), offset), "web");
    users[key] = user;
  }

  before(async () => {
    db = await freshDb();
    ({ w0 } = await anchors(db));
    // Tracking started long before every window below.
    const tracker = await addUser(db, { email: "tracker@example.com", createdAt: at(week(30)) });
    await addDay(db, tracker, week(9), "web");

    // Week 6: both windows closed. a6 is back on day 7 and day 28, b6 only on
    // the days just outside (6, 14, 27, 35), c6 on day 13 and day 34. d6 never
    // activated and e6 is an admin, so neither counts.
    await cohortUser("a6", 6, { active: [7, 28] });
    await cohortUser("b6", 6, { active: [6, 14, 27, 35] });
    await cohortUser("c6", 6, { active: [13, 34] });
    await cohortUser("d6", 6, { reaches: "first value", active: [7, 28] });
    await cohortUser("e6", 6, { admin: true, active: [7, 28] });
    // Week 4: week 1 closed, week 4 open; nobody activated.
    await cohortUser("i4", 4, { reaches: "nothing", active: [7] });
    // Week 3: week 1 closed, week 4 open; one of three back in week 1.
    await cohortUser("f3", 3, { active: [7, 28] });
    await cohortUser("g3", 3);
    await cohortUser("h3", 3);
    // Week 1: week 1 still open.
    await cohortUser("j1", 1, { active: [7] });
    // Week 8: activation can no longer be counted (history kept 30 days).
    await cohortUser("k8", 8, { active: [7, 28] });
  });

  after(async () => {
    await db?.close();
  });

  async function retention() {
    const rows = await asServiceRole(
      db,
      `select week_start::text as w, iso_week, activated, active_week1, pct_week1,
              active_week4, pct_week4
         from public.metrics_retention(9)`,
    );
    return Object.fromEntries(
      rows.map((r) => [
        r.w,
        [r.activated, r.active_week1, num(r.pct_week1), r.active_week4, num(r.pct_week4)],
      ]),
    );
  }

  it("counts activated users active again in week 1 (days 7-13) and week 4 (days 28-34)", async () => {
    const byWeek = await retention();
    assert.equal(Object.keys(byWeek).length, 9);
    assert.deepEqual(byWeek[week(6)], [3, 2, 66.7, 2, 66.7]);
    assert.deepEqual(byWeek[week(3)], [3, 1, 33.3, null, null]);
  });

  it("is null while a window is open, when activated is null or 0, and 0 for an empty cohort", async () => {
    const byWeek = await retention();
    // Week 4's week-1 window closed with nobody activated: 0, but no percentage.
    assert.deepEqual(byWeek[week(4)], [0, 0, null, null, null]);
    assert.deepEqual(byWeek[week(1)], [1, null, null, null, null]);
    assert.deepEqual(byWeek[week(8)], [null, null, null, null, null]);
    // The current week: nobody signed up, every window open.
    assert.deepEqual(byWeek[week(0)], [0, null, null, null, null]);
  });

  it("reports the same activated count as metrics_activation", async () => {
    const activation = await asServiceRole(
      db,
      "select week_start::text as w, activated from public.metrics_activation(9)",
    );
    const byWeek = await retention();
    for (const { w, activated } of activation) assert.equal(byWeek[w][0], activated, w);
  });

  it("metrics_cohort_activation lists each non-excluded user with their flags", async () => {
    const rows = await asServiceRole(
      db,
      `select c.user_id, c.week_start::text as w, c.signed_up_at, c.first_value, c.activated
         from public.metrics_cohort_activation(9) c`,
    );
    const keyOf = (id) => Object.keys(users).find((k) => users[k].id === id);
    // Oldest week first; a week's users all sign up at the same time, so sort
    // them by name.
    const listed = rows.map((r) => [keyOf(r.user_id), r.w, r.first_value, r.activated]);
    const byWeekThenName = (x, y) => (x[1] === y[1] ? (x[0] < y[0] ? -1 : 1) : 0);
    assert.deepEqual([...listed].sort(byWeekThenName), [
      ["k8", week(8), true, true],
      ["a6", week(6), true, true],
      ["b6", week(6), true, true],
      ["c6", week(6), true, true],
      ["d6", week(6), true, false],
      ["i4", week(4), false, false],
      ["f3", week(3), true, true],
      ["g3", week(3), true, true],
      ["h3", week(3), true, true],
      ["j1", week(1), true, true],
    ]);
    assert.deepEqual(
      listed.map((r) => r[1]),
      [...listed.map((r) => r[1])].sort(),
      "oldest week first",
    );
    const k8 = rows.find((r) => r.user_id === users.k8.id);
    assert.equal(k8.signed_up_at.getTime(), signupOf(8).getTime());
  });

  it("can't be run by anon or authenticated", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const fn of [
        "metrics_retention(1)",
        "metrics_active_users(1)",
        "metrics_cohort_activation(1)",
      ]) {
        await assert.rejects(
          asRole(db, role, `select * from public.${fn}`),
          (err) => err.code === "42501",
          `${role}: ${fn}`,
        );
      }
    }
  });
});

describe("usage_daily: metrics_retention before and at the start of tracking (PGlite)", () => {
  let db;
  let w0;
  let user;
  let tracker;
  const week = (k) => plusDays(w0, -7 * k);
  const signupDay = () => plusDays(week(6), 1);

  before(async () => {
    db = await freshDb();
    ({ w0 } = await anchors(db));
    const signup = at(signupDay(), 2);
    user = await addUser(db, { email: "l6@example.com", createdAt: signup });
    await addNote(db, user, [
      { chars: 60, at: shift(signup, 0, 1) },
      { chars: 70, at: shift(signup, 3), client: "web" },
    ]);
    tracker = await addUser(db, { email: "tracker@example.com", createdAt: at(week(30)) });
  });

  after(async () => {
    await db?.close();
  });

  async function week6() {
    const rows = await asServiceRole(
      db,
      `select activated, active_week1, pct_week1, active_week4, pct_week4
         from public.metrics_retention(9) where week_start = $1::date`,
      [week(6)],
    );
    const r = rows[0];
    return [r.activated, r.active_week1, num(r.pct_week1), r.active_week4, num(r.pct_week4)];
  }

  const setTrackingStart = async (day) => {
    await db.query("delete from public.usage_daily where user_id = $1", [tracker.id]);
    if (day) await addDay(db, tracker, day, "web");
  };

  it("is null while usage_daily is empty", async () => {
    assert.deepEqual(await week6(), [1, null, null, null, null]);
  });

  it("is null for a window that started before the oldest usage_daily row", async () => {
    // The user is back on day 13 and day 34; the oldest row is day 13, after
    // the cohort's earliest week-1 window start (week start + 7).
    await addDay(db, user, plusDays(signupDay(), 13), "web");
    await addDay(db, user, plusDays(signupDay(), 34), "mobile-ios");
    assert.deepEqual(await week6(), [1, null, null, 1, 100]);
    // Tracking from week start + 7 exactly: counted.
    await setTrackingStart(plusDays(week(6), 7));
    assert.deepEqual(await week6(), [1, 1, 100, 1, 100]);
    // From a day later: not.
    await setTrackingStart(plusDays(week(6), 8));
    assert.deepEqual(await week6(), [1, null, null, 1, 100]);
  });

  it("applies the same rule to week 4 (week start + 28)", async () => {
    await db.query("delete from public.usage_daily where user_id = $1 and client = 'web'", [
      user.id,
    ]);
    await setTrackingStart(plusDays(week(6), 29));
    assert.deepEqual(await week6(), [1, null, null, null, null]);
    // From week start + 28 exactly: week 4 is counted, week 1 still predates it.
    await setTrackingStart(plusDays(week(6), 28));
    assert.deepEqual(await week6(), [1, null, null, 1, 100]);
  });
});

describe("usage_daily: nightly cron job (20261113000002)", () => {
  const sql = readFileSync(CRON_MIGRATION, "utf8");

  it("schedules rollup-usage-daily at 00:30 UTC, calling rollup_usage_daily()", () => {
    assert.match(
      sql,
      /select cron\.schedule\(\s*'rollup-usage-daily',\s*'30 0 \* \* \*',\s*\$\$select public\.rollup_usage_daily\(\)\$\$\s*\);/,
    );
    assert.match(sql, /create extension if not exists pg_cron/);
  });

  it("unschedules the job first, swallowing the error when it doesn't exist", () => {
    assert.match(
      sql,
      /do \$\$\s*begin\s*perform cron\.unschedule\('rollup-usage-daily'\);\s*exception when others then/,
    );
  });

  it("keeps cron out of the main migration, so it runs verbatim here", () => {
    const main = readFileSync(MIGRATIONS.at(-1), "utf8");
    assert.doesNotMatch(main, /\bcron\.\w+\s*\(/);
  });
});
