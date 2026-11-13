// Runs both product-metrics migrations (ADR 0075) verbatim in PGlite
// (Postgres compiled to WASM, in process) over stand-ins for the Supabase
// tables they read, and checks each metric against hand-built data. Unlike the
// dev live test (product-metrics.live.test.mjs), this can backdate sign-ups and
// saves, so it covers the week buckets, the 14-day window, the retention nulls
// and the 24-hour emptying rule.
//
// The activity-days migration (20261113000003_usage_daily.sql, ADR 0080) runs
// after them, because it re-creates metrics_activation over the per-user
// metrics_cohort_activation: every activation case below runs against that
// definition. Its own functions are tested in usage-daily.test.mjs.
//
// The stand-ins carry only the columns the functions read, with the grants the
// real projects give the API roles (20261020000001_explicit_data_api_grants.sql,
// and Supabase's own on storage.objects). auth.users gets no grant here, so the
// migration's own column grant is what lets service_role read it. Every metric
// is called as service_role, the only role allowed to.
//
// History rows follow archive_note_content() (20260425000001): an overwrite
// archives the PRIOR content, stamped content_updated_at = its updated_at,
// archived_at = when the new content was saved, archived_by = the client that
// saved the new content.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = [
  "20261112000001_note_text_chars.sql",
  "20261112000002_product_metrics.sql",
  "20261113000003_usage_daily.sql",
].map((f) => path.join(REPO_ROOT, "supabase", "migrations", f));

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
-- Supabase's auth.uid(), which record_activity (20261113000003) reads.
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
const shift = (date, days, hours = 0) => new Date(date.getTime() + days * DAY + hours * HOUR);

/** BlockNote content holding <n> characters of text; null for SQL null. */
function contentOf(version) {
  if (version.content !== undefined) return version.content;
  return [
    {
      id: "b",
      type: "paragraph",
      props: {},
      content: version.chars ? [{ type: "text", text: "x".repeat(version.chars), styles: {} }] : [],
      children: [],
    },
  ];
}

const jsonParam = (value) => (value === null ? null : JSON.stringify(value));

async function freshDb({ beforeMigrations } = {}) {
  const db = new PGlite();
  await db.exec(STUB_SQL);
  if (beforeMigrations) await beforeMigrations(db);
  for (const file of MIGRATIONS) await db.exec(readFileSync(file, "utf8"));
  return db;
}

/** {now, w0}: the database's now() and the Monday 00:00 UTC of this ISO week. */
async function anchors(db) {
  const { rows } = await db.query(
    "select now() as now, date_trunc('week', now() at time zone 'UTC') at time zone 'UTC' as w0",
  );
  return { now: rows[0].now, w0: rows[0].w0 };
}

async function addUser(db, { email, createdAt, provider = "email", admin = false }) {
  const meta = provider === null ? {} : { provider, providers: [provider] };
  const { rows } = await db.query(
    "insert into auth.users (email, created_at, raw_app_meta_data) values ($1, $2, $3) returning id",
    [email, createdAt.toISOString(), JSON.stringify(meta)],
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
 * A note saved as <versions> ({chars} or {content}, at, client), oldest first:
 * the note holds the last one, and each earlier one is the history row the
 * next save archived. Trashing (a non-content update) moves updated_at.
 */
async function addNote(db, user, versions, { trashedAt = null } = {}) {
  const first = versions[0];
  const last = versions.at(-1);
  const { rows } = await db.query(
    `insert into public.notes
       (notebook_id, user_id, content, created_at, updated_at, is_trashed, trashed_at)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      user.notebookId,
      user.id,
      jsonParam(contentOf(last)),
      first.at.toISOString(),
      (trashedAt ?? last.at).toISOString(),
      trashedAt !== null,
      trashedAt?.toISOString() ?? null,
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
        jsonParam(contentOf(versions[i - 1])),
        versions[i - 1].at.toISOString(),
        versions[i].at.toISOString(),
        versions[i].client ?? null,
      ],
    );
  }
  return noteId;
}

/** Runs <sql> as service_role, the only role the metrics are granted to. */
async function asServiceRole(db, sql, params = []) {
  await db.exec("set role service_role");
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

const isoDay = (date) => date.toISOString().slice(0, 10);

describe("product metrics: excluded accounts, sign-ups, activation and writers (PGlite)", () => {
  let db;
  let a; // anchors
  let week; // week(k): the Monday k weeks before this one
  let users;

  before(async () => {
    users = {};
    db = await freshDb({
      // The seed looks the test accounts up by email, so they must exist first.
      beforeMigrations: async (d) => {
        const { w0 } = await anchors(d);
        const w2 = shift(w0, -14);
        for (const [key, email] of [
          ["e2e", "e2e-test@drafto.eu"],
          ["gplay", "GooglePlay-Test@drafto.eu"],
        ]) {
          users[key] = await addUser(d, { email, createdAt: shift(w2, 1) });
          const s = shift(w2, 1);
          await addNote(d, users[key], [
            { chars: 60, at: shift(s, 0, 1) },
            { chars: 70, at: shift(s, 3), client: "web" },
          ]);
        }
      },
    });
    a = await anchors(db);
    week = (k) => shift(a.w0, -7 * k);
    const activating = (signup) => [
      { chars: 60, at: shift(signup, 0, 1) },
      { chars: 70, at: shift(signup, 3), client: "web" },
    ];

    const add = async (key, opts, notes = []) => {
      users[key] = await addUser(db, { email: `${key}@example.com`, ...opts });
      for (const versions of notes) await addNote(db, users[key], versions);
    };
    // Week 2: one activates, one only reaches first value, one writes too little.
    await add("alice", { createdAt: shift(week(2), 1) }, [activating(shift(week(2), 1))]);
    await add("bob", { createdAt: shift(week(2), 2), provider: "google" }, [
      [
        { chars: 60, at: shift(week(2), 2, 1) },
        { chars: 80, at: shift(week(2), 2, 5), client: "mobile-ios" },
      ],
    ]);
    await add("carol", { createdAt: shift(week(2), 3), provider: "apple" }, [
      [
        { chars: 20, at: shift(week(2), 3, 1) },
        { chars: 30, at: shift(week(2), 5), client: "web" },
      ],
    ]);
    // An admin and a listed account, both of whom would activate.
    await add("dave", { createdAt: shift(week(2), 1), admin: true }, [
      activating(shift(week(2), 1)),
    ]);
    await add("erin", { createdAt: shift(week(2), 1) }, [activating(shift(week(2), 1))]);
    await db.query(
      "insert into public.metrics_excluded_users (user_id, reason) values ($1, 'test')",
      [users.erin.id],
    );
    // Week 4: writes only after the 14-day window, in week 2.
    await add("frank", { createdAt: shift(week(4), 1) }, [
      [
        { chars: 60, at: shift(week(4), 16) },
        { chars: 70, at: shift(week(4), 17), client: "desktop-macos" },
      ],
    ]);
    // Weeks 6 and 8 both activate; week 8's window is past the history retention.
    await add("hank", { createdAt: shift(week(6), 1), provider: null }, [
      activating(shift(week(6), 1)),
    ]);
    await add("gina", { createdAt: shift(week(8), 1) }, [activating(shift(week(8), 1))]);
    // Week 1: a new note never overwritten (55 chars), and one created empty
    // whose only overwrite came over MCP.
    await add("jack", { createdAt: shift(week(1), 1) }, [[{ chars: 55, at: shift(week(1), 1) }]]);
    await add("kate", { createdAt: shift(week(1), 2) }, [
      [
        { content: null, at: shift(week(1), 2) },
        { chars: 5, at: shift(week(1), 2, 1), client: "web-mcp" },
      ],
    ]);
    // This week: halfway between Monday 00:00 and now.
    await add("ivy", { createdAt: new Date((a.w0.getTime() + a.now.getTime()) / 2) });
  });

  after(async () => {
    await db?.close();
  });

  it("seeds the test accounts that exist, by email, case-insensitively", async () => {
    const rows = (
      await db.query(
        `select u.email, e.reason from public.metrics_excluded_users e
           join auth.users u on u.id = e.user_id`,
      )
    ).rows.sort((x, y) => (x.email < y.email ? -1 : 1));
    // appreview@drafto.eu has no account here, so it is skipped.
    assert.deepEqual(rows, [
      { email: "GooglePlay-Test@drafto.eu", reason: "test account: Google Play review" },
      { email: "e2e-test@drafto.eu", reason: "test account: web and native E2E runs" },
      { email: "erin@example.com", reason: "test" },
    ]);
  });

  it("excludes admins and listed users, once each", async () => {
    const rows = await asServiceRole(
      db,
      "select user_id from public.metrics_excluded_user_ids() order by user_id",
    );
    const expected = [users.dave.id, users.erin.id, users.e2e.id, users.gplay.id].sort();
    assert.deepEqual(
      rows.map((r) => r.user_id),
      expected,
    );
  });

  it("lists the last p_weeks Mondays, oldest first, and rejects a bad p_weeks", async () => {
    const rows = await asServiceRole(
      db,
      "select week_start::text as w from public.metrics_week_starts(3)",
    );
    assert.deepEqual(
      rows.map((r) => r.w),
      [isoDay(week(2)), isoDay(week(1)), isoDay(week(0))],
    );
    for (const bad of [0, -1, 521, null]) {
      await assert.rejects(
        asServiceRole(db, "select * from public.metrics_signups($1)", [bad]),
        (err) => err.code === "22023" && /p_weeks must be between 1 and 520/.test(err.message),
        String(bad),
      );
    }
  });

  it("metrics_signups counts new accounts per ISO week, by provider", async () => {
    const rows = await asServiceRole(
      db,
      "select week_start::text as w, iso_week, signups, by_provider from public.metrics_signups(9)",
    );
    assert.equal(rows.length, 9);
    const byWeek = Object.fromEntries(rows.map((r) => [r.w, r]));
    const expect = (k, signups, byProvider) => {
      const row = byWeek[isoDay(week(k))];
      assert.ok(row, `week ${k}`);
      assert.equal(row.signups, signups, `week ${k}`);
      assert.deepEqual(row.by_provider, byProvider, `week ${k}`);
    };
    expect(8, 1, { email: 1 });
    expect(7, 0, {});
    expect(6, 1, { unknown: 1 });
    expect(4, 1, { email: 1 });
    expect(2, 3, { email: 1, google: 1, apple: 1 });
    expect(1, 2, { email: 2 });
    expect(0, 1, { email: 1 });
    assert.match(byWeek[isoDay(week(0))].iso_week, /^\d{4}-W\d{2}$/);
    assert.equal(rows.at(-1).w, isoDay(week(0)));
  });

  it("metrics_activation counts first value and activation per cohort", async () => {
    const rows = await asServiceRole(
      db,
      `select week_start::text as w, signed_up, first_value, activated, window_complete
         from public.metrics_activation(9)`,
    );
    const byWeek = Object.fromEntries(rows.map((r) => [r.w, r]));
    const expect = (k, signedUp, firstValue, activated) => {
      const row = byWeek[isoDay(week(k))];
      assert.deepEqual(
        [row.signed_up, row.first_value, row.activated],
        [signedUp, firstValue, activated],
        `week ${k}`,
      );
      return row;
    };
    // alice activates; bob's two versions share a day; carol stays under 50.
    assert.equal(expect(2, 3, 2, 1).window_complete, false);
    // frank wrote only after day 14.
    assert.equal(expect(4, 1, 0, 0).window_complete, true);
    expect(6, 1, 1, 1);
    // Week 8's window ended more than 30 days ago: activated is unknown.
    assert.equal(expect(8, 1, 1, null).window_complete, true);
    // jack's single 55-character note is first value; kate's 5 characters aren't.
    expect(1, 2, 1, 0);
    expect(3, 0, 0, 0);
  });

  it("metrics_writers counts distinct writers per week and per client", async () => {
    const rows = await asServiceRole(
      db,
      `select week_start::text as w, writers, by_client, history_complete
         from public.metrics_writers(6)`,
    );
    assert.equal(rows.length, 6);
    const byWeek = Object.fromEntries(rows.map((r) => [r.w, r]));
    // alice, bob, carol (overwrite only) and frank; the admin, the listed user
    // and the test accounts don't count.
    assert.equal(byWeek[isoDay(week(2))].writers, 4);
    assert.deepEqual(byWeek[isoDay(week(2))].by_client, {
      untagged: 3,
      web: 2,
      "mobile-ios": 1,
      "desktop-macos": 1,
    });
    assert.equal(byWeek[isoDay(week(2))].history_complete, true);
    // jack's new note, and kate's overwrite of a note created empty (any size counts).
    assert.equal(byWeek[isoDay(week(1))].writers, 2);
    assert.deepEqual(byWeek[isoDay(week(1))].by_client, { untagged: 1, "web-mcp": 1 });
    assert.equal(byWeek[isoDay(week(4))].writers, 0);
    assert.deepEqual(byWeek[isoDay(week(4))].by_client, {});
    assert.equal(byWeek[isoDay(week(5))].history_complete, false);
    assert.equal(byWeek[isoDay(week(3))].history_complete, true);
  });

  it("lets service_role read only the auth.users columns the metrics use", async () => {
    await assert.rejects(
      asServiceRole(db, "select email from auth.users limit 1"),
      (err) => err.code === "42501",
    );
    await assert.rejects(
      asServiceRole(db, "select encrypted_password from auth.users limit 1"),
      (err) => err.code === "42501",
    );
  });

  describe("permissions", () => {
    // SECURITY INVOKER, service_role only.
    const FUNCTIONS = [
      "note_text_chars(jsonb)",
      "metrics_excluded_user_ids()",
      "metrics_week_starts(int)",
      "metrics_write_events(timestamptz, timestamptz)",
      "metrics_signups(int)",
      "metrics_activation(int)",
      "metrics_writers(int)",
      "metrics_emptied_notes(timestamptz, timestamptz)",
      "metrics_depth()",
      "metrics_platform_limits()",
      "metrics_cohort_activation(int)",
      "metrics_active_users(int)",
      "metrics_retention(int)",
    ];
    // The activity-days writers (20261113000003): SECURITY DEFINER, since
    // neither caller may write usage_daily itself. record_activity is for
    // signed-in users only; the rollup for service_role (and pg_cron).
    const DEFINER_FUNCTIONS = {
      "record_activity(date[], text)": { authenticated: true, service_role: false },
      "rollup_usage_daily(date)": { authenticated: false, service_role: true },
    };

    async function privileges(fn) {
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
           p.proconfig as config
         from pg_proc p where p.oid = $1::regprocedure`,
        [`public.${fn}`],
      );
      return rows[0];
    }

    it("lets only service_role execute every metrics function", async () => {
      for (const fn of FUNCTIONS) {
        assert.deepEqual(
          await privileges(fn),
          {
            anon: false,
            authenticated: false,
            service_role: true,
            public: false,
            definer: false,
            config: ["search_path=public, pg_catalog"],
          },
          fn,
        );
      }
    });

    it("runs the activity-days writers as definer, each for its one caller", async () => {
      for (const [fn, callers] of Object.entries(DEFINER_FUNCTIONS)) {
        assert.deepEqual(
          await privileges(fn),
          {
            anon: false,
            public: false,
            definer: true,
            config: ["search_path=public, pg_catalog"],
            ...callers,
          },
          fn,
        );
      }
    });

    it("creates no other public function", async () => {
      const oids = async (sql, params) => (await db.query(sql, params)).rows.map((r) => r.oid);
      const created = await oids(
        `select p.oid::text as oid from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
      );
      const listed = [];
      for (const fn of [...FUNCTIONS, ...Object.keys(DEFINER_FUNCTIONS)]) {
        listed.push(...(await oids("select $1::regprocedure::oid::text as oid", [`public.${fn}`])));
      }
      assert.deepEqual(created.sort(), listed.sort());
    });

    it("denies anon and authenticated the functions and the exclusion table", async () => {
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`set role ${role}`);
        try {
          for (const sql of [
            "select * from public.metrics_depth()",
            "select * from public.metrics_signups(1)",
            "select * from public.metrics_active_users(1)",
            "select * from public.metrics_retention(1)",
            "select public.note_text_chars('{}'::jsonb)",
            "select * from public.metrics_excluded_users",
          ]) {
            await assert.rejects(db.query(sql), (err) => err.code === "42501", `${role}: ${sql}`);
          }
        } finally {
          await db.exec("reset role");
        }
      }
      const { rows } = await db.query(
        `select
           has_table_privilege('anon', 'public.metrics_excluded_users', 'select,insert,update,delete') as anon,
           has_table_privilege('authenticated', 'public.metrics_excluded_users', 'select,insert,update,delete') as authenticated,
           has_table_privilege('service_role', 'public.metrics_excluded_users', 'select') as service_role,
           (select relrowsecurity from pg_class where oid = 'public.metrics_excluded_users'::regclass) as rls`,
      );
      assert.deepEqual(rows[0], {
        anon: false,
        authenticated: false,
        service_role: true,
        rls: true,
      });
    });
  });
});

describe("product metrics: metrics_emptied_notes (PGlite)", () => {
  let db;
  let now;
  const notes = {};

  before(async () => {
    db = await freshDb();
    ({ now } = await anchors(db));
    const ago = (days, hours = 0) => shift(now, -days, -hours);
    const user = await addUser(db, { email: "writer@example.com", createdAt: ago(60) });
    const admin = await addUser(db, {
      email: "admin@example.com",
      createdAt: ago(60),
      admin: true,
    });
    const listed = await addUser(db, { email: "listed@example.com", createdAt: ago(60) });
    await db.query("insert into public.metrics_excluded_users (user_id) values ($1)", [listed.id]);
    const empty = { chars: 0 };
    const emptyOther = { content: { type: "doc", content: [{ type: "paragraph" }] } };
    const v = (version, at, client) => ({ ...version, at, client });

    const add = async (key, versions, opts, owner = user) => {
      notes[key] = await addNote(db, owner, versions, opts);
    };
    await add("emptied", [v({ chars: 2625 }, ago(10)), v(empty, ago(3), "web")]);
    await add("refilled", [
      v({ chars: 300 }, ago(10)),
      v(empty, ago(5), "web"),
      v({ chars: 100 }, ago(4), "web"),
    ]);
    await add("trashed", [v({ chars: 300 }, ago(10)), v(empty, ago(5), "web")], {
      trashedAt: ago(4),
    });
    await add("gradual", [
      v({ chars: 300 }, ago(10)),
      v({ chars: 150 }, ago(6), "web"),
      v(empty, ago(5), "mobile-android"),
    ]);
    await add("recent", [v({ chars: 300 }, ago(10)), v(empty, ago(0, 1), "web")]);
    await add("emptyThenEmpty", [
      v({ chars: 500 }, ago(10)),
      v(empty, ago(5), "desktop-macos"),
      v(emptyOther, ago(4), "web"),
    ]);
    await add("untagged", [v({ chars: 250 }, ago(10)), v(empty, ago(2), null)]);
    await add("old", [v({ chars: 300 }, ago(20)), v(empty, ago(15), "web")]);
    await add("twice", [
      v({ chars: 400 }, ago(12)),
      v(empty, ago(11), "web"),
      v({ chars: 300 }, ago(9), "web"),
      v(empty, ago(8), "mobile-ios"),
    ]);
    await add("exactly200", [v({ chars: 200 }, ago(10)), v(empty, ago(3), "web")]);
    await add("only199", [v({ chars: 199 }, ago(10)), v(empty, ago(3), "web")]);
    await add("neverText", [v(empty, ago(10)), v(emptyOther, ago(3), "web")]);
    await add("nullContent", [v({ chars: 300 }, ago(10)), v({ content: null }, ago(3), "web")]);
    await add("admins", [v({ chars: 300 }, ago(10)), v(empty, ago(3), "web")], {}, admin);
    await add("listed", [v({ chars: 300 }, ago(10)), v(empty, ago(3), "web")], {}, listed);
  });

  after(async () => {
    await db?.close();
  });

  const nameOf = (id) => Object.keys(notes).find((k) => notes[k] === id);

  async function emptied(sql, params) {
    const rows = await asServiceRole(db, sql, params);
    return Object.fromEntries(
      rows.map((r) => [
        nameOf(r.note_id),
        { client: r.client, chars: r.chars_before, at: r.emptied_at },
      ]),
    );
  }

  it("reports notes one save emptied from 200+ characters and that stayed empty 24h", async () => {
    const found = await emptied("select * from public.metrics_emptied_notes($1)", [
      shift(now, -14).toISOString(),
    ]);
    assert.deepEqual(Object.keys(found).sort(), [
      "emptied",
      "emptyThenEmpty",
      "exactly200",
      "nullContent",
      "twice",
      "untagged",
    ]);
    assert.deepEqual(
      { client: found.emptied.client, chars: found.emptied.chars },
      { client: "web", chars: 2625 },
    );
    assert.equal(found.emptied.at.getTime(), shift(now, -3).getTime());
    // The save that emptied it, not the later empty-to-empty one.
    assert.deepEqual(
      { client: found.emptyThenEmpty.client, chars: found.emptyThenEmpty.chars },
      { client: "desktop-macos", chars: 500 },
    );
    assert.equal(found.emptyThenEmpty.at.getTime(), shift(now, -5).getTime());
    // The latest emptying of a note emptied, refilled and emptied again.
    assert.deepEqual(
      { client: found.twice.client, chars: found.twice.chars },
      { client: "mobile-ios", chars: 300 },
    );
    assert.equal(found.untagged.client, "untagged");
    assert.equal(found.exactly200.chars, 200);
  });

  it("waits 24 hours, which p_as_of can move", async () => {
    const later = await emptied("select * from public.metrics_emptied_notes($1, $2)", [
      shift(now, -14).toISOString(),
      shift(now, 1, 1).toISOString(),
    ]);
    assert.ok(later.recent, "a save emptied an hour ago is reported 25 hours on");
    assert.equal(later.recent.chars, 300);
    const earlier = await emptied("select * from public.metrics_emptied_notes($1, $2)", [
      shift(now, -14).toISOString(),
      shift(now, -2).toISOString(),
    ]);
    // At now - 2 days, only saves from 3+ days ago are 24 hours old.
    assert.deepEqual(Object.keys(earlier).sort(), [
      "emptied",
      "emptyThenEmpty",
      "exactly200",
      "nullContent",
      "twice",
    ]);
  });

  it("starts at p_since", async () => {
    const all = await emptied("select * from public.metrics_emptied_notes($1)", [
      shift(now, -30).toISOString(),
    ]);
    assert.ok(all.old);
    const recent = await emptied("select * from public.metrics_emptied_notes($1)", [
      shift(now, -4).toISOString(),
    ]);
    assert.deepEqual(Object.keys(recent).sort(), [
      "emptied",
      "exactly200",
      "nullContent",
      "untagged",
    ]);
  });
});

describe("product metrics: metrics_depth (PGlite)", () => {
  let db;

  before(async () => {
    db = await freshDb();
    const { now } = await anchors(db);
    const ago = (days) => shift(now, -days);
    const attach = (user, noteId, bytes) =>
      db.query("insert into public.attachments (note_id, user_id, file_size) values ($1, $2, $3)", [
        noteId,
        user.id,
        bytes,
      ]);

    // Two tagged clients, 3 live notes and 1 trashed, 2 notebooks, 3 MB, a key.
    const u1 = await addUser(db, { email: "u1@example.com", createdAt: ago(90) });
    const n1 = await addNote(db, u1, [
      { chars: 10, at: ago(40) },
      { chars: 20, at: ago(2), client: "web" },
      { chars: 30, at: ago(1), client: "mobile-ios" },
    ]);
    await addNote(db, u1, [{ chars: 10, at: ago(40) }]);
    await addNote(db, u1, [{ chars: 10, at: ago(40) }]);
    await addNote(db, u1, [{ chars: 10, at: ago(40) }], { trashedAt: ago(35) });
    await db.query("insert into public.notebooks (user_id) values ($1)", [u1.id]);
    await attach(u1, n1, 1024 * 1024);
    await attach(u1, n1, 2 * 1024 * 1024);
    await db.query("insert into public.api_keys (user_id) values ($1)", [u1.id]);

    // An MCP write; a revoked key only.
    const u2 = await addUser(db, { email: "u2@example.com", createdAt: ago(90) });
    await addNote(db, u2, [
      { chars: 10, at: ago(40) },
      { chars: 20, at: ago(5), client: "web-mcp" },
    ]);
    await db.query("insert into public.api_keys (user_id, revoked_at) values ($1, $2)", [
      u2.id,
      ago(3).toISOString(),
    ]);

    // A new 60-character note yesterday (untagged), half a MB.
    const u3 = await addUser(db, { email: "u3@example.com", createdAt: ago(90) });
    const n3 = await addNote(db, u3, [{ chars: 60, at: ago(1) }]);
    await attach(u3, n3, 512 * 1024);

    // Wrote 40 days ago only; an admin and a listed user who wrote yesterday.
    const u4 = await addUser(db, { email: "u4@example.com", createdAt: ago(90) });
    await addNote(db, u4, [
      { chars: 10, at: ago(45) },
      { chars: 20, at: ago(40), client: "web" },
    ]);
    const admin = await addUser(db, { email: "a@example.com", createdAt: ago(90), admin: true });
    await addNote(db, admin, [
      { chars: 10, at: ago(45) },
      { chars: 20, at: ago(1), client: "web-mcp" },
    ]);
    const listed = await addUser(db, { email: "l@example.com", createdAt: ago(90) });
    await db.query("insert into public.metrics_excluded_users (user_id) values ($1)", [listed.id]);
    await addNote(db, listed, [{ chars: 60, at: ago(1) }]);
  });

  after(async () => {
    await db?.close();
  });

  it("describes the last 30 days' writers", async () => {
    const rows = await asServiceRole(db, "select * from public.metrics_depth()");
    assert.equal(rows.length, 1);
    const r = Object.fromEntries(
      Object.entries(rows[0]).map(([k, v]) => [k, v === null ? null : Number(v)]),
    );
    assert.deepEqual(r, {
      writers: 3,
      live_notes_median: 1,
      live_notes_max: 3,
      notebooks_median: 1,
      notebooks_max: 2,
      attachment_mb_median: 0.5,
      attachment_mb_max: 3,
      pct_with_attachment: 66.7,
      pct_with_api_key: 33.3,
      pct_with_mcp_write: 33.3,
      pct_multi_client: 33.3,
    });
  });

  it("returns one row of nulls and a zero count when nobody wrote", async () => {
    const empty = await freshDb();
    try {
      const rows = await asServiceRole(empty, "select * from public.metrics_depth()");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].writers, 0);
      assert.equal(rows[0].live_notes_median, null);
      assert.equal(rows[0].pct_with_attachment, null);
    } finally {
      await empty.close();
    }
  });
});

describe("product metrics: metrics_platform_limits (PGlite)", () => {
  let db;
  const MB = 1024 * 1024;

  before(async () => {
    db = await freshDb();
  });

  after(async () => {
    await db?.close();
  });

  const addObject = (bucket, size) =>
    db.query("insert into storage.objects (bucket_id, name, metadata) values ($1, 'f', $2)", [
      bucket,
      JSON.stringify(size === undefined ? {} : { size }),
    ]);

  async function limits() {
    const rows = await asServiceRole(db, "select * from public.metrics_platform_limits()");
    return Object.fromEntries(
      rows.map((r) => [
        r.resource,
        {
          used: Number(r.used_bytes),
          limit: Number(r.limit_bytes),
          pct: Number(r.pct),
          level: r.level,
        },
      ]),
    );
  }

  it("measures the database against 500 MB", async () => {
    const { database } = await limits();
    assert.equal(database.limit, 500 * MB);
    assert.ok(database.used > 0);
    assert.equal(database.pct, Math.round((1000 * database.used) / database.limit) / 10);
    assert.equal(
      database.level,
      database.pct >= 85 ? "critical" : database.pct >= 70 ? "warn" : "ok",
    );
  });

  it("sums the attachments bucket against 1 GB, with ok / warn / critical levels", async () => {
    await addObject("attachments", 100 * MB);
    await addObject("attachments", "not a number");
    await addObject("attachments");
    await addObject("avatars", 900 * MB);
    assert.deepEqual((await limits()).storage, {
      used: 100 * MB,
      limit: 1024 * MB,
      pct: 9.8,
      level: "ok",
    });
    // 70% of 1 GB, rounded up to a byte.
    await addObject("attachments", Math.ceil(0.7 * 1024 * MB) - 100 * MB);
    assert.equal((await limits()).storage.level, "warn");
    await addObject("attachments", Math.ceil(0.85 * 1024 * MB) - Math.ceil(0.7 * 1024 * MB) - 1);
    assert.equal((await limits()).storage.level, "warn", "one byte under 85%");
    await addObject("attachments", 1);
    const { storage } = await limits();
    assert.equal(storage.level, "critical");
    assert.equal(storage.pct, 85);
  });
});
