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
