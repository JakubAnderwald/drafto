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

describe("state-cli get-issue-zoho-thread-id (issue #422)", () => {
  it("returns bare string with no trailing newline after a 3-arg record-filed-issue", async () => {
    await withTempState(async (file) => {
      const w = run(["record-filed-issue", "700", "customer@example.com", "abc123"], {
        stateFile: file,
      });
      assert.equal(w.status, 0, w.stderr);
      const r = run(["get-issue-zoho-thread-id", "700"], { stateFile: file });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "abc123");
    });
  });

  it("returns empty string for an unknown issue", async () => {
    await withTempState(async (file) => {
      const r = run(["get-issue-zoho-thread-id", "999"], { stateFile: file });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "");
    });
  });

  it("returns empty string for a brand-new state file (ENOENT path)", async () => {
    await withTempState(async (file) => {
      const r = run(["get-issue-zoho-thread-id", "1"], { stateFile: file });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "");
    });
  });

  it("returns empty string for an issue with reporterEmail but no zohoThreadId", async () => {
    await withTempState(async (file) => {
      const w = run(["record-filed-issue", "701", "customer@example.com"], {
        stateFile: file,
      });
      assert.equal(w.status, 0, w.stderr);
      const r = run(["get-issue-zoho-thread-id", "701"], { stateFile: file });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "");
    });
  });

  it("rejects missing issue number", async () => {
    await withTempState(async (file) => {
      const r = run(["get-issue-zoho-thread-id"], { stateFile: file });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /issue-number/i);
    });
  });
});
