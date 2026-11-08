// Tests for scripts/delete-users.mjs: argument parsing, session refusal, the
// deletion email, the fetch-based Supabase/Resend calls, and the run order
// (storage sweep → auth delete → verify → email). No network: every call goes
// to a fake.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  UsageError,
  buildDeletionEmail,
  createSupabaseAdmin,
  parseArgs,
  refusalReason,
  run,
  sendResendEmail,
  userRefusal,
} from "../delete-users.mjs";

describe("parseArgs", () => {
  it("parses a dry run with defaults", () => {
    const o = parseArgs(["--project", "prod", "A@Example.com", "b@example.com", "a@example.com"]);
    assert.equal(o.project, "prod");
    assert.equal(o.execute, false);
    assert.equal(o.notify, false);
    assert.deepEqual(o.emails, ["a@example.com", "b@example.com"]);
    assert.match(o.keysTxt, /drafto-secrets\/supabase service keys\.txt$/);
  });

  it("parses --execute, --notify, --reason and file overrides, skipping a bare --", () => {
    const o = parseArgs([
      "--",
      "--project",
      "dev",
      "--execute",
      "--notify",
      "--reason",
      "Unused\nfor months ",
      "--keys-txt",
      "/k.txt",
      "--resend-env",
      "/r.env",
      "x@y.z",
    ]);
    assert.equal(o.execute, true);
    assert.equal(o.notify, true);
    assert.equal(o.reason, "Unused for months");
    assert.equal(o.keysTxt, "/k.txt");
    assert.equal(o.resendEnv, "/r.env");
  });

  it("returns early for --help", () => {
    assert.equal(parseArgs(["--help"]).help, true);
  });

  for (const [argv, msg] of [
    [["x@y.z"], /--project must be prod or dev/],
    [["--project", "staging", "x@y.z"], /--project must be prod or dev/],
    [["--project", "prod"], /at least one email/],
    [["--project", "prod", "not-an-email"], /not an email/],
    [["--project", "prod", "--bogus", "x@y.z"], /unknown option --bogus/],
    [["--project", "prod", "x@y.z", "--reason"], /--reason needs a value/],
    [["--project", "prod", "--reason", "  ", "x@y.z"], /--reason is empty/],
    [["--project", "--execute", "x@y.z"], /--project needs a value/],
  ]) {
    it(`rejects ${JSON.stringify(argv)}`, () => {
      assert.throws(
        () => parseArgs(argv),
        (err) => err instanceof UsageError && msg.test(err.message),
      );
    });
  }
});

describe("refusalReason", () => {
  it("refuses unattended sessions, whatever the value", () => {
    assert.match(refusalReason({ env: { DRAFTO_UNATTENDED: "yes" }, execArgv: [] }), /interactive/);
  });
  it("refuses node --test", () => {
    assert.match(
      refusalReason({ env: { NODE_TEST_CONTEXT: "child" }, execArgv: [] }),
      /node --test/,
    );
    assert.match(refusalReason({ env: {}, execArgv: ["--test"] }), /node --test/);
  });
  it("allows an interactive run", () => {
    assert.equal(refusalReason({ env: {}, execArgv: [] }), null);
  });
});

describe("buildDeletionEmail", () => {
  it("names the account and the way back", () => {
    const m = buildDeletionEmail({ email: "a@b.c" });
    assert.equal(m.subject, "Your Drafto account has been deleted");
    assert.match(m.text, /your Drafto account \(a@b\.c\)/);
    assert.match(m.text, /https:\/\/drafto\.eu\/signup/);
    assert.match(m.text, /support@drafto\.eu/);
    assert.match(m.html, /<strong>a@b\.c<\/strong>/);
  });
  it("adds the reason, escaped in HTML", () => {
    const m = buildDeletionEmail({ email: "a@b.c", reason: "Unused <since> March" });
    assert.match(m.text, /Unused <since> March/);
    assert.match(m.html, /Unused &lt;since&gt; March/);
    assert.doesNotMatch(m.html, /<since>/);
  });
  it("escapes the address in HTML", () => {
    assert.match(buildDeletionEmail({ email: "a&<b>@c.d" }).html, /a&amp;&lt;b&gt;@c\.d/);
  });
});

describe("userRefusal", () => {
  it("refuses admins and users with notes", () => {
    assert.match(userRefusal({ isAdmin: true, notes: 0 }), /admin/);
    assert.match(userRefusal({ isAdmin: false, notes: 2 }), /owns 2 note/);
  });
  it("allows a user with no notes", () => {
    assert.equal(userRefusal({ isAdmin: false, notes: 0, notebooks: 3 }), null);
  });
});

/** A fetch fake: routes "METHOD path" (query dropped) to a handler. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, search: u.search, body, headers: init.headers });
    const handler = routes[`${method} ${u.pathname}`];
    if (!handler) return new Response("not found", { status: 404 });
    const [status, json, headers = {}] = handler({ url: u, body, calls });
    return new Response(json === undefined ? "" : JSON.stringify(json), { status, headers });
  };
  return { impl, calls };
}

describe("createSupabaseAdmin", () => {
  it("finds users by email across pages, case-insensitively", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `u${i}`, email: `n${i}@x.y` }));
    const { impl, calls } = fakeFetch({
      "GET /auth/v1/admin/users": ({ url }) =>
        url.searchParams.get("page") === "1"
          ? [200, { users: page1 }]
          : [200, { users: [{ id: "t", email: "Target@X.y" }] }],
    });
    const admin = createSupabaseAdmin({ ref: "ref", serviceKey: "svc", fetchImpl: impl });
    const found = await admin.findUsersByEmail(["target@x.y", "n5@x.y"]);
    assert.equal(found.get("target@x.y").id, "t");
    assert.equal(found.get("n5@x.y").id, "u5");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers.apikey, "svc");
    assert.equal(calls[0].headers.Authorization, "Bearer svc");
  });

  it("lists files recursively and removes them in batches", async () => {
    const { impl, calls } = fakeFetch({
      "POST /storage/v1/object/list/attachments": ({ body }) =>
        body.prefix === "u1"
          ? [200, [{ name: "note1", id: null }]]
          : [
              200,
              [
                { name: "a.png", id: "f1" },
                { name: "b.pdf", id: "f2" },
              ],
            ],
      "DELETE /storage/v1/object/attachments": () => [200, []],
    });
    const admin = createSupabaseAdmin({ ref: "ref", serviceKey: "svc", fetchImpl: impl });
    const files = await admin.listFiles("u1");
    assert.deepEqual(files, ["u1/note1/a.png", "u1/note1/b.pdf"]);
    await admin.removeFiles(Array.from({ length: 1500 }, (_, i) => `u1/n/${i}`));
    const deletes = calls.filter((c) => c.method === "DELETE");
    assert.deepEqual(
      deletes.map((c) => c.body.prefixes.length),
      [1000, 500],
    );
  });

  it("counts owned rows exactly, in parallel, and reads the admin flag", async () => {
    const totals = {
      profiles: 1,
      notebooks: 2,
      notes: 0,
      attachments: 3,
      note_content_history: 5,
      api_keys: 0,
    };
    const routes = {};
    for (const [table, n] of Object.entries(totals)) {
      routes[`GET /rest/v1/${table}`] = ({ url }) =>
        url.searchParams.get("select") === "is_admin"
          ? [200, [{ is_admin: true }]]
          : [206, [], { "content-range": `*/${n}` }];
    }
    const { impl, calls } = fakeFetch(routes);
    const admin = createSupabaseAdmin({ ref: "ref", serviceKey: "svc", fetchImpl: impl });
    assert.deepEqual(await admin.owned("u1"), { ...totals, isAdmin: true });
    const countCalls = calls.filter((c) => c.headers.Prefer === "count=exact");
    assert.equal(countCalls.length, 6);
    for (const c of countCalls) assert.match(c.search, /limit=0/);
    assert.match(countCalls.find((c) => c.path.endsWith("/profiles")).search, /[?&]id=eq\.u1/);
    assert.match(countCalls.find((c) => c.path.endsWith("/notes")).search, /user_id=eq\.u1/);
  });

  it("throws when a count has no Content-Range", async () => {
    const { impl } = fakeFetch({
      "GET /rest/v1/profiles": () => [200, []],
      "GET /rest/v1/notebooks": () => [200, []],
      "GET /rest/v1/notes": () => [200, []],
      "GET /rest/v1/attachments": () => [200, []],
      "GET /rest/v1/note_content_history": () => [200, []],
      "GET /rest/v1/api_keys": () => [200, []],
    });
    const admin = createSupabaseAdmin({ ref: "ref", serviceKey: "svc", fetchImpl: impl });
    await assert.rejects(admin.owned("u1"), /count \w+ -> 200/);
  });

  it("reports whether the auth user exists and throws on other errors", async () => {
    let status = 404;
    const { impl } = fakeFetch({ "GET /auth/v1/admin/users/u1": () => [status, {}] });
    const admin = createSupabaseAdmin({ ref: "ref", serviceKey: "svc", fetchImpl: impl });
    assert.equal(await admin.userExists("u1"), false);
    status = 200;
    assert.equal(await admin.userExists("u1"), true);
    status = 500;
    await assert.rejects(admin.userExists("u1"), /500/);
  });

  it("deletes the auth user and surfaces API errors without the key", async () => {
    const { impl } = fakeFetch({ "DELETE /auth/v1/admin/users/u1": () => [500, { msg: "boom" }] });
    const admin = createSupabaseAdmin({ ref: "ref", serviceKey: "svc-secret", fetchImpl: impl });
    await assert.rejects(admin.deleteAuthUser("u1"), (err) => {
      assert.match(err.message, /DELETE \/auth\/v1\/admin\/users\/u1 -> 500/);
      assert.doesNotMatch(err.message, /svc-secret/);
      return true;
    });
  });
});

describe("sendResendEmail", () => {
  it("posts from hello@drafto.eu with a support reply-to", async () => {
    const { impl, calls } = fakeFetch({ "POST /emails": () => [200, { id: "em_1" }] });
    const id = await sendResendEmail({
      apiKey: "re_fake",
      to: "a@b.c",
      subject: "s",
      html: "<p>h</p>",
      text: "t",
      fetchImpl: impl,
    });
    assert.equal(id, "em_1");
    assert.equal(calls[0].headers.Authorization, "Bearer re_fake");
    assert.deepEqual(calls[0].body, {
      from: "Drafto <hello@drafto.eu>",
      to: ["a@b.c"],
      reply_to: "support@drafto.eu",
      subject: "s",
      html: "<p>h</p>",
      text: "t",
    });
  });
  it("throws on a Resend error", async () => {
    const { impl } = fakeFetch({ "POST /emails": () => [422, { message: "bad" }] });
    await assert.rejects(
      sendResendEmail({
        apiKey: "k",
        to: "a@b.c",
        subject: "s",
        html: "h",
        text: "t",
        fetchImpl: impl,
      }),
      /Resend -> 422/,
    );
  });
});

/** An in-memory admin fake that records the order of calls. */
function fakeAdmin({
  users,
  owned = {},
  files = {},
  failRemove = false,
  failDelete = false,
  survive = false,
  notesAppear = false,
  throwOn = null,
}) {
  const events = [];
  const deleted = new Set();
  const empty = {
    profiles: 0,
    isAdmin: false,
    notebooks: 0,
    notes: 0,
    attachments: 0,
    note_content_history: 0,
    api_keys: 0,
  };
  let ownedCalls = 0;
  return {
    events,
    async findUsersByEmail(emails) {
      return new Map(emails.filter((e) => users[e]).map((e) => [e, { id: users[e], email: e }]));
    },
    async owned(id) {
      if (throwOn === id) throw new Error("PostgREST 503");
      if (deleted.has(id) && !survive) return empty;
      ownedCalls++;
      // notesAppear: a note syncs between the plan and the delete.
      const late = notesAppear && ownedCalls > 1 ? { notes: 1 } : {};
      return { ...empty, profiles: 1, ...owned[id], ...late };
    },
    async listFiles(id) {
      return deleted.has(id) ? [] : (files[id] ?? []);
    },
    async removeFiles(paths) {
      events.push(`remove:${paths.length}`);
      if (failRemove) throw new Error("storage down");
    },
    async deleteAuthUser(id) {
      events.push(`delete:${id}`);
      if (failDelete) throw new Error("auth down");
      deleted.add(id);
    },
    async userExists(id) {
      return survive || !deleted.has(id);
    },
  };
}

describe("run", () => {
  const base = { emails: ["a@x.y"], execute: true, notify: true, reason: null };

  it("dry run deletes nothing and sends nothing", async () => {
    const admin = fakeAdmin({ users: { "a@x.y": "u1" } });
    const sent = [];
    const log = [];
    const ok = await run(
      { ...base, execute: false },
      { admin, sendEmail: (m) => sent.push(m), log: (l) => log.push(l) },
    );
    assert.equal(ok, true);
    assert.deepEqual(admin.events, []);
    assert.equal(sent.length, 0);
    assert.match(log.join("\n"), /would delete and email/);
  });

  it("sweeps storage, deletes, sweeps again, then emails", async () => {
    const admin = fakeAdmin({ users: { "a@x.y": "u1" }, files: { u1: ["u1/n/f"] } });
    const sent = [];
    const log = [];
    const ok = await run(
      { ...base, reason: "Unused" },
      {
        admin,
        sendEmail: async (m) => {
          admin.events.push(`email:${m.to}`);
          sent.push(m);
          return "em_1";
        },
        log: (l) => log.push(l),
      },
    );
    assert.equal(ok, true);
    assert.deepEqual(admin.events, ["remove:1", "delete:u1", "remove:0", "email:a@x.y"]);
    assert.match(sent[0].text, /Unused/);
    assert.match(log.join("\n"), /deleted[\s\S]*emailed \(Resend id em_1\)/);
  });

  it("does not email without --notify", async () => {
    const admin = fakeAdmin({ users: { "a@x.y": "u1" } });
    let sent = 0;
    assert.equal(
      await run({ ...base, notify: false }, { admin, sendEmail: () => sent++, log: () => {} }),
      true,
    );
    assert.equal(sent, 0);
    assert.ok(admin.events.includes("delete:u1"));
  });

  it("skips unknown emails and refuses admins and users with notes, continuing with the rest", async () => {
    const admin = fakeAdmin({
      users: { "admin@x.y": "ua", "notes@x.y": "un", "ok@x.y": "uo" },
      owned: { ua: { isAdmin: true }, un: { notes: 4 } },
    });
    const log = [];
    const ok = await run(
      { ...base, notify: false, emails: ["ghost@x.y", "admin@x.y", "notes@x.y", "ok@x.y"] },
      { admin, sendEmail: () => "id", log: (l) => log.push(l) },
    );
    assert.equal(ok, false);
    assert.deepEqual(
      admin.events.filter((e) => e.startsWith("delete")),
      ["delete:uo"],
    );
    const out = log.join("\n");
    assert.match(out, /ghost@x\.y: no such user/);
    assert.match(out, /refused: is an admin/);
    assert.match(out, /refused: owns 4 note/);
  });

  it("leaves the account alone when the storage sweep fails", async () => {
    const admin = fakeAdmin({ users: { "a@x.y": "u1" }, failRemove: true });
    let sent = 0;
    assert.equal(await run(base, { admin, sendEmail: () => sent++, log: () => {} }), false);
    assert.deepEqual(admin.events, ["remove:0"]);
    assert.equal(sent, 0);
  });

  it("sends no email when the auth delete fails", async () => {
    const admin = fakeAdmin({ users: { "a@x.y": "u1" }, failDelete: true });
    let sent = 0;
    assert.equal(await run(base, { admin, sendEmail: () => sent++, log: () => {} }), false);
    assert.equal(sent, 0);
  });

  it("sends no email when the account survives the delete", async () => {
    const admin = fakeAdmin({ users: { "a@x.y": "u1" }, survive: true });
    let sent = 0;
    const log = [];
    assert.equal(
      await run(base, { admin, sendEmail: () => sent++, log: (l) => log.push(l) }),
      false,
    );
    assert.equal(sent, 0);
    assert.match(log.join("\n"), /NOT fully deleted.*no email sent/);
  });

  it("reports a failed email as a failure after deleting", async () => {
    const admin = fakeAdmin({ users: { "a@x.y": "u1" } });
    const log = [];
    const ok = await run(base, {
      admin,
      sendEmail: async () => {
        throw new Error("Resend -> 500");
      },
      log: (l) => log.push(l),
    });
    assert.equal(ok, false);
    assert.ok(admin.events.includes("delete:u1"));
    assert.match(log.join("\n"), /deleted\n {2}email failed: Resend -> 500/);
  });

  it("re-checks for notes just before deleting", async () => {
    const admin = fakeAdmin({ users: { "a@x.y": "u1" }, notesAppear: true });
    let sent = 0;
    const log = [];
    assert.equal(
      await run(base, { admin, sendEmail: () => sent++, log: (l) => log.push(l) }),
      false,
    );
    assert.deepEqual(admin.events, ["remove:0"]);
    assert.equal(sent, 0);
    assert.match(log.join("\n"), /refused before deleting: owns 1 note/);
  });

  it("keeps going with the next user after an error", async () => {
    const admin = fakeAdmin({ users: { "a@x.y": "u1", "b@x.y": "u2" }, throwOn: "u1" });
    const log = [];
    const ok = await run(
      { ...base, notify: false, emails: ["a@x.y", "b@x.y"] },
      { admin, sendEmail: () => "id", log: (l) => log.push(l) },
    );
    assert.equal(ok, false);
    assert.deepEqual(
      admin.events.filter((e) => e.startsWith("delete")),
      ["delete:u2"],
    );
    assert.match(log.join("\n"), /stopped by an error: PostgREST 503/);
  });
});
