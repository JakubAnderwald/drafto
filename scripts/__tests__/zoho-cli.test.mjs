import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const TMP_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "zoho-cli-test-"));
const OAUTH_FILE = path.join(TMP_DIR, "zoho-oauth.json");
const BODY_FILE = path.join(TMP_DIR, "body.txt");

before(async () => {
  await fs.writeFile(
    OAUTH_FILE,
    JSON.stringify({
      client_id: "client-x",
      client_secret: "secret-x",
      refresh_token: "refresh-x",
      account_id: "1234567",
      primary_email: "support@drafto.eu",
      datacenter: "eu",
    }),
  );
  await fs.writeFile(BODY_FILE, "hello body");
  process.env.ZOHO_OAUTH_PATH = OAUTH_FILE;
});

after(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

// We import the CLI fresh in each test so the module-level fetch + caches
// are re-initialised. (Node caches modules by URL; using a query-string
// busts that cache without filesystem fiddling.)
let cli;
let calls;
beforeEach(async () => {
  calls = [];
  cli = await import(`../lib/zoho-cli.mjs?t=${Date.now()}-${Math.random()}`);
});

function makeFetch(handlers) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    for (const { match, response } of handlers) {
      if (match(url, init)) {
        const r = typeof response === "function" ? await response(url, init) : response;
        return r;
      }
    }
    return jsonResponse(404, { error: `unmatched fetch ${url}` });
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const tokenHandler = {
  match: (url) => url.startsWith("https://accounts.zoho.eu/oauth/v2/token"),
  response: () => jsonResponse(200, { access_token: "TOKEN-1", expires_in: 3600 }),
};

describe("add-label", () => {
  it("refuses any label outside Drafto/Support/", async () => {
    cli._setFetchForTests(makeFetch([]));
    await assert.rejects(() => cli.addLabel("T1", "Foo/Bar"), /Drafto\/Support\//);
    await assert.rejects(() => cli.addLabel("T1", "Inbox"), /Drafto\/Support\//);
    // No HTTP calls were made before the validation rejected.
    assert.equal(calls.length, 0);
  });

  it("creates the label lazily if missing, then applies it", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url, init) => url.endsWith("/labels") && (init.method ?? "GET") === "GET",
          response: jsonResponse(200, { data: [] }),
        },
        {
          match: (url, init) => url.endsWith("/labels") && init.method === "POST",
          response: jsonResponse(200, {
            data: { labelName: "Drafto/Support/Seen", labelId: "L42" },
          }),
        },
        {
          match: (url, init) => url.endsWith("/messages/applyLabel") && init.method === "POST",
          response: jsonResponse(200, { data: { ok: true } }),
        },
      ]),
    );
    const out = await cli.addLabel("T1", "Drafto/Support/Seen");
    assert.equal(out.ok, true);
    const applyCall = calls.find((c) => c.url.endsWith("/messages/applyLabel"));
    assert.ok(applyCall);
    const applyBody = JSON.parse(applyCall.init.body);
    assert.equal(applyBody.threadId, "T1");
    assert.equal(applyBody.labelId, "L42");
  });
});

describe("move-to-folder", () => {
  it("refuses any folder outside Drafto/Support/", async () => {
    cli._setFetchForTests(makeFetch([]));
    await assert.rejects(() => cli.moveToFolder("T1", "Trash"), /Drafto\/Support\//);
    await assert.rejects(() => cli.moveToFolder("T1", "Drafto/Other"), /Drafto\/Support\//);
  });

  it("creates the folder lazily and moves the thread", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url, init) => url.endsWith("/folders") && (init.method ?? "GET") === "GET",
          response: jsonResponse(200, { data: [] }),
        },
        {
          match: (url, init) => url.endsWith("/folders") && init.method === "POST",
          response: jsonResponse(200, {
            data: { folderName: "Drafto/Support/Resolved", folderId: "F99" },
          }),
        },
        {
          match: (url, init) => url.endsWith("/messages/moveMessage") && init.method === "POST",
          response: jsonResponse(200, { data: { ok: true } }),
        },
      ]),
    );
    const out = await cli.moveToFolder("T1", "Drafto/Support/Resolved");
    assert.equal(out.ok, true);
    const moveCall = calls.find((c) => c.url.endsWith("/messages/moveMessage"));
    assert.ok(moveCall);
    const moveBody = JSON.parse(moveCall.init.body);
    assert.equal(moveBody.destFolderId, "F99");
  });
});

describe("reply / send always set sender to OAuth user", () => {
  it("reply uses primary_email as fromAddress", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url, init) => url.endsWith("/messages") && init.method === "POST",
          response: jsonResponse(200, { data: { sent: true } }),
        },
      ]),
    );
    await cli.replyToThread("T1", BODY_FILE);
    const sendCall = calls.find((c) => c.url.endsWith("/messages") && c.init.method === "POST");
    assert.ok(sendCall);
    const body = JSON.parse(sendCall.init.body);
    assert.equal(body.fromAddress, "support@drafto.eu");
    assert.equal(body.threadId, "T1");
    assert.equal(body.headers["Auto-Submitted"], "auto-replied");
  });

  it("send uses primary_email as fromAddress", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url, init) => url.endsWith("/messages") && init.method === "POST",
          response: jsonResponse(200, { data: { sent: true } }),
        },
      ]),
    );
    await cli.sendFresh({
      to: "jakub@anderwald.info",
      subject: "test",
      bodyFile: BODY_FILE,
    });
    const sendCall = calls.find((c) => c.url.endsWith("/messages") && c.init.method === "POST");
    const body = JSON.parse(sendCall.init.body);
    assert.equal(body.fromAddress, "support@drafto.eu");
    assert.equal(body.toAddress, "jakub@anderwald.info");
    assert.equal(body.subject, "test");
  });
});

describe("OAuth refresh on 401", () => {
  it("retries exactly once after invalidating the token", async () => {
    let labelGetCalls = 0;
    let tokenCalls = 0;
    cli._setFetchForTests(
      makeFetch([
        {
          match: (url) => url.startsWith("https://accounts.zoho.eu/oauth/v2/token"),
          response: () => {
            tokenCalls += 1;
            return jsonResponse(200, {
              access_token: `TOKEN-${tokenCalls}`,
              expires_in: 3600,
            });
          },
        },
        {
          match: (url, init) => url.endsWith("/labels") && (init.method ?? "GET") === "GET",
          response: () => {
            labelGetCalls += 1;
            if (labelGetCalls === 1)
              return jsonResponse(401, { status: { code: "INVALID_OAUTHTOKEN" } });
            return jsonResponse(200, {
              data: [{ labelName: "Drafto/Support/Seen", labelId: "L1" }],
            });
          },
        },
        {
          match: (url, init) => url.endsWith("/messages/applyLabel") && init.method === "POST",
          response: jsonResponse(200, { data: { ok: true } }),
        },
      ]),
    );
    await cli.addLabel("T1", "Drafto/Support/Seen");
    assert.equal(labelGetCalls, 2, "label-get retried exactly once");
    assert.equal(tokenCalls, 2, "token re-fetched after 401");
  });

  it("does not loop forever on persistent 401", async () => {
    let labelGetCalls = 0;
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url, init) => url.endsWith("/labels") && (init.method ?? "GET") === "GET",
          response: () => {
            labelGetCalls += 1;
            return jsonResponse(401, { status: { code: "INVALID_OAUTHTOKEN" } });
          },
        },
      ]),
    );
    await assert.rejects(() => cli.addLabel("T1", "Drafto/Support/Seen"), /401/);
    assert.equal(labelGetCalls, 2, "retried exactly once, then gave up");
  });
});

describe("listPending filters terminal labels", () => {
  it("excludes Agent-Replied/Spam/Linked-Issue threads but keeps Needs-Human", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url, init) => url.endsWith("/folders") && (init.method ?? "GET") === "GET",
          response: jsonResponse(200, { data: [{ folderName: "Inbox", folderId: "INBOX-1" }] }),
        },
        {
          match: (url) => url.includes("/messages/view"),
          response: jsonResponse(200, {
            data: [
              { threadId: "A", subject: "no labels", labels: [] },
              {
                threadId: "B",
                subject: "agent replied",
                labels: [{ labelName: "Drafto/Support/Agent-Replied" }],
              },
              {
                threadId: "C",
                subject: "needs human",
                labels: [{ labelName: "Drafto/Support/Needs-Human" }],
              },
              {
                threadId: "D",
                subject: "linked issue",
                labels: [{ labelName: "Drafto/Support/Linked-Issue/42" }],
              },
              { threadId: "E", subject: "spam", labels: [{ labelName: "Drafto/Support/Spam" }] },
            ],
          }),
        },
      ]),
    );
    const out = await cli.listPending();
    const ids = out.map((m) => m.threadId).sort();
    assert.deepEqual(ids, ["A", "C"]);
  });
});
