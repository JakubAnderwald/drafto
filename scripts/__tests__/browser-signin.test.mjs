import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEV_SUPABASE_URL,
  LEASE_BUSY_EXIT,
  LeaseBusyError,
  MINT_TIMEOUT_MS,
  acquireLease,
  buildSignInUrl,
  keyFileProblem,
  mint,
  mintHashedToken,
  moveLeaseAside,
  parseKeyFile,
  readLease,
  releaseLease,
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
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let out;
  try {
    out = fn({ dir, keyFile, accountFile });
  } catch (err) {
    cleanup();
    throw err;
  }
  // An async body keeps its files until it has finished.
  if (out && typeof out.then === "function") return out.finally(cleanup);
  cleanup();
  return out;
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

// The sign-in lease. Supabase keeps one live magic-link token per user, so the
// browser runner's link (opened a minute or more after the mint) dies if the
// verification shell lane mints for the same account in between. Both take
// this lease before minting. What must hold: one holder at a time, taken
// atomically; a live lease of another owner is busy; an expired one can be
// taken over; only its owner removes it; and no lease file means today's mint.
describe("sign-in lease", () => {
  const OWNER = "browser:verify:501:0123456789ab";
  const SHELL = "shell:501:0123456789ab";
  const T0 = Date.parse("2026-10-21T12:00:00Z");

  function withDir(fn) {
    const dir = mkdtempSync(path.join(tmpdir(), "signin-lease-"));
    try {
      return fn({ dir, file: path.join(dir, "factory-signin.lease") });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("acquires a free lease atomically: one mode-600 file, no temp file left", () => {
    withDir(({ dir, file }) => {
      const got = acquireLease({ file, owner: OWNER, holdSec: 300, now: T0 });
      assert.equal(got.ok, true);
      assert.equal(got.takenOver, false);
      const held = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(held.owner, OWNER);
      assert.equal(held.pid, process.pid);
      assert.equal(held.acquiredAt, "2026-10-21T12:00:00.000Z");
      assert.equal(held.until, "2026-10-21T12:05:00.000Z");
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(dir), ["factory-signin.lease"]);
    });
  });

  it("reports a live lease of another owner as busy, and leaves it alone", () => {
    withDir(({ dir, file }) => {
      acquireLease({ file, owner: OWNER, holdSec: 300, now: T0 });
      const before = readFileSync(file, "utf8");
      const got = acquireLease({ file, owner: SHELL, holdSec: 60, now: T0 + 299_000 });
      assert.deepEqual(got, {
        ok: false,
        busy: true,
        owner: OWNER,
        until: "2026-10-21T12:05:00.000Z",
      });
      assert.equal(readFileSync(file, "utf8"), before);
      assert.deepEqual(readdirSync(dir), ["factory-signin.lease"]);
    });
  });

  it("takes over an expired lease, and confirms the takeover", () => {
    withDir(({ file }) => {
      acquireLease({ file, owner: OWNER, holdSec: 300, now: T0 });
      const got = acquireLease({ file, owner: SHELL, holdSec: 60, now: T0 + 300_001 });
      assert.equal(got.ok, true);
      assert.equal(got.takenOver, true);
      assert.equal(readLease(file).owner, SHELL);
      assert.equal(readLease(file).nonce, got.lease.nonce);
    });
  });

  it("takes over a lease file it can't read as one", () => {
    withDir(({ file }) => {
      writeFileSync(file, "not json", { mode: 0o600 });
      assert.deepEqual(readLease(file), { invalid: true, raw: "not json" });
      const got = acquireLease({ file, owner: SHELL, holdSec: 60, now: T0 });
      assert.equal(got.ok, true);
      assert.equal(readLease(file).owner, SHELL);
    });
  });

  it("lets an owner take its own live lease again (a retry after a crash)", () => {
    withDir(({ file }) => {
      acquireLease({ file, owner: OWNER, holdSec: 300, now: T0 });
      const got = acquireLease({ file, owner: OWNER, holdSec: 300, now: T0 + 60_000 });
      assert.equal(got.ok, true);
      assert.equal(readLease(file).until, "2026-10-21T12:06:00.000Z");
    });
  });

  it("removes a lease only if it is still the one that was read (compare-and-swap)", () => {
    // The browser runner releases after its lease has usually expired, when
    // the shell lane may be taking it over in the same moment.
    withDir(({ dir, file }) => {
      acquireLease({ file, owner: OWNER, holdSec: 300, now: T0 });
      const seen = readLease(file).raw;
      // Taken over after the read: the slot holds someone else's lease now.
      acquireLease({ file, owner: SHELL, holdSec: 60, now: T0 + 400_000 });
      const now = readFileSync(file, "utf8");
      assert.equal(moveLeaseAside(file, seen), false, "not the lease that was read");
      assert.equal(readFileSync(file, "utf8"), now, "put back as it was");
      assert.deepEqual(readdirSync(dir), ["factory-signin.lease"], "nothing left aside");
      assert.equal(moveLeaseAside(file, now), true);
      assert.ok(!existsSync(file));
      assert.equal(moveLeaseAside(file, now), true, "an empty slot is empty");
    });
  });

  it("refuses to take over a lease file it can't read at all", () => {
    if (process.getuid?.() === 0) return; // root reads anything
    withDir(({ file }) => {
      acquireLease({ file, owner: OWNER, holdSec: 1, now: T0 });
      chmodSync(file, 0o000);
      try {
        assert.throws(
          () => acquireLease({ file, owner: SHELL, holdSec: 60, now: T0 + 5_000 }),
          /lease file can't be read/,
        );
      } finally {
        chmodSync(file, 0o600);
      }
    });
  });

  it("releases only for its owner", () => {
    withDir(({ file }) => {
      assert.deepEqual(releaseLease({ file, owner: OWNER }), { released: false, reason: "none" });
      acquireLease({ file, owner: OWNER, holdSec: 300, now: T0 });
      // A holder whose lease expired and was taken over must not remove the new one.
      assert.deepEqual(releaseLease({ file, owner: SHELL }), {
        released: false,
        reason: "not-owner",
        owner: OWNER,
      });
      assert.ok(existsSync(file));
      assert.deepEqual(releaseLease({ file, owner: OWNER }), { released: true });
      assert.ok(!existsSync(file));
    });
  });

  it("refuses an owner that isn't a plain label, and a hold that isn't a positive integer", () => {
    withDir(({ file }) => {
      for (const owner of ["", "has space", "line\nbreak", ":leading", undefined]) {
        assert.throws(() => acquireLease({ file, owner, holdSec: 60 }), /invalid lease owner/);
      }
      for (const holdSec of [0, -1, 1.5, "60", undefined]) {
        assert.throws(() => acquireLease({ file, owner: OWNER, holdSec }), /invalid lease hold/);
      }
      assert.ok(!existsSync(file));
    });
  });
});

describe("mint with a lease", () => {
  const LEASE_NAME = "factory-signin.lease";
  const ok = () => stubFetch({ status: 200, body: { hashed_token: TOKEN } });

  it("takes the lease before the request and leaves it held for the caller", async () => {
    await withFiles(async ({ dir, keyFile, accountFile }) => {
      const file = path.join(dir, LEASE_NAME);
      const calls = [];
      const fetchImpl = async (url, init) => {
        // The lease is in place by the time the token is asked for.
        calls.push(readLease(file)?.owner ?? null);
        return ok()(url, init);
      };
      const link = await mint({
        keyFile,
        accountFile,
        origin: ORIGIN,
        fetchImpl,
        lease: { file, owner: "browser:intest:7:aaaaaaaaaaaa", holdSec: 300 },
      });
      assert.match(link, /\/auth\/test-sign-in\?token_hash=/);
      assert.deepEqual(calls, ["browser:intest:7:aaaaaaaaaaaa"]);
      assert.equal(readLease(file).owner, "browser:intest:7:aaaaaaaaaaaa");
    });
  });

  it("throws LeaseBusyError and sends no request while another owner holds it", async () => {
    await withFiles(async ({ dir, keyFile, accountFile }) => {
      const file = path.join(dir, LEASE_NAME);
      acquireLease({ file, owner: "browser:verify:7:aaaaaaaaaaaa", holdSec: 300 });
      const calls = [];
      await assert.rejects(
        mint({
          keyFile,
          accountFile,
          origin: ORIGIN,
          fetchImpl: stubFetch({ status: 200, body: { hashed_token: TOKEN } }, calls),
          lease: { file, owner: "shell:7:aaaaaaaaaaaa", holdSec: 60 },
        }),
        (err) => {
          assert.ok(err instanceof LeaseBusyError);
          assert.equal(err.busy, true);
          assert.equal(err.owner, "browser:verify:7:aaaaaaaaaaaa");
          assert.match(err.until, /^\d{4}-\d\d-\d\dT/);
          return true;
        },
      );
      assert.equal(calls.length, 0, "no token minted over the holder's link");
      assert.equal(readLease(file).owner, "browser:verify:7:aaaaaaaaaaaa");
    });
  });

  it("gives the lease back when minting fails", async () => {
    await withFiles(async ({ dir, keyFile, accountFile }) => {
      const file = path.join(dir, LEASE_NAME);
      await assert.rejects(
        mint({
          keyFile,
          accountFile,
          origin: ORIGIN,
          fetchImpl: stubFetch({ status: 500, body: { msg: "boom" } }),
          lease: { file, owner: "shell:7:aaaaaaaaaaaa", holdSec: 60 },
        }),
        /HTTP 500/,
      );
      assert.ok(!existsSync(file));
    });
  });

  it("takes no lease when a local check fails first", async () => {
    await withFiles(
      async ({ dir, keyFile, accountFile }) => {
        const file = path.join(dir, LEASE_NAME);
        await assert.rejects(
          mint({
            keyFile,
            accountFile,
            origin: ORIGIN,
            fetchImpl: ok(),
            lease: { file, owner: "shell:7:aaaaaaaaaaaa", holdSec: 60 },
          }),
          /key file mode/,
        );
        assert.ok(!existsSync(file));
      },
      { keyMode: 0o644 },
    );
  });

  it("fails open with a warning when the lease file can't be used at all", async () => {
    await withFiles(async ({ dir, keyFile, accountFile }) => {
      const warnings = [];
      const link = await mint({
        keyFile,
        accountFile,
        origin: ORIGIN,
        fetchImpl: ok(),
        lease: {
          file: path.join(dir, "missing-dir", LEASE_NAME),
          owner: "shell:7:aaaaaaaaaaaa",
          holdSec: 60,
        },
        onWarning: (m) => warnings.push(m),
      });
      assert.match(link, /\/auth\/test-sign-in\?token_hash=/);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /sign-in lease couldn't be used .*minting without it/);
    });
  });

  it("still throws on a lease the caller got wrong, rather than failing open", async () => {
    await withFiles(async ({ dir, keyFile, accountFile }) => {
      await assert.rejects(
        mint({
          keyFile,
          accountFile,
          origin: ORIGIN,
          fetchImpl: ok(),
          lease: { file: path.join(dir, LEASE_NAME), owner: "has space", holdSec: 60 },
          onWarning: () => assert.fail("not a lease file problem"),
        }),
        /invalid lease owner/,
      );
    });
  });

  it("caps the generate_link request, so a lease never sits behind a hung one", async () => {
    const calls = [];
    await mintHashedToken({
      url: DEV_SUPABASE_URL,
      serviceRoleKey: KEY,
      email: "bot@example.com",
      fetchImpl: stubFetch({ status: 200, body: { hashed_token: TOKEN } }, calls),
    });
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    assert.equal(MINT_TIMEOUT_MS, 30_000);
  });

  it("mints exactly as before with no lease: no lease file anywhere", async () => {
    await withFiles(async ({ dir, keyFile, accountFile }) => {
      const link = await mint({ keyFile, accountFile, origin: ORIGIN, fetchImpl: ok() });
      assert.equal(link, `${ORIGIN}/auth/test-sign-in?token_hash=${TOKEN}&next=%2F`);
      assert.deepEqual(readdirSync(dir).sort(), ["browser-account.env", "dev-supabase-admin.env"]);
    });
  });

  it("starts no process and never names --chrome: the lease is files only", () => {
    const src = readFileSync(CLI, "utf8");
    assert.doesNotMatch(src, /child_process/);
    assert.doesNotMatch(src, /["'`]--chrome["'`]/);
  });
});

describe("CLI: the lease", () => {
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

  it("exits 3 with one JSON line, and mints nothing, while another owner holds the lease", () => {
    withFiles(({ dir, keyFile, accountFile }) => {
      const file = path.join(dir, "factory-signin.lease");
      const held = acquireLease({ file, owner: "shell:501:aaaaaaaaaaaa", holdSec: 60 });
      const r = run([
        "mint",
        "--key-file",
        keyFile,
        "--account-file",
        accountFile,
        "--origin",
        ORIGIN,
        "--lease-file",
        file,
        "--owner",
        "browser:verify:501:aaaaaaaaaaaa",
        "--hold-sec",
        "300",
      ]);
      assert.equal(r.status, LEASE_BUSY_EXIT);
      assert.equal(LEASE_BUSY_EXIT, 3);
      assert.deepEqual(JSON.parse(r.stdout), {
        busy: true,
        owner: "shell:501:aaaaaaaaaaaa",
        until: held.lease.until,
      });
      assert.equal(r.stdout.trim().split("\n").length, 1);
      assert.equal(r.stderr, "");
      assert.doesNotMatch(r.stdout + r.stderr, new RegExp(KEY));
    });
  });

  it("releases for the owner only", () => {
    withFiles(({ dir }) => {
      const file = path.join(dir, "factory-signin.lease");
      acquireLease({ file, owner: "browser:intest:8:bbbbbbbbbbbb", holdSec: 300 });
      let r = run(["release", "--lease-file", file, "--owner", "shell:8:bbbbbbbbbbbb"]);
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(r.stdout).released, false);
      assert.ok(existsSync(file));
      r = run(["release", "--lease-file", file, "--owner", "browser:intest:8:bbbbbbbbbbbb"]);
      assert.equal(r.status, 0);
      assert.deepEqual(JSON.parse(r.stdout), { released: true });
      assert.ok(!existsSync(file));
    });
  });

  it("rejects half a lease on the command line with exit 1", () => {
    withFiles(({ dir, keyFile, accountFile }) => {
      const file = path.join(dir, "factory-signin.lease");
      const base = [
        "mint",
        "--key-file",
        keyFile,
        "--account-file",
        accountFile,
        "--origin",
        ORIGIN,
      ];
      for (const extra of [
        ["--owner", "shell:1:aaaaaaaaaaaa"],
        ["--hold-sec", "60"],
        ["--lease-file", file],
        ["--lease-file", file, "--owner", "shell:1:aaaaaaaaaaaa", "--hold-sec", "5m"],
      ]) {
        const r = run([...base, ...extra]);
        assert.equal(r.status, 1, extra.join(" "));
        assert.match(r.stderr, /browser-signin: /);
        assert.equal(r.stdout, "");
      }
      assert.equal(run(["release", "--lease-file", file]).status, 1);
      assert.ok(!existsSync(file));
    });
  });
});

// Two real processes racing for the lease, released at the same instant: the
// browser runner's --browser tick and the shell lane's supervisor are the two
// minters. Exactly one may come away holding it, whether the slot is free or
// holds an expired lease both of them take over.
describe("sign-in lease: two rivals", () => {
  const RIVAL = `
    import { acquireLease } from ${JSON.stringify(path.resolve(HERE, "..", "lib", "browser-signin.mjs"))};
    const [file, owner, goAt] = process.argv.slice(1);
    while (Date.now() < Number(goAt)) {}
    const got = acquireLease({ file, owner, holdSec: 60 });
    process.stdout.write(JSON.stringify({ owner, ok: got.ok }));
  `;

  function race(file) {
    const goAt = String(Date.now() + 400);
    const rivals = ["browser:verify:9:aaaaaaaaaaaa", "shell:9:aaaaaaaaaaaa"].map(
      (owner) =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--input-type=module", "-e", RIVAL, file, owner, goAt],
            {
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let out = "";
          let err = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (err += d));
          child.on("close", (code) =>
            code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err || `exit ${code}`)),
          );
        }),
    );
    return Promise.all(rivals);
  }

  it("gives the lease to exactly one of them, every round", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "signin-lease-race-"));
    try {
      for (let round = 0; round < 12; round++) {
        const file = path.join(dir, `lease-${round}`);
        // Even rounds: an expired lease both take over. Odd rounds: a free slot.
        if (round % 2 === 0) {
          acquireLease({
            file,
            owner: "browser:intest:1:bbbbbbbbbbbb",
            holdSec: 1,
            now: Date.now() - 60_000,
          });
        }
        const results = await race(file);
        const winners = results.filter((r) => r.ok);
        assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(results)}`);
        assert.equal(readLease(file).owner, winners[0].owner, `round ${round}`);
        assert.deepEqual(
          readdirSync(dir).filter((n) => n.startsWith(`lease-${round}.`)),
          [],
          "no temp or set-aside file left behind",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
