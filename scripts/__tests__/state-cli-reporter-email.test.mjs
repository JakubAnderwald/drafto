import { describe, it, beforeEach } from "node:test";
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

describe("state-cli record-filed-issue / get-reporter-email (ADR-0025)", () => {
  it("round-trip: records and reads back a sender", async () => {
    await withTempState(async (file) => {
      const w = run(["record-filed-issue", "361", "jakub@anderwald.info"], { stateFile: file });
      assert.equal(w.status, 0, w.stderr);
      const r = run(["get-reporter-email", "361"], { stateFile: file });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "jakub@anderwald.info");
    });
  });

  it("normalises sender to lower-case + trimmed", async () => {
    await withTempState(async (file) => {
      const w = run(["record-filed-issue", "362", "  Jakub@Anderwald.INFO  "], { stateFile: file });
      assert.equal(w.status, 0, w.stderr);
      const r = run(["get-reporter-email", "362"], { stateFile: file });
      assert.equal(r.stdout, "jakub@anderwald.info");
    });
  });

  it("get-reporter-email returns empty string for unknown issue", async () => {
    await withTempState(async (file) => {
      const r = run(["get-reporter-email", "999"], { stateFile: file });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "");
    });
  });

  it("get-reporter-email handles a brand-new state file (ENOENT path)", async () => {
    await withTempState(async (file) => {
      // Don't create the file at all — loadState should fall through to emptyState.
      const r = run(["get-reporter-email", "1"], { stateFile: file });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "");
    });
  });

  it("preserves other fields on the same issue when re-recording", async () => {
    await withTempState(async (file) => {
      // Seed cursor first, then record sender; sender write must NOT clobber cursor.
      const seedISO = "2026-04-29T20:00:00.000Z";
      const c = run(["set-issue-cursor", "361", seedISO], { stateFile: file });
      assert.equal(c.status, 0, c.stderr);
      const w = run(["record-filed-issue", "361", "joanna@anderwald.info"], { stateFile: file });
      assert.equal(w.status, 0, w.stderr);
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(raw.issues["361"].reporterEmail, "joanna@anderwald.info");
      assert.equal(raw.issues["361"].lastGithubCommentSyncAt, seedISO);
    });
  });

  it("rejects record-filed-issue with missing args", async () => {
    await withTempState(async (file) => {
      const r = run(["record-filed-issue", "361"], { stateFile: file });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /sender-email/i);
    });
  });

  it("rejects record-filed-issue with whitespace-only sender", async () => {
    await withTempState(async (file) => {
      const r = run(["record-filed-issue", "361", "   "], { stateFile: file });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /empty/i);
    });
  });

  it("rejects get-reporter-email with no issue number", async () => {
    await withTempState(async (file) => {
      const r = run(["get-reporter-email"], { stateFile: file });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /issue-number/i);
    });
  });
});
