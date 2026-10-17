import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEV_SUPABASE_URL,
  buildSignInUrl,
  keyFileProblem,
  mint,
  mintHashedToken,
  parseKeyFile,
} from "../lib/browser-signin.mjs";

// The runner's one-time preview sign-in link (ADR-0051). Claude in Chrome
// won't type a password on a preview, so the runner opens a link minted here
// from the dev service-role key. What must hold: only the dev project, only a
// Drafto preview origin, only the route that verifies the token, and the key
// never in any output.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "lib", "browser-signin.mjs");
const ORIGIN = "https://drafto-eoxciykkp-jakubanderwalds-projects.vercel.app";
const KEY = "service-role-secret-value-1234567890";
const TOKEN = "a".repeat(56);

function withFiles(
  fn,
  {
    key = `DEV_SUPABASE_URL=${DEV_SUPABASE_URL}\nDEV_SUPABASE_SERVICE_ROLE_KEY=${KEY}\n`,
    keyMode = 0o600,
  } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "browser-signin-"));
  const keyFile = path.join(dir, "dev-supabase-admin.env");
  const accountFile = path.join(dir, "browser-account.env");
  writeFileSync(keyFile, key);
  chmodSync(keyFile, keyMode);
  writeFileSync(
    accountFile,
    "FACTORY_BROWSER_EMAIL=bot@example.com\nFACTORY_BROWSER_PASSWORD=pw-123456\n",
  );
  chmodSync(accountFile, 0o600);
  try {
    return fn({ dir, keyFile, accountFile });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stubFetch(response, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    };
  };
}

describe("parseKeyFile", () => {
  it("reads the dev URL and key, quoted or not", () => {
    const k = parseKeyFile(
      `DEV_SUPABASE_URL="${DEV_SUPABASE_URL}/"\nDEV_SUPABASE_SERVICE_ROLE_KEY='${KEY}'\n`,
    );
    assert.deepEqual(k, { url: DEV_SUPABASE_URL, serviceRoleKey: KEY });
  });

  it("refuses any project but dev, so a prod key can never mint a link", () => {
    assert.throws(
      () =>
        parseKeyFile(
          `DEV_SUPABASE_URL=https://tbmjbxxseonkciqovnpl.supabase.co\nDEV_SUPABASE_SERVICE_ROLE_KEY=${KEY}\n`,
        ),
      /not for the dev project/,
    );
  });

  it("names a missing key without echoing any value", () => {
    assert.throws(
      () => parseKeyFile(`DEV_SUPABASE_URL=${DEV_SUPABASE_URL}\n`),
      (err) => {
        assert.match(err.message, /DEV_SUPABASE_SERVICE_ROLE_KEY/);
        return true;
      },
    );
    assert.throws(
      () => parseKeyFile(`DEV_SUPABASE_SERVICE_ROLE_KEY=${KEY}\n`),
      (err) => {
        assert.doesNotMatch(err.message, new RegExp(KEY));
        return true;
      },
    );
  });
});

describe("keyFileProblem", () => {
  it("accepts mode 600 and refuses a file others can read", () => {
    withFiles(({ keyFile }) => assert.equal(keyFileProblem(keyFile), null));
    withFiles(({ keyFile }) => assert.equal(keyFileProblem(keyFile), "mode"), { keyMode: 0o644 });
    assert.equal(keyFileProblem("/nonexistent/key.env"), "missing");
  });
});

describe("buildSignInUrl", () => {
  it("points at the preview's own /auth/test-sign-in with the token and next=/", () => {
    const u = new URL(buildSignInUrl(ORIGIN, TOKEN));
    assert.equal(u.origin, ORIGIN);
    assert.equal(u.pathname, "/auth/test-sign-in");
    assert.equal(u.searchParams.get("token_hash"), TOKEN);
    assert.equal(u.searchParams.get("next"), "/");
  });

  it("refuses anything but a Drafto preview origin", () => {
    for (const origin of [
      "https://drafto.eu",
      "http://drafto-x-jakubanderwalds-projects.vercel.app",
      "https://drafto-x-jakubanderwalds-projects.vercel.app.evil.example",
      "https://vercel.com",
      "",
    ]) {
      assert.throws(() => buildSignInUrl(origin, TOKEN), /not a Drafto preview origin/, origin);
    }
  });

  it("refuses a missing or odd token", () => {
    for (const t of [undefined, "", "short", "has spaces in it 1234567890", "a/b".repeat(10)]) {
      assert.throws(() => buildSignInUrl(ORIGIN, t), /no usable hashed_token/);
    }
  });
});

describe("mintHashedToken", () => {
  it("asks dev GoTrue's admin generate_link for a magic link, with the key as apikey and bearer", async () => {
    const calls = [];
    const t = await mintHashedToken({
      url: DEV_SUPABASE_URL,
      serviceRoleKey: KEY,
      email: "bot@example.com",
      fetchImpl: stubFetch({ status: 200, body: { hashed_token: TOKEN } }, calls),
    });
    assert.equal(t, TOKEN);
    assert.equal(calls[0].url, `${DEV_SUPABASE_URL}/auth/v1/admin/generate_link`);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.apikey, KEY);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      type: "magiclink",
      email: "bot@example.com",
    });
  });

  it("reads a nested properties.hashed_token too", async () => {
    const t = await mintHashedToken({
      url: DEV_SUPABASE_URL,
      serviceRoleKey: KEY,
      email: "bot@example.com",
      fetchImpl: stubFetch({ status: 200, body: { properties: { hashed_token: TOKEN } } }),
    });
    assert.equal(t, TOKEN);
  });

  it("reports GoTrue's reason on failure, never the key", async () => {
    await assert.rejects(
      mintHashedToken({
        url: DEV_SUPABASE_URL,
        serviceRoleKey: KEY,
        email: "bot@example.com",
        fetchImpl: stubFetch({ status: 404, body: { msg: "User not found" } }),
      }),
      (err) => {
        assert.match(err.message, /HTTP 404 \(User not found\)/);
        assert.doesNotMatch(err.message, new RegExp(KEY));
        return true;
      },
    );
  });
});

describe("mint", () => {
  it("mints for the account file's email and returns the link", async () => {
    await withFiles(async ({ keyFile, accountFile }) => {
      const calls = [];
      const link = await mint({
        keyFile,
        accountFile,
        origin: ORIGIN,
        fetchImpl: stubFetch({ status: 200, body: { hashed_token: TOKEN } }, calls),
      });
      assert.equal(link, `${ORIGIN}/auth/test-sign-in?token_hash=${TOKEN}&next=%2F`);
      assert.equal(JSON.parse(calls[0].init.body).email, "bot@example.com");
    });
  });

  it("refuses a key file others can read before reading it", async () => {
    await withFiles(
      async ({ keyFile, accountFile }) => {
        await assert.rejects(
          mint({
            keyFile,
            accountFile,
            origin: ORIGIN,
            fetchImpl: stubFetch({ status: 200, body: {} }),
          }),
          /key file mode/,
        );
      },
      { keyMode: 0o644 },
    );
  });
});

describe("CLI", () => {
  it("fails with exit 1 and no secret on stderr when minting can't work", () => {
    withFiles(({ keyFile, accountFile }) => {
      const r = spawnSync(
        process.execPath,
        [
          CLI,
          "mint",
          "--key-file",
          keyFile,
          "--account-file",
          accountFile,
          "--origin",
          "https://drafto.eu",
        ],
        {
          encoding: "utf8",
        },
      );
      assert.equal(r.status, 1);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /browser-signin: /);
      assert.doesNotMatch(r.stderr + r.stdout, new RegExp(KEY));
    });
  });

  it("rejects an unknown command", () => {
    const r = spawnSync(process.execPath, [CLI, "print-key"], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage/);
  });
});
