import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "lib", "state-cli.mjs");

let workdir;
let stateFile;

before(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "state-cli-test-"));
  stateFile = path.join(workdir, "support-state.json");
});

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function run(args, { stdin } = {}) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    input: stdin,
  });
}

describe("state-cli bump-notification", () => {
  it("creates the state file and stamps lastAdminNotificationAt", () => {
    const now = "2026-04-27T12:00:00.000Z";
    const r = run(["bump-notification", "T-1", "--state-file", stateFile, "--now", now]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.trackKey, "T-1");
    assert.equal(out.lastAdminNotificationAt, now);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.threads["T-1"].lastAdminNotificationAt, now);
  });

  it("preserves prior state when bumping a different thread", () => {
    const now1 = "2026-04-27T12:00:00.000Z";
    const now2 = "2026-04-27T13:00:00.000Z";
    writeFileSync(
      stateFile,
      JSON.stringify({
        issues: {},
        threads: { "T-A": { autoReplies: [], lastAdminNotificationAt: now1 } },
        senders: {},
        global: { autoRepliesByDay: {} },
      }),
    );
    const r = run(["bump-notification", "T-B", "--state-file", stateFile, "--now", now2]);
    assert.equal(r.status, 0, r.stderr);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.threads["T-A"].lastAdminNotificationAt, now1);
    assert.equal(state.threads["T-B"].lastAdminNotificationAt, now2);
  });

  it("rejects missing track-key", () => {
    const r = run(["bump-notification", "--state-file", stateFile]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /requires <track-key>/);
  });
});

describe("state-cli bump-counters (Phase E)", () => {
  it("appends thread + sender + global counters", () => {
    const fresh = path.join(workdir, "phase-e.json");
    const now = "2026-04-27T12:00:00.000Z";
    const r = run([
      "bump-counters",
      "T-100",
      "Jane@Example.com",
      "--state-file",
      fresh,
      "--now",
      now,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.trackKey, "T-100");
    assert.equal(out.sender, "Jane@Example.com");
    const state = JSON.parse(readFileSync(fresh, "utf8"));
    assert.deepEqual(state.threads["T-100"].autoReplies, [now]);
    // Sender key is lowercased by policy.bumpCounters.
    assert.deepEqual(state.senders["jane@example.com"].autoReplies, [now]);
    assert.equal(state.global.autoRepliesByDay["2026-04-27"], 1);
  });

  it("rejects missing sender", () => {
    const r = run(["bump-counters", "T-100", "--state-file", stateFile]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /<track-key> <sender>/);
  });

  it("loads existing state and adds to it without clobbering other threads", () => {
    const fresh = path.join(workdir, "phase-e-merge.json");
    const earlier = "2026-04-27T11:00:00.000Z";
    const now = "2026-04-27T12:00:00.000Z";
    writeFileSync(
      fresh,
      JSON.stringify({
        issues: {},
        threads: {
          "T-OTHER": { autoReplies: [earlier], lastAdminNotificationAt: null },
        },
        senders: { "other@example.com": { autoReplies: [earlier] } },
        global: { autoRepliesByDay: { "2026-04-27": 1 } },
      }),
    );
    const r = run([
      "bump-counters",
      "T-100",
      "jane@example.com",
      "--state-file",
      fresh,
      "--now",
      now,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const state = JSON.parse(readFileSync(fresh, "utf8"));
    assert.deepEqual(state.threads["T-OTHER"].autoReplies, [earlier]);
    assert.deepEqual(state.threads["T-100"].autoReplies, [now]);
    assert.deepEqual(state.senders["other@example.com"].autoReplies, [earlier]);
    assert.deepEqual(state.senders["jane@example.com"].autoReplies, [now]);
    assert.equal(state.global.autoRepliesByDay["2026-04-27"], 2);
  });
});

describe("state-cli usage / errors", () => {
  it("prints usage on no args", () => {
    const r = run([]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Usage: state-cli\.mjs/);
  });

  it("rejects unknown subcommand", () => {
    const r = run(["bogus"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Unknown subcommand/);
  });

  it("written state file exists on disk after success", () => {
    assert.ok(existsSync(stateFile));
  });
});
