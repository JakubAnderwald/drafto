import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  projectSlugForCwd,
  findLatestTranscript,
  detectSessionLimit,
  parseResetTime,
} from "../lib/session-limit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "lib", "session-limit.mjs");

// Build one JSONL transcript line.
function line(obj) {
  return JSON.stringify(obj);
}

function assistantText(text, { isApiErrorMessage = false, timestamp } = {}) {
  const rec = {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
  if (isApiErrorMessage) rec.isApiErrorMessage = true;
  if (timestamp) rec.timestamp = timestamp;
  return line(rec);
}

const LIMIT_TEXT = "You've hit your session limit · resets 10:30am (Europe/Warsaw)";

describe("projectSlugForCwd", () => {
  it("replaces every non-alphanumeric char with a dash (matches claude CLI)", () => {
    assert.equal(
      projectSlugForCwd("/Users/jakub/code/drafto-factory/worktrees/factory-issue-463"),
      "-Users-jakub-code-drafto-factory-worktrees-factory-issue-463",
    );
  });
});

describe("detectSessionLimit", () => {
  it("flags a real-463-shaped transcript (limit assistant, trailing last-prompt)", () => {
    const jsonl = [
      line({ type: "attachment" }),
      line({ type: "last-prompt" }),
      assistantText(LIMIT_TEXT, { isApiErrorMessage: true, timestamp: "2026-07-21T07:11:15.878Z" }),
      line({ type: "last-prompt" }),
      "",
    ].join("\n");
    const r = detectSessionLimit(jsonl, { now: new Date("2026-07-21T05:41:00Z") });
    assert.equal(r.limited, true);
    assert.match(r.reason, /session limit/);
    assert.ok(r.resetAt instanceof Date);
    // 10:30 Warsaw (CEST, UTC+2) = 08:30Z, +2min safety margin.
    assert.equal(r.resetAt.toISOString(), "2026-07-21T08:32:00.000Z");
  });

  it("does NOT flag a 401 auth error as the last assistant record", () => {
    const jsonl = assistantText("Failed to authenticate. API Error: 401 Unauthorized", {
      isApiErrorMessage: true,
      timestamp: "2026-07-21T07:11:15.878Z",
    });
    assert.equal(detectSessionLimit(jsonl).limited, false);
  });

  it("does NOT flag a limit that the session later recovered from", () => {
    const jsonl = [
      assistantText(LIMIT_TEXT, { isApiErrorMessage: true, timestamp: "2026-07-21T07:11:15.878Z" }),
      assistantText("Okay, resuming the task.", { timestamp: "2026-07-21T10:35:00.000Z" }),
    ].join("\n");
    assert.equal(detectSessionLimit(jsonl).limited, false);
  });

  it("flags a limit with an unparseable reset time (resetAt null)", () => {
    const jsonl = assistantText("You've hit your session limit. Try again later.", {
      isApiErrorMessage: true,
      timestamp: "2026-07-21T07:11:15.878Z",
    });
    const r = detectSessionLimit(jsonl);
    assert.equal(r.limited, true);
    assert.equal(r.resetAt, null);
  });

  it("respects --since: a record older than since (beyond slack) is ignored", () => {
    const jsonl = assistantText(LIMIT_TEXT, {
      isApiErrorMessage: true,
      timestamp: "2026-07-21T07:00:00.000Z",
    });
    // since is a full hour newer than the record → stale transcript, not this run.
    assert.equal(detectSessionLimit(jsonl, { since: "2026-07-21T08:00:00.000Z" }).limited, false);
    // Within the 10s slack window → still counts.
    assert.equal(
      detectSessionLimit(jsonl, {
        since: "2026-07-21T07:00:05.000Z",
        now: new Date("2026-07-21T07:00:05Z"),
      }).limited,
      true,
    );
  });

  it("tolerates blank and unparseable lines", () => {
    const jsonl = [
      "",
      "not json at all",
      "{ broken",
      assistantText(LIMIT_TEXT, { isApiErrorMessage: true, timestamp: "2026-07-21T07:11:15.878Z" }),
    ].join("\n");
    assert.equal(
      detectSessionLimit(jsonl, { now: new Date("2026-07-21T05:41:00Z") }).limited,
      true,
    );
  });

  it("returns not-limited for an empty transcript", () => {
    assert.deepEqual(detectSessionLimit(""), { limited: false, reason: null, resetAt: null });
  });
});

describe("parseResetTime", () => {
  const at = (text, nowIso) => parseResetTime(text, new Date(nowIso));

  it("parses am with an explicit IANA zone (summer / DST)", () => {
    assert.equal(
      at("resets 10:30am (Europe/Warsaw)", "2026-07-21T05:41:00Z").toISOString(),
      "2026-07-21T08:32:00.000Z",
    );
  });

  it("parses the same zone in winter (non-DST, UTC+1)", () => {
    assert.equal(
      at("resets 10am (Europe/Warsaw)", "2026-01-15T05:00:00Z").toISOString(),
      "2026-01-15T09:02:00.000Z",
    );
  });

  it("rolls to the next day when the time already passed today", () => {
    // 22:00 Warsaw now; 9am already gone → tomorrow 09:00 Warsaw = 07:00Z +2min.
    assert.equal(
      at("resets 9am (Europe/Warsaw)", "2026-07-21T20:00:00Z").toISOString(),
      "2026-07-22T07:02:00.000Z",
    );
  });

  it("honours an explicit 'tomorrow'", () => {
    assert.equal(
      at("resets tomorrow 10am (Europe/Warsaw)", "2026-07-21T05:00:00Z").toISOString(),
      "2026-07-22T08:02:00.000Z",
    );
  });

  it("maps 12am to midnight and 12pm to noon", () => {
    // 12pm today: 12:00 Warsaw = 10:00Z +2min.
    assert.equal(
      at("resets 12pm (Europe/Warsaw)", "2026-07-21T05:00:00Z").toISOString(),
      "2026-07-21T10:02:00.000Z",
    );
    // 12am (midnight) already passed at 07:00 Warsaw → next day 00:00 Warsaw.
    assert.equal(
      at("resets 12am (Europe/Warsaw)", "2026-07-21T05:00:00Z").toISOString(),
      "2026-07-21T22:02:00.000Z",
    );
  });

  it("parses a minutes-bearing UTC time deterministically", () => {
    assert.equal(
      at("resets 3:15pm (UTC)", "2026-07-21T09:00:00Z").toISOString(),
      "2026-07-21T15:17:00.000Z",
    );
  });

  it("falls back to the host zone (no throw) when the zone is unknown to ICU", () => {
    const d = at("resets 10am (Not/ARealZone)", "2026-07-21T00:00:00Z");
    assert.ok(d instanceof Date, "must still return a Date via host-zone fallback");
  });

  it("returns null when there is no reset clause", () => {
    assert.equal(parseResetTime("some unrelated text"), null);
  });
});

describe("findLatestTranscript + CLI", () => {
  // `await`s fn so the temp dir survives async reads before the finally cleanup.
  async function withProjectsDir(fn) {
    const base = mkdtempSync(path.join(tmpdir(), "session-limit-"));
    try {
      return await fn(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  const cwd = "/Users/x/code/repo/worktrees/factory-issue-999";

  function seed(base, files) {
    const dir = path.join(base, projectSlugForCwd(cwd));
    mkdirSync(dir, { recursive: true });
    for (const { name, content, mtime } of files) {
      const p = path.join(dir, name);
      writeFileSync(p, content);
      if (mtime) utimesSync(p, mtime, mtime);
    }
    return dir;
  }

  it("findLatestTranscript returns the newest .jsonl by mtime", async () => {
    await withProjectsDir(async (base) => {
      const dir = seed(base, [
        { name: "old.jsonl", content: "{}", mtime: new Date("2026-07-21T07:00:00Z") },
        { name: "new.jsonl", content: "{}", mtime: new Date("2026-07-21T09:00:00Z") },
        { name: "ignore.txt", content: "x", mtime: new Date("2026-07-21T10:00:00Z") },
      ]);
      const latest = await findLatestTranscript(base, cwd);
      assert.equal(latest, path.join(dir, "new.jsonl"));
    });
  });

  it("findLatestTranscript returns null when the slug dir is absent", async () => {
    await withProjectsDir(async (base) => {
      assert.equal(await findLatestTranscript(base, "/no/such/cwd"), null);
    });
  });

  function runCli(args) {
    return spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  }

  it("CLI exits 0 with parsed reset JSON when the newest transcript is a limit", async () => {
    await withProjectsDir((base) => {
      seed(base, [
        {
          name: "old.jsonl",
          content: assistantText("all good", { timestamp: "2026-07-21T06:00:00Z" }),
          mtime: new Date("2026-07-21T06:00:00Z"),
        },
        {
          name: "new.jsonl",
          content: assistantText(LIMIT_TEXT, {
            isApiErrorMessage: true,
            timestamp: "2026-07-21T07:11:15.878Z",
          }),
          mtime: new Date("2026-07-21T07:12:00Z"),
        },
      ]);
      const r = runCli([
        "check",
        "--cwd",
        cwd,
        "--projects-dir",
        base,
        "--now",
        "2026-07-21T05:41:00Z",
      ]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.limited, true);
      assert.equal(out.source, "parsed");
      assert.equal(out.resetAt, "2026-07-21T08:32:00.000Z");
    });
  });

  it("CLI exits 1 when the newest transcript is not a limit", async () => {
    await withProjectsDir((base) => {
      seed(base, [
        {
          name: "new.jsonl",
          content: assistantText("finished cleanly", { timestamp: "2026-07-21T07:00:00Z" }),
          mtime: new Date("2026-07-21T07:00:00Z"),
        },
      ]);
      const r = runCli(["check", "--cwd", cwd, "--projects-dir", base]);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, "");
    });
  });

  it("CLI exits 1 (fail-open) when the projects dir is absent", () => {
    const r = runCli(["check", "--cwd", cwd, "--projects-dir", "/no/such/dir"]);
    assert.equal(r.status, 1);
  });

  it("CLI applies --fallback-min when the reset time is unparseable", async () => {
    await withProjectsDir((base) => {
      seed(base, [
        {
          name: "new.jsonl",
          content: assistantText("You've hit your session limit. Please wait.", {
            isApiErrorMessage: true,
            timestamp: "2026-07-21T07:00:00Z",
          }),
          mtime: new Date("2026-07-21T07:00:00Z"),
        },
      ]);
      const r = runCli([
        "check",
        "--cwd",
        cwd,
        "--projects-dir",
        base,
        "--now",
        "2026-07-21T09:00:00Z",
        "--fallback-min",
        "30",
      ]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.source, "fallback");
      assert.equal(out.resetAt, "2026-07-21T09:30:00.000Z");
    });
  });
});
