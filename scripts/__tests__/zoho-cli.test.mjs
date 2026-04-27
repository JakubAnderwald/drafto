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
    { mode: 0o600 },
  );
  // Some platforms ignore the `mode` flag on writeFile (umask differences) —
  // chmod explicitly so loadConfig's 0600 sanity check is satisfied.
  await fs.chmod(OAUTH_FILE, 0o600);
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

  it("refuses empty-leaf, double-slash, and control-char labels", async () => {
    cli._setFetchForTests(makeFetch([]));
    await assert.rejects(() => cli.addLabel("T1", "Drafto/Support/"), /Drafto\/Support\//);
    await assert.rejects(() => cli.addLabel("T1", "Drafto/Support//Foo"), /Drafto\/Support\//);
    await assert.rejects(() => cli.addLabel("T1", "Drafto/Support/Bad\x01"), /Drafto\/Support\//);
    assert.equal(calls.length, 0);
  });

  it("refuses labels not in the suffix allowlist (anti-drift guard)", async () => {
    cli._setFetchForTests(makeFetch([]));
    // The first live Phase D run produced an unintended `Drafto/Support/Stuck`
    // label because the prompt's documented label was 26 chars (over Zoho's
    // 25-char limit) and the agent improvised. The closed allowlist makes
    // that drift impossible — only the documented suffixes pass.
    await assert.rejects(() => cli.addLabel("T1", "Drafto/Support/Stuck"), /not in allowlist/);
    await assert.rejects(() => cli.addLabel("T1", "Drafto/Support/Custom"), /not in allowlist/);
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
          match: (url, init) => url.endsWith("/updatethread") && init.method === "PUT",
          response: jsonResponse(200, { data: { ok: true } }),
        },
      ]),
    );
    const out = await cli.addLabel("T1", "Drafto/Support/Seen");
    assert.equal(out.ok, true);
    const applyCall = calls.find((c) => c.url.endsWith("/updatethread"));
    assert.ok(applyCall);
    assert.equal(applyCall.init.method, "PUT");
    const applyBody = JSON.parse(applyCall.init.body);
    assert.equal(applyBody.mode, "applyLabel");
    assert.deepEqual(applyBody.threadId, ["T1"]);
    assert.deepEqual(applyBody.labelId, ["L42"]);
  });
});

describe("add-message-label", () => {
  it("refuses any label outside Drafto/Support/", async () => {
    cli._setFetchForTests(makeFetch([]));
    await assert.rejects(() => cli.addMessageLabel("M1", "Foo/Bar"), /Drafto\/Support\//);
    assert.equal(calls.length, 0);
  });

  it("creates the label lazily, then PUTs /updatemessage with messageId", async () => {
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
          match: (url, init) => url.endsWith("/updatemessage") && init.method === "PUT",
          response: jsonResponse(200, { data: { ok: true } }),
        },
      ]),
    );
    const out = await cli.addMessageLabel("MSG-X", "Drafto/Support/Seen");
    assert.equal(out.ok, true);
    const applyCall = calls.find((c) => c.url.endsWith("/updatemessage"));
    assert.ok(applyCall);
    const applyBody = JSON.parse(applyCall.init.body);
    assert.equal(applyBody.mode, "applyLabel");
    assert.deepEqual(applyBody.messageId, ["MSG-X"]);
    assert.deepEqual(applyBody.labelId, ["L42"]);
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
          match: (url, init) => url.endsWith("/updatemessage") && init.method === "PUT",
          response: jsonResponse(200, { data: { ok: true } }),
        },
      ]),
    );
    const out = await cli.moveToFolder("T1", "Drafto/Support/Resolved");
    assert.equal(out.ok, true);
    const moveCall = calls.find((c) => c.url.endsWith("/updatemessage"));
    assert.ok(moveCall);
    assert.equal(moveCall.init.method, "PUT");
    const moveBody = JSON.parse(moveCall.init.body);
    assert.equal(moveBody.mode, "moveMessage");
    assert.deepEqual(moveBody.threadId, ["T1"]);
    // Note: lowercase 'f' in destfolderId — capital-ID has been observed to
    // return EXTRA_KEY_FOUND_IN_JSON.
    assert.equal(moveBody.destfolderId, "F99");
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
          match: (url, init) => url.endsWith("/updatethread") && init.method === "PUT",
          response: jsonResponse(200, { data: { ok: true } }),
        },
      ]),
    );
    await cli.addLabel("T1", "Drafto/Support/Seen");
    assert.equal(labelGetCalls, 2, "label-get retried exactly once");
    assert.equal(tokenCalls, 2, "token re-fetched after 401");
    // The retried label-get must use the NEW access token, not the stale one.
    const labelGets = calls.filter(
      (c) => c.url.endsWith("/labels") && (c.init.method ?? "GET") === "GET",
    );
    assert.equal(labelGets[0].init.headers.Authorization, "Zoho-oauthtoken TOKEN-1");
    assert.equal(labelGets[1].init.headers.Authorization, "Zoho-oauthtoken TOKEN-2");
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

// support-agent.sh fires several short-lived `node scripts/lib/zoho-cli.mjs`
// processes per launchd interval. Without an on-disk cache, each one would
// refresh the OAuth token and we'd hit Zoho's "too many requests" cap.
describe("OAuth disk cache", () => {
  // Per-test cache file inside TMP_DIR — overrides the default
  // <oauth-dir>/zoho-token-cache.json so tests can isolate their state.
  const TOKEN_CACHE_FILE = path.join(TMP_DIR, `token-cache-${Date.now()}.json`);

  beforeEach(() => {
    process.env.ZOHO_TOKEN_CACHE_PATH = TOKEN_CACHE_FILE;
  });

  after(() => {
    delete process.env.ZOHO_TOKEN_CACHE_PATH;
  });

  it("hydrates the second process from disk and skips the refresh", async () => {
    let tokenCalls = 0;
    const fetchA = makeFetch([
      {
        match: (url) => url.startsWith("https://accounts.zoho.eu/oauth/v2/token"),
        response: () => {
          tokenCalls += 1;
          return jsonResponse(200, { access_token: "DISK-TOKEN", expires_in: 3600 });
        },
      },
      {
        match: (url, init) => url.endsWith("/labels") && (init.method ?? "GET") === "GET",
        response: jsonResponse(200, {
          data: [{ labelName: "Drafto/Support/Seen", labelId: "L1" }],
        }),
      },
      {
        match: (url, init) => url.endsWith("/updatethread") && init.method === "PUT",
        response: jsonResponse(200, { data: { ok: true } }),
      },
    ]);
    cli._setFetchForTests(fetchA);
    await cli.addLabel("T1", "Drafto/Support/Seen");
    assert.equal(tokenCalls, 1, "first process refreshes once");
    const onDisk = JSON.parse(await fs.readFile(TOKEN_CACHE_FILE, "utf8"));
    assert.equal(onDisk.value, "DISK-TOKEN");
    const stat = await fs.stat(TOKEN_CACHE_FILE);
    assert.equal(stat.mode & 0o777, 0o600, "token cache file is mode 0600");

    // Simulate a second Node process by re-importing zoho-cli.mjs (cache-bust)
    // — that gives us a fresh in-memory cache, so getAccessToken must consult
    // the disk to find DISK-TOKEN.
    const cli2 = await import(`../lib/zoho-cli.mjs?t=${Date.now()}-disk-cache`);
    const fetchB = makeFetch([
      {
        match: (url) => url.startsWith("https://accounts.zoho.eu/oauth/v2/token"),
        response: () => {
          tokenCalls += 1;
          return jsonResponse(200, { access_token: "WOULD-NOT-USE", expires_in: 3600 });
        },
      },
      {
        match: (url, init) => url.endsWith("/labels") && (init.method ?? "GET") === "GET",
        response: jsonResponse(200, {
          data: [{ labelName: "Drafto/Support/Seen", labelId: "L1" }],
        }),
      },
      {
        match: (url, init) => url.endsWith("/updatethread") && init.method === "PUT",
        response: jsonResponse(200, { data: { ok: true } }),
      },
    ]);
    cli2._setFetchForTests(fetchB);
    // _setFetchForTests calls _resetForTests which (now) clears the disk cache
    // — undo that for this test, since we want to assert the disk path.
    await fs.writeFile(TOKEN_CACHE_FILE, JSON.stringify(onDisk), { mode: 0o600 });
    await fs.chmod(TOKEN_CACHE_FILE, 0o600);

    await cli2.addLabel("T2", "Drafto/Support/Seen");
    assert.equal(tokenCalls, 1, "second process reused disk token instead of refreshing");
    const labelGet = calls.find(
      (c) => c.url.endsWith("/labels") && (c.init.method ?? "GET") === "GET" && c.init.headers,
    );
    assert.ok(labelGet);
    // The disk-hydrated token must be the one in use.
    const labelCalls = calls.filter((c) => c.url.endsWith("/labels"));
    assert.equal(
      labelCalls[labelCalls.length - 1].init.headers.Authorization,
      "Zoho-oauthtoken DISK-TOKEN",
    );
  });
});

describe("listPending filters terminal labels", () => {
  it("excludes Replied/Spam/legacy threads but keeps NeedsHuman (real labelId[] shape)", async () => {
    // Real Zoho /messages/view surface: each message carries `labelId: [<id>]`,
    // not full label objects. The lib resolves IDs against /labels.
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url, init) => url.endsWith("/folders") && (init.method ?? "GET") === "GET",
          response: jsonResponse(200, { data: [{ folderName: "Inbox", folderId: "INBOX-1" }] }),
        },
        {
          match: (url, init) => url.endsWith("/labels") && (init.method ?? "GET") === "GET",
          response: jsonResponse(200, {
            data: [
              { labelId: "L-AR", displayName: "Drafto/Support/Replied" },
              { labelId: "L-NH", displayName: "Drafto/Support/NeedsHuman" },
              // Phase F's "linked-issue" label name is not yet finalised
              // (must fit Zoho's 25-char cap); this fixture name is just a
              // placeholder to verify isTerminalSupportLabel filters it.
              { labelId: "L-LI42", displayName: "Drafto/Support/LegacyTerm" },
              { labelId: "L-SP", displayName: "Drafto/Support/Spam" },
            ],
          }),
        },
        {
          match: (url) => url.includes("/messages/view"),
          response: jsonResponse(200, {
            data: [
              { threadId: "A", messageId: "MA", subject: "no labels" },
              {
                threadId: "B",
                messageId: "MB",
                subject: "agent replied",
                labelId: ["L-AR"],
              },
              {
                threadId: "C",
                messageId: "MC",
                subject: "needs human",
                labelId: ["L-NH"],
              },
              {
                threadId: "D",
                messageId: "MD",
                subject: "linked issue",
                labelId: ["L-LI42"],
              },
              {
                threadId: "E",
                messageId: "ME",
                subject: "spam",
                labelId: ["L-SP"],
              },
            ],
          }),
        },
      ]),
    );
    const out = await cli.listPending();
    const ids = out.map((m) => m.threadId).sort();
    assert.deepEqual(ids, ["A", "C"]);
  });

  it("also accepts inline `labels: [{displayName}]` objects (legacy shape)", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url, init) => url.endsWith("/folders") && (init.method ?? "GET") === "GET",
          response: jsonResponse(200, { data: [{ folderName: "Inbox", folderId: "INBOX-1" }] }),
        },
        {
          match: (url, init) => url.endsWith("/labels") && (init.method ?? "GET") === "GET",
          response: jsonResponse(200, { data: [] }),
        },
        {
          match: (url) => url.includes("/messages/view"),
          response: jsonResponse(200, {
            data: [
              { threadId: "A", messageId: "MA", subject: "no labels", labels: [] },
              {
                threadId: "B",
                messageId: "MB",
                subject: "agent replied",
                labels: [{ displayName: "Drafto/Support/Replied" }],
              },
            ],
          }),
        },
      ]),
    );
    const out = await cli.listPending();
    assert.deepEqual(
      out.map((m) => m.threadId),
      ["A"],
    );
  });

  // Inbox listing returns one entry per message — two messages in the same
  // thread share a threadId and would otherwise be processed twice in one run.
  // Filtering happens before dedupe; first occurrence wins (Zoho returns
  // newest-first, so the most recent message represents the thread).
  it("dedupes by threadId, keeping the first occurrence", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url, init) => url.endsWith("/folders") && (init.method ?? "GET") === "GET",
          response: jsonResponse(200, { data: [{ folderName: "Inbox", folderId: "INBOX-1" }] }),
        },
        {
          match: (url, init) => url.endsWith("/labels") && (init.method ?? "GET") === "GET",
          response: jsonResponse(200, { data: [] }),
        },
        {
          match: (url) => url.includes("/messages/view"),
          response: jsonResponse(200, {
            data: [
              { threadId: "T1", messageId: "M1-newer", subject: "reply 2" },
              { threadId: "T1", messageId: "M1-older", subject: "reply 1" },
              { threadId: "T2", messageId: "M2", subject: "another thread" },
              // No threadId at all — should fall back to messageId for keying.
              { messageId: "M3", subject: "orphan" },
            ],
          }),
        },
      ]),
    );
    const out = await cli.listPending();
    assert.equal(out.length, 3);
    assert.equal(out[0].messageId, "M1-newer", "first-occurrence (newest) wins for T1");
    assert.equal(out[1].threadId, "T2");
    assert.equal(out[2].messageId, "M3");
  });
});

describe("getThread", () => {
  it("calls /messages/view with threadId query and returns the data array", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url) => url.includes("/messages/view") && url.includes("threadId=THREAD-7"),
          response: jsonResponse(200, {
            data: [
              { messageId: "M1", threadId: "THREAD-7", folderId: "INBOX-1", subject: "first" },
              { messageId: "M2", threadId: "THREAD-7", folderId: "INBOX-1", subject: "reply" },
            ],
          }),
        },
      ]),
    );
    const out = await cli.getThread("THREAD-7");
    assert.equal(Array.isArray(out), true);
    assert.equal(out.length, 2);
    assert.equal(out[0].messageId, "M1");
    assert.equal(out[1].subject, "reply");
    const call = calls.find((c) => c.url.includes("/messages/view"));
    assert.ok(call.url.includes("threadId=THREAD-7"));
    assert.ok(!call.url.includes("folderId="));
  });

  it("rejects empty threadId before any HTTP call", async () => {
    cli._setFetchForTests(makeFetch([]));
    await assert.rejects(() => cli.getThread(""), /threadId required/);
    assert.equal(calls.length, 0);
  });
});

describe("getHeaders", () => {
  it("uses the folder-scoped path and parses headerContent CRLF blob", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url) =>
            url.includes("/folders/INBOX-1/messages/MSG-9/header") && !url.includes("?"),
          response: jsonResponse(200, {
            data: {
              headerContent:
                "Delivered-To: support@drafto.eu\r\nFrom: jane@example.com\r\nSubject: hi\r\nReceived: a\r\nReceived: b\r\n",
            },
          }),
        },
      ]),
    );
    const out = await cli.getHeaders("INBOX-1", "MSG-9");
    assert.equal(out["Delivered-To"], "support@drafto.eu");
    assert.equal(out.From, "jane@example.com");
    assert.equal(out.Subject, "hi");
    // Repeated header names are collapsed comma-separated by parseRawHeaders.
    assert.equal(out.Received, "a, b");
  });

  it("requires both folderId and messageId", async () => {
    cli._setFetchForTests(makeFetch([]));
    await assert.rejects(() => cli.getHeaders("", "MSG-9"), /folderId required/);
    await assert.rejects(() => cli.getHeaders("INBOX-1", ""), /messageId required/);
    assert.equal(calls.length, 0);
  });
});
