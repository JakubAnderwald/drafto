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

  it("accepts Phase F linked-issue labels (Issue/<n>, 1-4 digits)", async () => {
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
            data: { displayName: "Drafto/Support/Issue/347", labelId: "L-347" },
          }),
        },
        {
          match: (url, init) => url.endsWith("/updatethread") && init.method === "PUT",
          response: jsonResponse(200, { data: { ok: true } }),
        },
      ]),
    );
    const out = await cli.addLabel("T1", "Drafto/Support/Issue/347");
    assert.equal(out.ok, true);
  });

  it("rejects Phase F linked-issue labels exceeding 4 digits (Zoho 25-char cap)", async () => {
    cli._setFetchForTests(makeFetch([]));
    // `Drafto/Support/Issue/12345` = 26 chars; Zoho would reject the
    // displayName even if we allowed it. Shut it down at the CLI boundary.
    await assert.rejects(
      () => cli.addLabel("T1", "Drafto/Support/Issue/12345"),
      /not in allowlist/,
    );
    // Non-numeric and zero-prefixed are also rejected — keeps the format
    // predictable so future readers can grep for `Issue/<n>` without regex
    // gymnastics.
    await assert.rejects(() => cli.addLabel("T1", "Drafto/Support/Issue/abc"), /not in allowlist/);
    await assert.rejects(() => cli.addLabel("T1", "Drafto/Support/Issue/0123"), /not in allowlist/);
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

describe("reply (unified — always uses inReplyTo + toAddress + subject)", () => {
  function setup() {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url, init) => url.endsWith("/messages") && init.method === "POST",
          response: jsonResponse(200, { data: { sent: true } }),
        },
      ]),
    );
  }

  it("singleton path: routes by inReplyTo + toAddress + subject, no threadId", async () => {
    setup();
    await cli.replyToMessage("MSG-1", BODY_FILE, {
      to: "jane@example.com",
      subject: "How do I import?",
    });
    const sendCall = calls.find((c) => c.url.endsWith("/messages") && c.init.method === "POST");
    assert.ok(sendCall);
    const body = JSON.parse(sendCall.init.body);
    assert.equal(body.fromAddress, "support@drafto.eu");
    assert.equal(body.toAddress, "jane@example.com");
    assert.equal(body.inReplyTo, "MSG-1");
    assert.equal(body.subject, "Re: How do I import?", "auto-prefixes Re: when missing");
    assert.equal(body.threadId, undefined, "no threadId when caller didn't pass one");
    // Zoho's POST /messages rejects unknown top-level keys with
    // EXTRA_KEY_FOUND_IN_JSON; we previously included a `headers` field that
    // was silently bouncing every send. This guard keeps us from re-adding it.
    assert.equal(body.headers, undefined, "must not include the rejected headers key");
  });

  it("threaded path: anchors inReplyTo to the LATEST messageId; never sends threadId", async () => {
    // Zoho rejects `inReplyTo + threadId` together with 404 JSON_PARSE_ERROR
    // (verified live 2026-04-28). Threading is achieved purely through
    // `inReplyTo` — Zoho derives the In-Reply-To/References headers and both
    // its own UI and the customer's mail client group on those.
    setup();
    await cli.replyToMessage("MSG-LATEST", BODY_FILE, {
      to: "jane@example.com",
      subject: "Re: existing thread",
    });
    const body = JSON.parse(
      calls.find((c) => c.url.endsWith("/messages") && c.init.method === "POST").init.body,
    );
    assert.equal(body.inReplyTo, "MSG-LATEST");
    assert.equal(
      body.threadId,
      undefined,
      "must not send threadId alongside inReplyTo (Zoho rejects the combo)",
    );
    // Re: prefix is preserved when already present.
    assert.equal(body.subject, "Re: existing thread");
  });

  it("does not double-prefix Re: (case-insensitive)", async () => {
    setup();
    await cli.replyToMessage("MSG-3", BODY_FILE, {
      to: "jane@example.com",
      subject: "RE: existing thread",
    });
    const body = JSON.parse(
      calls.find((c) => c.url.endsWith("/messages") && c.init.method === "POST").init.body,
    );
    assert.equal(body.subject, "RE: existing thread");
  });

  it("rejects missing required args before hitting the network", async () => {
    setup();
    await assert.rejects(
      cli.replyToMessage("", BODY_FILE, { to: "x", subject: "y" }),
      /messageId required/,
    );
    await assert.rejects(
      cli.replyToMessage("M", "", { to: "x", subject: "y" }),
      /--body-file required/,
    );
    await assert.rejects(
      cli.replyToMessage("M", BODY_FILE, { to: "", subject: "y" }),
      /--to required/,
    );
    await assert.rejects(
      cli.replyToMessage("M", BODY_FILE, { to: "x", subject: "" }),
      /--subject required/,
    );
    // None of these should have made it to the wire.
    const sendCalls = calls.filter((c) => c.url.endsWith("/messages") && c.init.method === "POST");
    assert.equal(sendCalls.length, 0);
  });
});

describe("send always sets sender to OAuth user", () => {
  it("send uses primary_email as fromAddress and omits the headers key", async () => {
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
    assert.equal(body.headers, undefined);
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

describe("findLinkedIssue (Phase F linked-thread detection)", () => {
  it("returns the issue number when any message in the thread carries Drafto/Support/Issue/<n>", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url, init) => url.endsWith("/labels") && (init.method ?? "GET") === "GET",
          response: jsonResponse(200, {
            data: [
              { labelId: "L-NH", displayName: "Drafto/Support/NeedsHuman" },
              { labelId: "L-I-349", displayName: "Drafto/Support/Issue/349" },
            ],
          }),
        },
        {
          match: (url) => url.includes("/messages/view") && url.includes("threadId=THREAD-X"),
          response: jsonResponse(200, {
            data: [
              { messageId: "M1", subject: "first", labelId: ["L-I-349"] },
              { messageId: "M2", subject: "reply", labelId: [] },
            ],
          }),
        },
      ]),
    );
    const out = await cli.findLinkedIssue("THREAD-X");
    assert.equal(out, "349");
  });

  it("returns empty string when no message carries an Issue/<n> label", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url, init) => url.endsWith("/labels") && (init.method ?? "GET") === "GET",
          response: jsonResponse(200, {
            data: [{ labelId: "L-NH", displayName: "Drafto/Support/NeedsHuman" }],
          }),
        },
        {
          match: (url) => url.includes("/messages/view") && url.includes("threadId=THREAD-Y"),
          response: jsonResponse(200, {
            data: [
              { messageId: "M1", labelId: ["L-NH"] },
              { messageId: "M2", labelId: [] },
            ],
          }),
        },
      ]),
    );
    const out = await cli.findLinkedIssue("THREAD-Y");
    assert.equal(out, "");
  });

  it("ignores non-Issue support labels (NeedsHuman, Replied, etc.)", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url, init) => url.endsWith("/labels") && (init.method ?? "GET") === "GET",
          response: jsonResponse(200, {
            data: [
              { labelId: "L-AR", displayName: "Drafto/Support/Replied" },
              { labelId: "L-NH", displayName: "Drafto/Support/NeedsHuman" },
              { labelId: "L-RES", displayName: "Drafto/Support/Resolved" },
            ],
          }),
        },
        {
          match: (url) => url.includes("/messages/view") && url.includes("threadId=THREAD-Z"),
          response: jsonResponse(200, {
            data: [{ messageId: "M1", labelId: ["L-AR", "L-NH", "L-RES"] }],
          }),
        },
      ]),
    );
    const out = await cli.findLinkedIssue("THREAD-Z");
    assert.equal(out, "");
  });

  it("supports inline labels[] shape (test/legacy fallback)", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url, init) => url.endsWith("/labels") && (init.method ?? "GET") === "GET",
          response: jsonResponse(200, { data: [] }),
        },
        {
          match: (url) => url.includes("/messages/view") && url.includes("threadId=THREAD-INLINE"),
          response: jsonResponse(200, {
            data: [
              {
                messageId: "M1",
                labels: [{ displayName: "Drafto/Support/Issue/77" }],
              },
            ],
          }),
        },
      ]),
    );
    const out = await cli.findLinkedIssue("THREAD-INLINE");
    assert.equal(out, "77");
  });

  it("rejects empty threadId before any HTTP call", async () => {
    cli._setFetchForTests(makeFetch([]));
    await assert.rejects(() => cli.findLinkedIssue(""), /threadId required/);
    assert.equal(calls.length, 0);
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

describe("getAttachmentInfo", () => {
  it("hits /attachmentinfo and merges regular + inline arrays", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url) => url.includes("/folders/INBOX-1/messages/MSG-9/attachmentinfo"),
          response: jsonResponse(200, {
            status: { code: 200, description: "success" },
            data: {
              attachments: [
                {
                  attachmentId: "138907275303090130",
                  attachmentName: "test.odt",
                  attachmentSize: 6737,
                },
                {
                  attachmentId: "138907275303110000",
                  attachmentName: "spathiphyllum.jpg",
                  attachmentSize: 15321,
                },
              ],
              inline: [
                {
                  attachmentId: "138907275356550040",
                  attachmentName: "import.jpg",
                  attachmentSize: 71730,
                  cid: "0.28869215390.9068479665823862258@example",
                },
              ],
              messageId: "1671434730313114778",
            },
          }),
        },
      ]),
    );
    const out = await cli.getAttachmentInfo("INBOX-1", "MSG-9");
    assert.equal(out.length, 3);
    // Regular attachments come first, normalised.
    assert.deepEqual(out[0], {
      attachmentId: "138907275303090130",
      filename: "test.odt",
      size: 6737,
      isInline: false,
    });
    assert.deepEqual(out[1], {
      attachmentId: "138907275303110000",
      filename: "spathiphyllum.jpg",
      size: 15321,
      isInline: false,
    });
    // Inline attachments come last and carry the cid.
    assert.deepEqual(out[2], {
      attachmentId: "138907275356550040",
      filename: "import.jpg",
      size: 71730,
      isInline: true,
      cid: "0.28869215390.9068479665823862258@example",
    });
    // Hit the right URL.
    const call = calls.find((c) => c.url.includes("/attachmentinfo"));
    assert.ok(call);
    assert.equal(call.init.method ?? "GET", "GET");
  });

  it("returns [] when both arrays are empty or missing", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url) => url.includes("/attachmentinfo"),
          response: jsonResponse(200, { data: { messageId: "MSG-9" } }),
        },
      ]),
    );
    const out = await cli.getAttachmentInfo("INBOX-1", "MSG-9");
    assert.deepEqual(out, []);
  });

  it("requires both folderId and messageId", async () => {
    cli._setFetchForTests(makeFetch([]));
    await assert.rejects(() => cli.getAttachmentInfo("", "MSG-9"), /folderId required/);
    await assert.rejects(() => cli.getAttachmentInfo("INBOX-1", ""), /messageId required/);
    assert.equal(calls.length, 0);
  });

  it("surfaces errors via err.body (Zoho error JSON)", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url) => url.includes("/attachmentinfo"),
          response: jsonResponse(404, {
            status: { code: 404, description: "URL_RULE_NOT_CONFIGURED" },
            data: { errorCode: "URL_RULE_NOT_CONFIGURED" },
          }),
        },
      ]),
    );
    await assert.rejects(
      () => cli.getAttachmentInfo("INBOX-1", "MSG-9"),
      (err) => {
        assert.equal(err.status, 404);
        assert.equal(err.body?.data?.errorCode, "URL_RULE_NOT_CONFIGURED");
        return true;
      },
    );
  });
});

describe("downloadAttachment", () => {
  // PNG magic header — used to assert we wrote real bytes, not a JSON-decoded
  // string of them. If the binary path goes through the JSON branch, the
  // first 4 bytes of the file would be ASCII (`{`/`"`) instead of these.
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function binaryResponse(buffer, headers = {}) {
    return new Response(buffer, {
      status: 200,
      headers: { "Content-Type": "image/png", "Content-Length": String(buffer.length), ...headers },
    });
  }

  it("writes the raw bytes to --out and returns contentType from response header", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url) => url.includes("/folders/INBOX-1/messages/MSG-9/attachments/ATT-1"),
          response: () => binaryResponse(PNG_MAGIC),
        },
      ]),
    );
    const outPath = path.join(TMP_DIR, "screenshot.png");
    const result = await cli.downloadAttachment("INBOX-1", "MSG-9", "ATT-1", { out: outPath });
    assert.equal(result.contentType, "image/png");
    assert.equal(result.size, PNG_MAGIC.length);
    assert.equal(result.path, outPath);
    // No Content-Disposition supplied → falls back to basename.
    assert.equal(result.filename, "screenshot.png");
    const written = await fs.readFile(outPath);
    assert.deepEqual(Uint8Array.from(written), Uint8Array.from(PNG_MAGIC));
  });

  it("parses filename from Content-Disposition when present (RFC 2616)", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url) => url.includes("/attachments/ATT-2"),
          response: () =>
            binaryResponse(PNG_MAGIC, {
              "Content-Disposition": 'attachment; filename="real-name.png"',
            }),
        },
      ]),
    );
    const outPath = path.join(TMP_DIR, "fallback-name.png");
    const result = await cli.downloadAttachment("INBOX-1", "MSG-9", "ATT-2", { out: outPath });
    assert.equal(result.filename, "real-name.png");
  });

  it("parses filename* (RFC 5987 UTF-8 form) when present", async () => {
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url) => url.includes("/attachments/ATT-3"),
          response: () =>
            binaryResponse(PNG_MAGIC, {
              "Content-Disposition": "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.png",
            }),
        },
      ]),
    );
    const outPath = path.join(TMP_DIR, "ignored.png");
    const result = await cli.downloadAttachment("INBOX-1", "MSG-9", "ATT-3", { out: outPath });
    assert.equal(result.filename, "résumé.png");
  });

  it("retries once on 401 after invalidating the cached access token", async () => {
    let attempt = 0;
    cli._setFetchForTests(
      makeFetch([
        tokenHandler,
        {
          match: (url) => url.includes("/attachments/ATT-4"),
          response: () => {
            attempt += 1;
            if (attempt === 1) {
              return new Response(JSON.stringify({ data: { errorCode: "INVALID_OAUTHTOKEN" } }), {
                status: 401,
                headers: { "Content-Type": "application/json" },
              });
            }
            return binaryResponse(PNG_MAGIC);
          },
        },
      ]),
    );
    const outPath = path.join(TMP_DIR, "retried.png");
    const result = await cli.downloadAttachment("INBOX-1", "MSG-9", "ATT-4", { out: outPath });
    assert.equal(attempt, 2);
    assert.equal(result.size, PNG_MAGIC.length);
  });

  it("requires --out and all positional args", async () => {
    cli._setFetchForTests(makeFetch([]));
    await assert.rejects(
      () => cli.downloadAttachment("", "MSG-9", "ATT-1", { out: path.join(TMP_DIR, "x.png") }),
      /folderId required/,
    );
    await assert.rejects(
      () => cli.downloadAttachment("INBOX-1", "", "ATT-1", { out: path.join(TMP_DIR, "x.png") }),
      /messageId required/,
    );
    await assert.rejects(
      () => cli.downloadAttachment("INBOX-1", "MSG-9", "", { out: path.join(TMP_DIR, "x.png") }),
      /attachmentId required/,
    );
    await assert.rejects(
      () => cli.downloadAttachment("INBOX-1", "MSG-9", "ATT-1", { out: "" }),
      /--out required/,
    );
    assert.equal(calls.length, 0);
  });

  it("refuses to write outside TMPDIR", async () => {
    cli._setFetchForTests(makeFetch([]));
    // /etc/passwd is not under TMPDIR — reject before any HTTP call.
    await assert.rejects(
      () => cli.downloadAttachment("INBOX-1", "MSG-9", "ATT-1", { out: "/etc/passwd" }),
      /refusing to write attachment outside TMPDIR/,
    );
    assert.equal(calls.length, 0);
  });

  it("refuses to write into the repo CWD (TMPDIR-only guard)", async () => {
    cli._setFetchForTests(makeFetch([]));
    // Even an in-repo path like ./logs/foo.png is rejected — the guard
    // exists so a stray --out pointing at the working tree can't accidentally
    // commit binaries via the agent.
    const repoRelative = path.resolve(process.cwd(), "logs", "stray.png");
    await assert.rejects(
      () => cli.downloadAttachment("INBOX-1", "MSG-9", "ATT-1", { out: repoRelative }),
      /refusing to write attachment outside TMPDIR/,
    );
    assert.equal(calls.length, 0);
  });
});
