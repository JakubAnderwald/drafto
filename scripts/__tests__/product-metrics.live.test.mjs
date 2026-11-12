// Live check of the product metrics (ADR 0075,
// supabase/migrations/20261111000002_product_metrics.sql) against the DEV
// Supabase project, over plain fetch to GoTrue and PostgREST.
//
// It creates a throwaway user with notes, and drives real content overwrites
// through PostgREST with an x-drafto-client tag, so the history rows come from
// the real archive trigger. Then it checks:
//   - sign-ups, activation, writers and depth: each metric with the user
//     counted, then with the user excluded (as an admin, then through
//     metrics_excluded_users), must differ by exactly this user;
//   - the emptying detector: a note taken from 250 characters to none is
//     reported 25 hours on (p_as_of), with its client and size, but not yet
//     now; a refilled note and a trashed one never are;
//   - that service_role reads auth.users and storage.objects through the
//     invoker functions (metrics_signups, metrics_platform_limits);
//   - that anon and a signed-in user get permission denied on every function
//     and on metrics_excluded_users.
// The user is deleted in the `after` hook, which cascades to everything above;
// a failed deletion fails the run, since a user left behind stays in dev's metrics.
//
// The deltas run on shared dev data, so a sign-up or a write by someone else
// between two back-to-back calls could flake one of them; rerun if so.
// PGlite covers the backdated cases (scripts/__tests__/product-metrics.test.mjs).
//
// Opt-in, like profile-privilege-guard.live.test.mjs: it runs only when
// NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are exported and
// NEXT_PUBLIC_SUPABASE_URL's origin is exactly the dev project over HTTPS. Run
// it with `pnpm test:live:supabase -- --only metrics`, which reads the keys
// from this machine's files and sets DRAFTO_LIVE_REQUIRED=1, so a missing key
// fails the run instead of skipping it. Both product-metrics migrations must
// be applied to dev first.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// The tag the overwrites below carry (ADR 0023).
const CLIENT = "web";

async function call(path, { method = "GET", key, token, body, prefer, client } = {}) {
  const headers = { apikey: key, Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  if (client) headers["x-drafto-client"] = client;
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

/** GET /rest/v1/rpc/<fn> as <auth>, the read-only way `pnpm users:stats` calls it. */
function rpc(fn, params = {}, auth = SERVICE) {
  const query = new URLSearchParams(params).toString();
  return call(`/rest/v1/rpc/${fn}${query ? `?${query}` : ""}`, auth);
}

async function rpcRows(fn, params) {
  const res = await rpc(fn, params);
  assert.equal(res.status, 200, `${fn}: ${formatResponse(res)}`);
  return res.body;
}

/** BlockNote content with <n> characters of text (none for 0). */
function contentOf(n) {
  return [
    {
      id: randomUUID(),
      type: "paragraph",
      props: {},
      content: n ? [{ type: "text", text: "m".repeat(n), styles: {} }] : [],
      children: [],
    },
  ];
}

const createdIds = [];

async function createUser() {
  const email = `metrics-live+${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
  const password = randomUUID();
  const res = await call("/auth/v1/admin/users", {
    method: "POST",
    ...SERVICE,
    body: { email, password, email_confirm: true },
  });
  assert.ok(res.ok, `create user: ${formatResponse(res)}`);
  createdIds.push(res.body.id);
  const session = await call("/auth/v1/token?grant_type=password", {
    method: "POST",
    ...ANON,
    body: { email, password },
  });
  assert.equal(session.status, 200, `sign in: ${formatResponse(session)}`);
  return {
    id: res.body.id,
    signedUpAt: new Date(res.body.created_at),
    auth: { key: anonKey, token: session.body.access_token },
  };
}

async function insertRow(table, row) {
  const res = await call(`/rest/v1/${table}`, {
    method: "POST",
    ...SERVICE,
    body: row,
    prefer: "return=representation",
  });
  assert.equal(res.status, 201, `insert into ${table}: ${formatResponse(res)}`);
  return res.body[0];
}

async function patchNote(id, fields) {
  const res = await call(`/rest/v1/notes?id=eq.${id}`, {
    method: "PATCH",
    ...SERVICE,
    body: fields,
    prefer: "return=representation",
    client: CLIENT,
  });
  assert.equal(res.status, 200, `update note: ${formatResponse(res)}`);
  assert.equal(res.body.length, 1);
}

/** Everything the deltas compare, read back to back. */
async function snapshot({ since, asOf }) {
  const [signups, activation, writers, depth, emptied] = await Promise.all([
    rpcRows("metrics_signups", { p_weeks: 1 }),
    rpcRows("metrics_activation", { p_weeks: 1 }),
    rpcRows("metrics_writers", { p_weeks: 1 }),
    rpcRows("metrics_depth"),
    rpcRows("metrics_emptied_notes", { p_since: since, p_as_of: asOf }),
  ]);
  return {
    signups: signups.at(-1),
    activation: activation.at(-1),
    writers: writers.at(-1),
    depth: depth[0],
    emptied,
  };
}

/** included - excluded for every count the test user adds to. */
function deltas(included, excluded) {
  const d = (path) => {
    const get = (snap) => path.split(".").reduce((o, k) => o?.[k], snap) ?? 0;
    return get(included) - get(excluded);
  };
  return {
    signups: d("signups.signups"),
    signupsEmail: d("signups.by_provider.email"),
    signedUp: d("activation.signed_up"),
    firstValue: d("activation.first_value"),
    activated: d("activation.activated"),
    writers: d("writers.writers"),
    writersTagged: d(`writers.by_client.${CLIENT}`),
    writersUntagged: d("writers.by_client.untagged"),
    depthWriters: d("depth.writers"),
  };
}

const ONE_EACH = {
  signups: 1,
  signupsEmail: 1,
  signedUp: 1,
  firstValue: 1,
  activated: 1,
  writers: 1,
  writersTagged: 1,
  writersUntagged: 1,
  depthWriters: 1,
};

// Every function the migrations add, with arguments PostgREST can match.
function functionCalls(since) {
  return {
    note_text_chars: { content: "{}" },
    metrics_excluded_user_ids: {},
    metrics_week_starts: { p_weeks: 1 },
    metrics_write_events: { p_from: since, p_to: new Date(Date.now() + DAY).toISOString() },
    metrics_signups: { p_weeks: 1 },
    metrics_activation: { p_weeks: 1 },
    metrics_writers: { p_weeks: 1 },
    metrics_emptied_notes: { p_since: since },
    metrics_depth: {},
    metrics_platform_limits: {},
  };
}

describe(
  "product metrics (live, dev project)",
  {
    skip: canRun
      ? false
      : "set NEXT_PUBLIC_SUPABASE_URL (dev), NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY",
  },
  () => {
    let user;
    let notes;
    let since;
    let asOf;
    let included;

    before(
      async () => {
        user = await createUser();
        since = new Date(user.signedUpAt.getTime() - 60_000).toISOString();
        const notebook = await insertRow("notebooks", { user_id: user.id, name: "Metrics live" });
        const note = (title, chars, extra = {}) =>
          insertRow("notes", {
            notebook_id: notebook.id,
            user_id: user.id,
            title,
            content: contentOf(chars),
            ...extra,
          });
        // Two 60-character versions on different UTC days within 14 days of
        // sign-up. Only UPDATE moves updated_at, so an insert can set it.
        const at = (ms) => new Date(user.signedUpAt.getTime() + ms).toISOString();
        await note("day one", 60, { updated_at: at(HOUR) });
        await note("day three", 60, { updated_at: at(2 * DAY + HOUR) });

        notes = {
          emptied: await note("emptied", 250),
          refilled: await note("refilled", 250),
          trashed: await note("trashed", 250),
        };
        for (const n of Object.values(notes)) await patchNote(n.id, { content: contentOf(0) });
        await patchNote(notes.refilled.id, { content: contentOf(100) });
        await patchNote(notes.trashed.id, {
          is_trashed: true,
          trashed_at: new Date().toISOString(),
        });

        asOf = new Date(Date.now() + 25 * HOUR).toISOString();
        included = await snapshot({ since, asOf });
      },
      { timeout: 120_000 },
    );

    after(
      async () => {
        // A user left behind stays in dev's metrics, so a failed cleanup fails
        // the run. Every user is tried before it does.
        const failed = [];
        for (const id of createdIds) {
          const res = await call(`/auth/v1/admin/users/${id}`, { method: "DELETE", ...SERVICE });
          if (!res.ok) failed.push(`${id}: ${formatResponse(res)}`);
        }
        if (failed.length) {
          assert.fail(`cleanup failed; delete these dev users by hand: ${failed.join("; ")}`);
        }
      },
      { timeout: 60_000 },
    );

    it("counts the history rows the overwrites left, tagged with their client", async () => {
      const res = await call(
        `/rest/v1/note_content_history?user_id=eq.${user.id}&select=note_id,archived_by`,
        SERVICE,
      );
      assert.equal(res.status, 200, formatResponse(res));
      // emptied: 1, refilled: 2, trashed: 1 (trashing isn't a content change).
      assert.equal(res.body.length, 4, formatResponse(res));
      assert.ok(
        res.body.every((r) => r.archived_by === CLIENT),
        formatResponse(res),
      );
    });

    it(
      "counts the user once in each metric, and not as an admin or a listed user",
      { timeout: 60_000 },
      async () => {
        // Snapshots taken back to back around each exclusion, so other
        // activity on dev has as little time as possible to land in between.
        async function deltaOf(exclude, restore) {
          const counted = await snapshot({ since, asOf });
          await exclude();
          try {
            const left = await snapshot({ since, asOf });
            return { delta: deltas(counted, left), left };
          } finally {
            await restore();
          }
        }
        const setAdmin = (value) => async () => {
          const res = await call(`/rest/v1/profiles?id=eq.${user.id}`, {
            method: "PATCH",
            ...SERVICE,
            body: { is_admin: value },
            prefer: "return=representation",
          });
          assert.equal(res.status, 200, `is_admin=${value}: ${formatResponse(res)}`);
        };
        const asAdmin = await deltaOf(setAdmin(true), setAdmin(false));
        assert.deepEqual(asAdmin.delta, ONE_EACH, "excluded as an admin");

        let listedIds = null;
        const listed = await deltaOf(
          async () => {
            await insertRow("metrics_excluded_users", {
              user_id: user.id,
              reason: "metrics live test",
            });
            listedIds = await rpcRows("metrics_excluded_user_ids");
          },
          async () => {
            const res = await call(`/rest/v1/metrics_excluded_users?user_id=eq.${user.id}`, {
              method: "DELETE",
              ...SERVICE,
            });
            assert.ok(res.ok, formatResponse(res));
          },
        );
        assert.deepEqual(listed.delta, ONE_EACH, "excluded through metrics_excluded_users");
        assert.ok(listedIds.some((r) => r.user_id === user.id));
        assert.ok(!listed.left.emptied.some((r) => r.user_id === user.id));
      },
    );

    it("reports the emptied note 25 hours on, not now, and never the controls", async () => {
      const mine = included.emptied.filter((r) => r.user_id === user.id);
      assert.deepEqual(
        mine.map((r) => ({ note_id: r.note_id, client: r.client, chars_before: r.chars_before })),
        [{ note_id: notes.emptied.id, client: CLIENT, chars_before: 250 }],
      );
      const now = await rpcRows("metrics_emptied_notes", { p_since: since });
      assert.ok(!now.some((r) => r.user_id === user.id), "an emptying under 24 hours old");
    });

    it("lets service_role run the helpers and reach auth.users and storage", async () => {
      const chars = await rpcRows("note_text_chars", {
        content: JSON.stringify([
          { type: "paragraph", content: [{ type: "text", text: "abc", styles: { bold: true } }] },
          { type: "paragraph", content: [], children: [{ content: [{ text: "de" }] }] },
        ]),
      });
      assert.equal(chars, 5);
      assert.equal((await rpcRows("metrics_week_starts", { p_weeks: 3 })).length, 3);

      const limits = await rpcRows("metrics_platform_limits");
      assert.deepEqual(
        limits.map((r) => [r.resource, r.limit_bytes]),
        [
          ["database", 500 * 1024 * 1024],
          ["storage", 1024 * 1024 * 1024],
        ],
      );
      for (const r of limits) {
        assert.ok(r.used_bytes >= 0 && ["ok", "warn", "critical"].includes(r.level), r.resource);
      }
      assert.ok(limits[0].used_bytes > 0, "the database has a size");

      const bad = await rpc("metrics_signups", { p_weeks: 0 });
      assert.equal(bad.status, 400, formatResponse(bad));
      assert.equal(bad.body?.code, "22023");
    });

    it(
      "denies anon and a signed-in user every function and the exclusion table",
      { timeout: 60_000 },
      async () => {
        for (const [who, auth] of [
          ["anon", ANON],
          ["authenticated", user.auth],
        ]) {
          for (const [fn, params] of Object.entries(functionCalls(since))) {
            const res = await rpc(fn, params, auth);
            assert.ok([401, 403].includes(res.status), `${who} ${fn}: ${formatResponse(res)}`);
            assert.equal(res.body?.code, "42501", `${who} ${fn}: ${formatResponse(res)}`);
          }
          const table = await call("/rest/v1/metrics_excluded_users?select=user_id", auth);
          assert.ok([401, 403].includes(table.status), `${who} table: ${formatResponse(table)}`);
          assert.equal(table.body?.code, "42501", `${who} table: ${formatResponse(table)}`);
        }
      },
    );
  },
);
