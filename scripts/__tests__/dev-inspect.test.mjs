import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  INSPECT_TABLES,
  InspectUsageError,
  READ_RPCS,
  createDevReader,
  inspectMain,
  parseInspectArgs,
  runInspect,
} from "../lib/dev-inspect.mjs";

const DEV = "https://huhzactreblzcogqkbsd.supabase.co";
const UID = "d03e59a4-6e9f-4192-99f6-1eb1e4150bcf";
const NOTE = "d5f8208d-cb04-4be0-8102-5f7a28df2ff7";
const KEY = "test-service-role-key-0123456789";

function tempConfig({ admin = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dev-inspect-"));
  const keyFile = path.join(dir, "key.env");
  writeFileSync(keyFile, `DEV_SUPABASE_URL=${DEV}\nDEV_SUPABASE_SERVICE_ROLE_KEY=${KEY}\n`, {
    mode: 0o600,
  });
  const user = path.join(dir, "account.env");
  writeFileSync(
    user,
    "FACTORY_BROWSER_EMAIL=factory@example.com\nFACTORY_BROWSER_PASSWORD=pw-123456\n",
    {
      mode: 0o600,
    },
  );
  const accounts = { user };
  if (admin) {
    accounts.admin = path.join(dir, "admin.env");
    writeFileSync(accounts.admin, "FACTORY_BROWSER_ADMIN_EMAIL=admin@example.com\n", {
      mode: 0o600,
    });
  }
  return { keyFile, accounts };
}

/** A fake fetch: records every request and answers from <routes> by method + path. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, search: u.search, init });
    const key = `${init.method} ${u.pathname}`;
    const route = routes[key];
    if (!route) return new Response("not found", { status: 404 });
    const {
      status = 200,
      body = null,
      headers = {},
    } = typeof route === "function" ? route(u, init) : route;
    return new Response(body === null ? "" : JSON.stringify(body), { status, headers });
  };
  return { impl, calls };
}

const users = {
  "GET /auth/v1/admin/users": {
    body: { users: [{ id: UID, email: "Factory@Example.com" }] },
  },
};

describe("parseInspectArgs", () => {
  it("parses each command", () => {
    assert.deepEqual(parseInspectArgs(["whoami"]), {
      account: "user",
      command: "whoami",
      filters: {},
    });
    assert.deepEqual(parseInspectArgs(["--as", "admin", "rows", "notes", "--note", NOTE]), {
      account: "admin",
      command: "rows",
      table: "notes",
      filters: { note: NOTE },
    });
    assert.deepEqual(parseInspectArgs(["objects", "--note", NOTE]).filters, { note: NOTE });
  });

  for (const argv of [
    [],
    ["drop"],
    ["rows"],
    ["rows", "profiles"],
    ["rows", "auth.users"],
    ["rows", "notes", "extra"],
    ["rows", "attachments", "--notebook", NOTE],
    ["rows", "notes", "--note", "x"],
    ["rows", "notes", "--note", `${NOTE}' or 1=1`],
    ["whoami", "--note", NOTE],
    ["objects", "--notebook", NOTE],
    ["--as", "root", "whoami"],
    ["--user-id", UID, "whoami"],
    ["usage", "now"],
  ]) {
    it(`refuses ${JSON.stringify(argv)}`, () => {
      assert.throws(() => parseInspectArgs(argv), InspectUsageError);
    });
  }

  it("lists only user-owned tables", () => {
    assert.deepEqual(Object.keys(INSPECT_TABLES).sort(), [
      "api_keys",
      "attachments",
      "note_content_history",
      "notebooks",
      "notes",
    ]);
  });
});

describe("createDevReader", () => {
  it("talks to the dev project only", () => {
    assert.throws(
      () => createDevReader({ serviceKey: KEY, url: "https://tbmjbxxseonkciqovnpl.supabase.co" }),
      /dev project only/,
    );
  });

  it("refuses any RPC outside READ_RPCS", async () => {
    const reader = createDevReader({ serviceKey: KEY, fetchImpl: async () => new Response("") });
    await assert.rejects(() => reader.rpc("cleanup_trashed_notes", {}), /not a read-only RPC/);
    assert.ok(!READ_RPCS.includes("cleanup_trashed_notes"));
  });

  it("errors name the request, not the key or the response body", async () => {
    const reader = createDevReader({
      serviceKey: KEY,
      fetchImpl: async () => new Response(`echo ${KEY}`, { status: 500 }),
    });
    await assert.rejects(
      () => reader.count("notes", "id", { user_id: UID }),
      (err) => !err.message.includes(KEY) && /GET \/rest\/v1\/notes -> 500/.test(err.message),
    );
  });
});

describe("runInspect", () => {
  it("counts rows filtered to the account's own user id, with the table's own filter column", async () => {
    const { impl, calls } = fakeFetch({
      "GET /rest/v1/attachments": { headers: { "content-range": "*/3" } },
    });
    const reader = createDevReader({ serviceKey: KEY, fetchImpl: impl });
    const out = await runInspect(
      { account: "user", command: "rows", table: "attachments", filters: { note: NOTE } },
      { reader, userId: UID },
    );
    assert.deepEqual(out, { table: "attachments", count: 3 });
    const params = new URLSearchParams(calls[0].search);
    assert.equal(params.get("user_id"), `eq.${UID}`);
    assert.equal(params.get("note_id"), `eq.${NOTE}`);
    assert.equal(params.get("limit"), "0");
    assert.equal(calls[0].method, "GET");
  });

  it("lists objects under the account's folder only, relative to it", async () => {
    const { impl, calls } = fakeFetch({
      "POST /storage/v1/object/list/attachments": (u, init) => {
        const { prefix } = JSON.parse(init.body);
        if (prefix === UID) return { body: [{ name: NOTE, id: null }] };
        return { body: [{ name: "a.jpg", id: "1", metadata: { size: 1024 } }] };
      },
    });
    const reader = createDevReader({ serviceKey: KEY, fetchImpl: impl });
    const out = await runInspect(
      { account: "user", command: "objects", filters: {} },
      { reader, userId: UID },
    );
    assert.deepEqual(out, {
      count: 1,
      truncated: false,
      totalBytes: 1024,
      objects: [{ name: `${NOTE}/a.jpg`, size: 1024 }],
    });
    assert.equal(JSON.parse(calls[0].init.body).prefix, UID);
  });

  it("stops listing every folder once the object cap is reached", async () => {
    let lists = 0;
    const { impl } = fakeFetch({
      "POST /storage/v1/object/list/attachments": (u, init) => {
        lists++;
        const { prefix } = JSON.parse(init.body);
        if (prefix === UID) {
          return { body: Array.from({ length: 300 }, (_, i) => ({ name: `n${i}`, id: null })) };
        }
        return {
          body: Array.from({ length: 600 }, (_, i) => ({
            name: `f${i}`,
            id: String(i),
            metadata: { size: 1 },
          })),
        };
      },
    });
    const reader = createDevReader({ serviceKey: KEY, fetchImpl: impl });
    const out = await runInspect(
      { account: "user", command: "objects", filters: {} },
      { reader, userId: UID },
    );
    assert.equal(out.truncated, true);
    assert.equal(out.count, 500);
    // The root listing and the first folder, not all 300 folders.
    assert.equal(lists, 2);
  });

  it("reports a real failure as one, not as 'unavailable'", async () => {
    const { impl } = fakeFetch({
      "POST /rest/v1/rpc/storage_usage_bytes": { status: 503, body: { message: "down" } },
    });
    const reader = createDevReader({ serviceKey: KEY, fetchImpl: impl });
    await assert.rejects(
      () => runInspect({ account: "user", command: "usage", filters: {} }, { reader, userId: UID }),
      /503/,
    );
  });

  it("reports usage, with 'unavailable' for a function dev doesn't have", async () => {
    const { impl } = fakeFetch({
      "POST /rest/v1/rpc/storage_usage_bytes": { body: 2048 },
      "GET /rest/v1/profiles": { body: [{ storage_quota_bytes: 4096 }] },
    });
    const reader = createDevReader({ serviceKey: KEY, fetchImpl: impl });
    const out = await runInspect(
      { account: "user", command: "usage", filters: {} },
      { reader, userId: UID },
    );
    assert.equal(out.usedBytes, 2048);
    assert.match(out.objectBytes, /^unavailable on dev/);
    assert.equal(out.quotaBytes, 4096);
  });

  it("lists orphans for the account only", async () => {
    const { impl, calls } = fakeFetch({
      "POST /rest/v1/rpc/orphaned_attachment_objects": {
        body: [`${UID}/${NOTE}/x.png`],
      },
    });
    const reader = createDevReader({ serviceKey: KEY, fetchImpl: impl });
    const out = await runInspect(
      { account: "user", command: "orphans", filters: {} },
      { reader, userId: UID },
    );
    assert.deepEqual(out, { count: 1, objects: [`${NOTE}/x.png`] });
    assert.deepEqual(JSON.parse(calls[0].init.body), { max_rows: 1000, only_user: UID });
  });
});

describe("inspectMain", () => {
  it("resolves the account by email and answers one JSON object", async () => {
    const { impl } = fakeFetch({ ...users });
    const r = await inspectMain(["whoami"], { config: tempConfig(), fetchImpl: impl });
    assert.equal(r.exitCode, 0);
    // The id only: the account's email stays in its secrets file.
    assert.deepEqual(r.out, { account: "user", id: UID });
  });

  it("refuses an account the run doesn't have, before any request", async () => {
    const { impl, calls } = fakeFetch({ ...users });
    const r = await inspectMain(["--as", "admin", "whoami"], {
      config: tempConfig(),
      fetchImpl: impl,
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.out.error, /no admin account/);
    assert.equal(calls.length, 0);
  });

  it("uses the admin account's email file with --as admin", async () => {
    const { impl } = fakeFetch({
      "GET /auth/v1/admin/users": { body: { users: [{ id: UID, email: "admin@example.com" }] } },
    });
    const r = await inspectMain(["--as", "admin", "whoami"], {
      config: tempConfig({ admin: true }),
      fetchImpl: impl,
    });
    assert.deepEqual(r.out, { account: "admin", id: UID });
  });

  it("refuses a key file other users can read", async () => {
    const config = tempConfig();
    chmodSync(config.keyFile, 0o644);
    const r = await inspectMain(["whoami"], { config, fetchImpl: async () => new Response("") });
    assert.equal(r.exitCode, 2);
    assert.match(r.out.error, /mode/);
  });

  it("withholds output that would carry the key", async () => {
    const { impl } = fakeFetch({
      "GET /auth/v1/admin/users": { body: { users: [{ id: UID, email: "factory@example.com" }] } },
      "GET /rest/v1/profiles": { body: [{ is_approved: KEY, is_admin: false }] },
    });
    const r = await inspectMain(["profile"], { config: tempConfig(), fetchImpl: impl });
    assert.ok(!JSON.stringify(r.out).includes(KEY));
    assert.match(r.out.error, /withheld/);
  });

  it("never sends anything but GET and POST", async () => {
    const { impl, calls } = fakeFetch({ ...users });
    for (const argv of [["whoami"], ["rows", "notes"], ["objects"], ["usage"], ["orphans"]]) {
      await inspectMain(argv, { config: tempConfig(), fetchImpl: impl });
    }
    assert.ok(calls.length > 0);
    for (const c of calls) assert.ok(["GET", "POST"].includes(c.method), c.method);
    for (const c of calls.filter((x) => x.method === "POST")) {
      assert.match(c.path, /^\/(storage\/v1\/object\/list\/attachments|rest\/v1\/rpc\/[a-z_]+)$/);
    }
  });
});
