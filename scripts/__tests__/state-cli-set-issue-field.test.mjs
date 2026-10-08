import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "lib", "state-cli.mjs");

function run(args, { stateFile } = {}) {
  const allArgs = stateFile ? [...args, "--state-file", stateFile] : args;
  return spawnSync("node", [CLI, ...allArgs], { encoding: "utf8" });
}

async function withTempState(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "state-cli-test-"));
  const file = path.join(dir, "state.json");
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("state-cli set-issue-field (issue #422)", () => {
  it("rejects fields not in the allowlist", async () => {
    await withTempState(async (file) => {
      const r = run(["set-issue-field", "600", "lastKnownState", "foo"], {
        stateFile: file,
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /allowlist/i);
    });
  });

  it("rejects empty / whitespace-only values", async () => {
    await withTempState(async (file) => {
      const r = run(["set-issue-field", "600", "zohoThreadId", "   "], {
        stateFile: file,
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /empty/i);
    });
  });

  it("writes zohoThreadId and mirrors onto the thread entry", async () => {
    await withTempState(async (file) => {
      // Seed reporterEmail so the mirror can pick it up for fromAddress.
      const seed = run(["record-filed-issue", "601", "customer@example.com"], {
        stateFile: file,
      });
      assert.equal(seed.status, 0, seed.stderr);
      const w = run(["set-issue-field", "601", "zohoThreadId", "7777"], {
        stateFile: file,
      });
      assert.equal(w.status, 0, w.stderr);
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(raw.issues["601"].zohoThreadId, "7777");
      assert.equal(raw.threads["7777"].linkedIssue, "601");
      assert.equal(raw.threads["7777"].fromAddress, "customer@example.com");
    });
  });

  it("writes zohoThreadId without a prior reporterEmail (no fromAddress mirror)", async () => {
    await withTempState(async (file) => {
      const w = run(["set-issue-field", "602", "zohoThreadId", "8888"], {
        stateFile: file,
      });
      assert.equal(w.status, 0, w.stderr);
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(raw.issues["602"].zohoThreadId, "8888");
      assert.equal(raw.threads["8888"].linkedIssue, "602");
      assert.equal(raw.threads["8888"].fromAddress, undefined);
    });
  });

  it("writes reporterEmail lower-cased + trimmed and does NOT touch threads when no linkage exists", async () => {
    await withTempState(async (file) => {
      const w = run(["set-issue-field", "603", "reporterEmail", "  Customer@Example.COM  "], {
        stateFile: file,
      });
      assert.equal(w.status, 0, w.stderr);
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(raw.issues["603"].reporterEmail, "customer@example.com");
      assert.equal(Object.keys(raw.threads ?? {}).length, 0);
    });
  });

  it("updates threads[<id>].fromAddress when reporterEmail changes on a linked issue", async () => {
    await withTempState(async (file) => {
      // Seed a fully-linked record (record-filed-issue 3-arg form mirrors
      // fromAddress onto the thread side at filing time).
      const seed = run(["record-filed-issue", "606", "old@example.com", "thread-606"], {
        stateFile: file,
      });
      assert.equal(seed.status, 0, seed.stderr);
      // Now override the email — the threads mirror should follow.
      const w = run(["set-issue-field", "606", "reporterEmail", "  New@Example.COM  "], {
        stateFile: file,
      });
      assert.equal(w.status, 0, w.stderr);
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(raw.issues["606"].reporterEmail, "new@example.com");
      assert.equal(raw.threads["thread-606"].fromAddress, "new@example.com");
      assert.equal(raw.threads["thread-606"].linkedIssue, "606");
    });
  });

  it("preserves other fields on the same issue", async () => {
    await withTempState(async (file) => {
      // Seed a cursor + email, then overwrite just the zohoThreadId.
      const c = run(["set-issue-cursor", "604", "2026-05-23T10:00:00.000Z"], {
        stateFile: file,
      });
      assert.equal(c.status, 0, c.stderr);
      const e = run(["record-filed-issue", "604", "customer@example.com"], {
        stateFile: file,
      });
      assert.equal(e.status, 0, e.stderr);
      const w = run(["set-issue-field", "604", "zohoThreadId", "9999"], {
        stateFile: file,
      });
      assert.equal(w.status, 0, w.stderr);
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(raw.issues["604"].zohoThreadId, "9999");
      assert.equal(raw.issues["604"].reporterEmail, "customer@example.com");
      assert.equal(raw.issues["604"].lastGithubCommentSyncAt, "2026-05-23T10:00:00.000Z");
    });
  });

  it("rejects missing args", async () => {
    await withTempState(async (file) => {
      const r1 = run(["set-issue-field", "605"], { stateFile: file });
      assert.notEqual(r1.status, 0);
      const r2 = run(["set-issue-field", "605", "zohoThreadId"], {
        stateFile: file,
      });
      assert.notEqual(r2.status, 0);
    });
  });
});

describe("state-cli set-issue-field — message-id routing fields (issue #658)", () => {
  it("accepts zohoMessageId and zohoSubject without touching threads", async () => {
    await withTempState(async (file) => {
      const a = run(["set-issue-field", "610", "zohoMessageId", " 1791172614617005600 "], {
        stateFile: file,
      });
      assert.equal(a.status, 0, a.stderr);
      const b = run(["set-issue-field", "610", "zohoSubject", "Sync broken on iPad"], {
        stateFile: file,
      });
      assert.equal(b.status, 0, b.stderr);
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(raw.issues["610"].zohoMessageId, "1791172614617005600");
      assert.equal(raw.issues["610"].zohoSubject, "Sync broken on iPad");
      assert.equal(Object.keys(raw.threads ?? {}).length, 0);
    });
  });

  for (const literal of ["null", "NULL", " Null ", "undefined", "Undefined"]) {
    it(`rejects the literal ${JSON.stringify(literal)} for every allowlisted field`, async () => {
      await withTempState(async (file) => {
        for (const field of [
          "zohoThreadId",
          "zohoMessageId",
          "zohoSubject",
          "reporterEmail",
          "lastGithubCommentSyncAt",
        ]) {
          const r = run(["set-issue-field", "611", field, literal], { stateFile: file });
          assert.notEqual(r.status, 0, `${field}=${literal} should be refused`);
          assert.match(r.stderr, /refusing literal/i);
        }
        // Nothing was written — no issue entry, no "null" thread key.
        const exists = await fs
          .access(file)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          const raw = JSON.parse(await fs.readFile(file, "utf8"));
          assert.equal(raw.issues?.["611"], undefined);
          assert.equal(raw.threads?.null, undefined);
        }
      });
    });
  }
});

describe("state-cli set-issue-field — cursor bootstrap when a route appears after filing", () => {
  const NOW = "2026-10-08T12:00:00.000Z";

  it("starts the comment cursor at now when a backfill makes an issue routable", async () => {
    await withTempState(async (file) => {
      // A pre-fix singleton: reporter recorded, no route.
      const seed = run(["record-filed-issue", "658", "jakub@anderwald.info"], { stateFile: file });
      assert.equal(seed.status, 0, seed.stderr);
      const w = run(
        ["set-issue-field", "658", "zohoMessageId", "1791172614617005600", "--now", NOW],
        {
          stateFile: file,
        },
      );
      assert.equal(w.status, 0, w.stderr);
      assert.equal(JSON.parse(w.stdout).cursorBootstrappedAt, NOW);
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(raw.issues["658"].lastGithubCommentSyncAt, NOW);
    });
  });

  it("bootstraps only on the write that completes the route (message id first, reporter later)", async () => {
    await withTempState(async (file) => {
      const a = run(["set-issue-field", "612", "zohoMessageId", "M-612", "--now", NOW], {
        stateFile: file,
      });
      assert.equal(a.status, 0, a.stderr);
      assert.equal(JSON.parse(a.stdout).cursorBootstrappedAt, null, "no recipient yet");
      let raw = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(raw.issues["612"].lastGithubCommentSyncAt, undefined);
      const b = run(["set-issue-field", "612", "reporterEmail", "a@b.co", "--now", NOW], {
        stateFile: file,
      });
      assert.equal(b.status, 0, b.stderr);
      assert.equal(JSON.parse(b.stdout).cursorBootstrappedAt, NOW);
      raw = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(raw.issues["612"].lastGithubCommentSyncAt, NOW);
    });
  });

  it("bootstraps when a linked reply's thread is the issue's first route", async () => {
    await withTempState(async (file) => {
      const w = run(["set-issue-field", "613", "zohoThreadId", "T-613", "--now", NOW], {
        stateFile: file,
      });
      assert.equal(w.status, 0, w.stderr);
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(raw.issues["613"].lastGithubCommentSyncAt, NOW);
    });
  });

  it("leaves an existing cursor alone", async () => {
    await withTempState(async (file) => {
      const c = run(["set-issue-cursor", "614", "2026-10-01T00:00:00.000Z"], { stateFile: file });
      assert.equal(c.status, 0, c.stderr);
      const w = run(["set-issue-field", "614", "zohoThreadId", "T-614", "--now", NOW], {
        stateFile: file,
      });
      assert.equal(w.status, 0, w.stderr);
      assert.equal(JSON.parse(w.stdout).cursorBootstrappedAt, null);
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(raw.issues["614"].lastGithubCommentSyncAt, "2026-10-01T00:00:00.000Z");
    });
  });

  it("does not bootstrap an issue that was already routable from filing", async () => {
    await withTempState(async (file) => {
      // Filed with a message route; comment-sync must still start from createdAt.
      const seed = run(
        ["record-filed-issue", "615", "a@b.co", "", "--message-id", "M-615", "--subject", "Hi"],
        { stateFile: file },
      );
      assert.equal(seed.status, 0, seed.stderr);
      let raw = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(raw.issues["615"].lastGithubCommentSyncAt, undefined, "filing sets no cursor");
      // A later linked reply upgrades it to the thread route: no bootstrap.
      const w = run(["set-issue-field", "615", "zohoThreadId", "T-615", "--now", NOW], {
        stateFile: file,
      });
      assert.equal(w.status, 0, w.stderr);
      assert.equal(JSON.parse(w.stdout).cursorBootstrappedAt, null);
      raw = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(raw.issues["615"].lastGithubCommentSyncAt, undefined);
    });
  });
});
