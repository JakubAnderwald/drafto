// Live check of activity days (ADR 0077,
// supabase/migrations/20261113000001_usage_daily.sql) against the DEV Supabase
// project, over plain fetch to GoTrue and PostgREST: the same path a client
// holding the public anon key and its own JWT would use.
//
// It creates two throwaway users, A and B, signs each in, and checks:
//   - record_activity records a day once (1, then 0), takes at most 31 days
//     per call, and rejects an unknown or missing client tag with 22023,
//     writing nothing when it rejects;
//   - it drops days after today (UTC), days more than 30 days back, nulls and
//     duplicates, and the rows it leaves are exactly the valid ones;
//   - it only ever writes rows for the caller: B's rows don't move when A
//     calls it, and an extra user argument is refused;
//   - a signed-in user can't read usage_daily, or insert, update or delete a
//     row in it, for themselves or for another user; anon can't either, and
//     can't call record_activity (nor can service_role: it has no user);
//   - anon and a signed-in user get permission denied on metrics_active_users,
//     metrics_retention, metrics_cohort_activation and rollup_usage_daily;
//     service_role reads both metrics, with A counted once in this week's
//     active users until A is excluded through metrics_excluded_users;
//   - deleting a user deletes their usage_daily rows (on delete cascade).
// Every user left is deleted in the `after` hook; a failed deletion fails the
// run, since a user left behind stays in dev's metrics.
//
// The metrics delta runs on shared dev data, so someone else opening Drafto on
// dev between two back-to-back reads could flake it; rerun if so. PGlite covers
// the rollup and the metric definitions (scripts/__tests__/usage-daily.test.mjs).
//
// Opt-in, like product-metrics.live.test.mjs: it runs only when
// NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are exported and
// NEXT_PUBLIC_SUPABASE_URL's origin is exactly the dev project over HTTPS. Run
// it with `pnpm test:live:supabase -- --only usage-daily`, which reads the keys
// from this machine's files and sets DRAFTO_LIVE_REQUIRED=1, so a missing key
// fails the run instead of skipping it. The usage_daily migration must be
// applied to dev first.

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
const DAY = 86_400_000;
// The limits record_activity enforces (RECORD_ACTIVITY_MAX_DAYS in
// packages/shared, and the 30-day look-back).
const MAX_DAYS_PER_CALL = 31;
const MAX_DAYS_BACK = 30;

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

/** Asserts PostgREST's permission-denied answer: 42501, as 401 for anon, else 403. */
function assertDenied(res, what) {
  assert.ok([401, 403].includes(res.status), `${what}: ${formatResponse(res)}`);
  assert.equal(res.body?.code, "42501", `${what}: ${formatResponse(res)}`);
}

/**
 * POST /rest/v1/rpc/record_activity as <auth>. POST, not GET: the function
 * writes, and PostgREST runs GET calls read-only.
 */
function recordActivity(auth, days, client) {
  return call("/rest/v1/rpc/record_activity", {
    method: "POST",
    ...auth,
    body: { p_days: days, p_client: client },
  });
}

async function recordOk(auth, days, client) {
  const res = await recordActivity(auth, days, client);
  assert.equal(res.status, 200, `record_activity(${client}): ${formatResponse(res)}`);
  return res.body;
}

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

/** <id>'s usage_daily rows as service_role sees them, oldest day first. */
async function rowsOf(id) {
  const res = await call(
    `/rest/v1/usage_daily?user_id=eq.${id}&select=day,client,content_changes&order=day.asc,client.asc`,
    SERVICE,
  );
  assert.equal(res.status, 200, `read usage_daily: ${formatResponse(res)}`);
  return res.body;
}

/**
 * The test and the server must agree on "today" (UTC). A run that starts in
 * the last two minutes of a UTC day waits for the next one rather than
 * straddle midnight, with a few seconds to spare for clock skew.
 */
async function awayFromUtcMidnight() {
  const untilMidnight = DAY - (Date.now() % DAY);
  if (untilMidnight < 2 * 60_000) {
    await new Promise((resolve) => setTimeout(resolve, untilMidnight + 10_000));
  }
}

const createdIds = [];

async function createUser(label) {
  const email = `usage-daily-live+${label}-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
  const password = randomUUID();
  const res = await call("/auth/v1/admin/users", {
    method: "POST",
    ...SERVICE,
    body: { email, password, email_confirm: true },
  });
  assert.ok(res.ok, `create ${label}: ${formatResponse(res)}`);
  createdIds.push(res.body.id);
  const session = await call("/auth/v1/token?grant_type=password", {
    method: "POST",
    ...ANON,
    body: { email, password },
  });
  assert.equal(session.status, 200, `sign in ${label}: ${formatResponse(session)}`);
  return { id: res.body.id, auth: { key: anonKey, token: session.body.access_token } };
}

async function deleteUser(id) {
  return call(`/auth/v1/admin/users/${id}`, { method: "DELETE", ...SERVICE });
}

describe(
  "usage_daily activity days (live, dev project)",
  {
    skip: canRun
      ? false
      : "set NEXT_PUBLIC_SUPABASE_URL (dev), NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY",
  },
  () => {
    let a;
    let b;
    // UTC day <n> days from today, as YYYY-MM-DD; fixed in `before`.
    let day;

    before(
      async () => {
        await awayFromUtcMidnight();
        const today = Date.now();
        day = (n) => new Date(today + n * DAY).toISOString().slice(0, 10);
        a = await createUser("a");
        b = await createUser("b");
      },
      { timeout: 240_000 },
    );

    after(
      async () => {
        // A user left behind stays in dev's metrics, so a failed cleanup fails
        // the run. Every user is tried before it does.
        const failed = [];
        for (const id of createdIds) {
          const res = await deleteUser(id);
          if (!res.ok) failed.push(`${id}: ${formatResponse(res)}`);
        }
        if (failed.length) {
          assert.fail(`cleanup failed; delete these dev users by hand: ${failed.join("; ")}`);
        }
      },
      { timeout: 60_000 },
    );

    it("records a day once: 1 for a new row, then 0", { timeout: 30_000 }, async () => {
      assert.equal(await recordOk(a.auth, [day(0)], "web"), 1);
      assert.equal(await recordOk(a.auth, [day(0)], "web"), 0);
      // The limit counts the array as sent: 31 copies of one day are allowed.
      assert.equal(await recordOk(a.auth, Array(MAX_DAYS_PER_CALL).fill(day(0)), "web"), 0);
      assert.equal(await recordOk(a.auth, [], "web"), 0);
    });

    it(
      "rejects more than 31 days, and an unknown or missing tag, writing nothing",
      { timeout: 30_000 },
      async () => {
        const tooMany = Array.from({ length: MAX_DAYS_PER_CALL + 1 }, (_, i) => day(-i));
        const many = await recordActivity(a.auth, tooMany, "mobile-android");
        assert.equal(many.status, 400, formatResponse(many));
        assert.equal(many.body?.code, "22023", formatResponse(many));
        assert.match(many.body?.message ?? "", /at most 31 days/, formatResponse(many));

        // web-cron is a real x-drafto-client tag, but not a client a person
        // opens; "mobile" is the mobile app's fallback when the OS is unknown.
        for (const tag of ["web-cron", "mobile", "WEB", ""]) {
          const res = await recordActivity(a.auth, [day(0)], tag);
          assert.equal(res.status, 400, `${JSON.stringify(tag)}: ${formatResponse(res)}`);
          assert.equal(res.body?.code, "22023", `${JSON.stringify(tag)}: ${formatResponse(res)}`);
          assert.match(res.body?.message ?? "", /unknown client tag/, formatResponse(res));
        }
        const missing = await recordActivity(a.auth, [day(0)], null);
        assert.equal(missing.status, 400, formatResponse(missing));
        assert.equal(missing.body?.code, "22023", formatResponse(missing));

        assert.deepEqual(
          (await rowsOf(a.id)).map((r) => [r.day, r.client]),
          [[day(0), "web"]],
          "a rejected call writes nothing",
        );
      },
    );

    it(
      "ignores future days, days more than 30 back, nulls and duplicates",
      { timeout: 30_000 },
      async () => {
        const sent = [
          day(1),
          day(7),
          day(-(MAX_DAYS_BACK + 1)),
          day(-365),
          day(-MAX_DAYS_BACK),
          day(-MAX_DAYS_BACK),
          null,
          day(-1),
        ];
        assert.equal(await recordOk(a.auth, sent, "mobile-ios"), 2);
        assert.deepEqual(await rowsOf(a.id), [
          { day: day(-MAX_DAYS_BACK), client: "mobile-ios", content_changes: 0 },
          { day: day(-1), client: "mobile-ios", content_changes: 0 },
          { day: day(0), client: "web", content_changes: 0 },
        ]);
      },
    );

    it("writes rows for the caller only", { timeout: 30_000 }, async () => {
      assert.equal(await recordOk(b.auth, [day(0)], "desktop-macos"), 1);
      const aRows = await rowsOf(a.id);

      // A's calls land on A, whatever A sends along.
      assert.equal(await recordOk(a.auth, [day(-2)], "web-mcp"), 1);
      const smuggled = await call("/rest/v1/rpc/record_activity", {
        method: "POST",
        ...a.auth,
        body: { p_days: [day(-3)], p_client: "web", p_user_id: b.id },
      });
      assert.ok(!smuggled.ok, `an extra user argument: ${formatResponse(smuggled)}`);

      assert.deepEqual(await rowsOf(b.id), [
        { day: day(0), client: "desktop-macos", content_changes: 0 },
      ]);
      assert.deepEqual(
        await rowsOf(a.id),
        [...aRows, { day: day(-2), client: "web-mcp", content_changes: 0 }].sort(
          (x, y) => x.day.localeCompare(y.day) || x.client.localeCompare(y.client),
        ),
      );
    });

    it(
      "denies a signed-in user and anon the table itself, for any user's rows",
      { timeout: 60_000 },
      async () => {
        const unchanged = { a: await rowsOf(a.id), b: await rowsOf(b.id) };
        for (const [who, auth] of [
          ["authenticated", a.auth],
          ["anon", ANON],
        ]) {
          assertDenied(
            await call("/rest/v1/usage_daily?select=user_id,day", auth),
            `${who} select`,
          );
          for (const target of [a, b]) {
            const owner = target === a ? "own" : "other user's";
            assertDenied(
              await call("/rest/v1/usage_daily", {
                method: "POST",
                ...auth,
                body: { user_id: target.id, day: day(-4), client: "web", content_changes: 5 },
                prefer: "return=minimal",
              }),
              `${who} insert (${owner} row)`,
            );
            assertDenied(
              await call(`/rest/v1/usage_daily?user_id=eq.${target.id}`, {
                method: "PATCH",
                ...auth,
                body: { content_changes: 99 },
                prefer: "return=minimal",
              }),
              `${who} update (${owner} rows)`,
            );
            assertDenied(
              await call(`/rest/v1/usage_daily?user_id=eq.${target.id}`, {
                method: "DELETE",
                ...auth,
              }),
              `${who} delete (${owner} rows)`,
            );
          }
        }
        assert.deepEqual({ a: await rowsOf(a.id), b: await rowsOf(b.id) }, unchanged);
      },
    );

    it(
      "denies anon record_activity, and service_role too, which has no user to record",
      { timeout: 30_000 },
      async () => {
        assertDenied(await recordActivity(ANON, [day(0)], "web"), "anon record_activity");
        assertDenied(
          await recordActivity(SERVICE, [day(0)], "web"),
          "service_role record_activity",
        );
      },
    );

    it(
      "keeps the metrics and the rollup from anon and a signed-in user",
      { timeout: 60_000 },
      async () => {
        for (const [who, auth] of [
          ["anon", ANON],
          ["authenticated", a.auth],
        ]) {
          for (const fn of [
            "metrics_active_users",
            "metrics_retention",
            "metrics_cohort_activation",
          ]) {
            assertDenied(await rpc(fn, { p_weeks: 1 }, auth), `${who} ${fn}`);
          }
          // POST: the rollup writes. Denied, it never runs.
          assertDenied(
            await call("/rest/v1/rpc/rollup_usage_daily", { method: "POST", ...auth, body: {} }),
            `${who} rollup_usage_daily`,
          );
        }
      },
    );

    it(
      "lets service_role read both metrics, counting A once in this week's active users",
      { timeout: 60_000 },
      async () => {
        const weeks = 2;
        const [active, retention, activation] = await Promise.all([
          rpcRows("metrics_active_users", { p_weeks: weeks }),
          rpcRows("metrics_retention", { p_weeks: weeks }),
          rpcRows("metrics_activation", { p_weeks: weeks }),
        ]);
        assert.equal(active.length, weeks, JSON.stringify(active));
        for (const r of active) {
          assert.deepEqual(Object.keys(r).sort(), [
            "active_users",
            "by_client",
            "iso_week",
            "week_complete",
            "week_start",
            "writers",
          ]);
          assert.match(r.iso_week, /^\d{4}-W\d{2}$/);
          assert.ok(r.writers <= r.active_users, JSON.stringify(r));
        }
        const thisWeek = active.at(-1);
        assert.equal(thisWeek.week_complete, false);
        // A and B opened Drafto today, so this week has at least them.
        assert.ok(thisWeek.active_users >= 2, JSON.stringify(thisWeek));

        // One cohort per sign-up week, the same weeks as the activation table.
        assert.deepEqual(
          retention.map((r) => r.week_start),
          activation.map((r) => r.week_start),
        );
        for (const r of retention) {
          assert.deepEqual(Object.keys(r).sort(), [
            "activated",
            "active_week1",
            "active_week4",
            "iso_week",
            "pct_week1",
            "pct_week4",
            "week_start",
          ]);
        }
        // This week's cohort (A and B) hasn't reached week 1 yet.
        const cohort = retention.at(-1);
        assert.equal(cohort.active_week1, null, JSON.stringify(cohort));
        assert.equal(cohort.pct_week1, null, JSON.stringify(cohort));
        assert.equal(cohort.active_week4, null, JSON.stringify(cohort));
        assert.equal(cohort.pct_week4, null, JSON.stringify(cohort));

        // Excluding A takes exactly A out of this week: one active user, one
        // web user, no writer (A changed no content). Read back to back, so
        // other activity on dev has as little time as possible to land.
        const counted = (await rpcRows("metrics_active_users", { p_weeks: 1 })).at(-1);
        const listed = await call("/rest/v1/metrics_excluded_users", {
          method: "POST",
          ...SERVICE,
          body: { user_id: a.id, reason: "usage-daily live test" },
          prefer: "return=minimal",
        });
        assert.equal(listed.status, 201, `exclude A: ${formatResponse(listed)}`);
        let left;
        try {
          left = (await rpcRows("metrics_active_users", { p_weeks: 1 })).at(-1);
        } finally {
          const res = await call(`/rest/v1/metrics_excluded_users?user_id=eq.${a.id}`, {
            method: "DELETE",
            ...SERVICE,
          });
          assert.ok(res.ok, `un-exclude A: ${formatResponse(res)}`);
        }
        assert.deepEqual(
          {
            active: counted.active_users - left.active_users,
            writers: counted.writers - left.writers,
            web: (counted.by_client?.web ?? 0) - (left.by_client?.web ?? 0),
          },
          { active: 1, writers: 0, web: 1 },
        );
      },
    );

    it("deletes a user's rows with the user", { timeout: 30_000 }, async () => {
      assert.equal((await rowsOf(b.id)).length, 1);
      const res = await deleteUser(b.id);
      assert.ok(res.ok, `delete B: ${formatResponse(res)}`);
      // Deleted: nothing left for the `after` hook to clean up.
      createdIds.splice(createdIds.indexOf(b.id), 1);
      assert.deepEqual(await rowsOf(b.id), []);
    });
  },
);
