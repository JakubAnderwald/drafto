// Live check of the profiles privilege guard (issue #457) against the DEV
// Supabase project. It talks to GoTrue and PostgREST with plain fetch, the same
// path an attacker holding the public anon key and their own JWT would use.
//
// Opt-in: it runs only when NEXT_PUBLIC_SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY are exported and NEXT_PUBLIC_SUPABASE_URL's origin
// is exactly the dev project over HTTPS. The CI scripts job exports none of
// them, so it skips there, and it refuses any other project or a plain-http
// origin, so it can never touch production or send a key in cleartext.
//
// Run it once BEFORE applying the migration to dev as well. The self-escalation
// test must fail then, which proves dev's `authenticated` role really holds
// UPDATE on profiles and that this check can see the hole.
//
// Creating users fires the dev project's new-signup webhook, if dev has one
// configured. Every user created here is deleted in the `after` hook.

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
const SERVICE = { key: serviceRoleKey, token: serviceRoleKey };

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

const createdIds = [];

async function createUser(label) {
  const email = `profile-guard-live+${label}-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`;
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
    key: anonKey,
    token: anonKey,
    body: { email, password },
  });
  assert.equal(session.status, 200, `sign in ${label}: ${formatResponse(session)}`);
  return { id: res.body.id, auth: { key: anonKey, token: session.body.access_token } };
}

function patchProfile(id, fields, auth) {
  return call(`/rest/v1/profiles?id=eq.${id}`, {
    method: "PATCH",
    ...auth,
    body: fields,
    prefer: "return=representation",
  });
}

async function readProfile(id) {
  const res = await call(`/rest/v1/profiles?id=eq.${id}&select=is_admin,is_approved,display_name`, {
    ...SERVICE,
  });
  assert.equal(res.status, 200, formatResponse(res));
  assert.equal(res.body.length, 1, `profile ${id} not found`);
  return res.body[0];
}

describe(
  "profiles privilege guard (live, dev project)",
  {
    skip: canRun
      ? false
      : "set NEXT_PUBLIC_SUPABASE_URL (dev), NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY",
  },
  () => {
    let attacker;
    let admin;
    let pendingForAdmin;
    let pendingForServiceRole;

    before(
      async () => {
        attacker = await createUser("attacker");
        admin = await createUser("admin");
        pendingForAdmin = await createUser("pending-admin");
        pendingForServiceRole = await createUser("pending-service");

        const grant = await patchProfile(admin.id, { is_admin: true, is_approved: true }, SERVICE);
        assert.equal(grant.status, 200, `make admin: ${formatResponse(grant)}`);
      },
      { timeout: 60_000 },
    );

    after(
      async () => {
        for (const id of createdIds) {
          const res = await call(`/auth/v1/admin/users/${id}`, { method: "DELETE", ...SERVICE });
          if (!res.ok)
            console.warn(`[profile-guard.live] cleanup of ${id} failed:`, formatResponse(res));
        }
      },
      { timeout: 60_000 },
    );

    it(
      "rejects a user granting themselves is_approved or is_admin",
      { timeout: 30_000 },
      async () => {
        for (const fields of [
          { is_approved: true, is_admin: true },
          { is_approved: true },
          { is_admin: true },
        ]) {
          const res = await patchProfile(attacker.id, fields, attacker.auth);
          assert.equal(res.status, 403, `${JSON.stringify(fields)} → ${formatResponse(res)}`);
          assert.equal(res.body?.code, "42501");
        }

        const profile = await readProfile(attacker.id);
        assert.equal(profile.is_approved, false);
        assert.equal(profile.is_admin, false);
      },
    );

    it("still lets a user edit their own display_name", { timeout: 30_000 }, async () => {
      const res = await patchProfile(
        attacker.id,
        { display_name: "Guard live test" },
        attacker.auth,
      );
      assert.equal(res.status, 200, formatResponse(res));
      assert.equal(res.body.length, 1);
      assert.equal((await readProfile(attacker.id)).display_name, "Guard live test");

      // A full-row PATCH that re-sends the flags unchanged is not a flag change.
      const fullRow = await patchProfile(
        attacker.id,
        { display_name: "Guard live test 2", is_admin: false, is_approved: false },
        attacker.auth,
      );
      assert.equal(fullRow.status, 200, formatResponse(fullRow));
      assert.equal((await readProfile(attacker.id)).display_name, "Guard live test 2");
    });

    it("lets an admin approve a user through their own session", { timeout: 30_000 }, async () => {
      // Mirrors apps/web/src/app/api/admin/approve-user/route.ts.
      const res = await patchProfile(pendingForAdmin.id, { is_approved: true }, admin.auth);
      assert.equal(res.status, 200, formatResponse(res));
      assert.equal(res.body.length, 1);
      assert.equal((await readProfile(pendingForAdmin.id)).is_approved, true);
    });

    it("lets the service role approve a user", { timeout: 30_000 }, async () => {
      // Mirrors apps/web/src/app/api/admin/approve-user/one-click/route.ts.
      const res = await patchProfile(pendingForServiceRole.id, { is_approved: true }, SERVICE);
      assert.equal(res.status, 200, formatResponse(res));
      assert.equal(res.body.length, 1);
      assert.equal((await readProfile(pendingForServiceRole.id)).is_approved, true);
    });
  },
);
