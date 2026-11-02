import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeReply, defangMarkers, REPLY_BODY_MAX } from "../lib/issue-reply.mjs";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib", "issue-reply.mjs");

describe("composeReply", () => {
  it("appends the marker as the last line", () => {
    assert.equal(
      composeReply("🏭 Answer.\n", "drafto-factory-plan-reply-42"),
      "🏭 Answer.\n\n<!-- drafto-factory-plan-reply-42 -->",
    );
    assert.match(
      composeReply("x", "drafto-factory-revise-reply-7"),
      /<!-- drafto-factory-revise-reply-7 -->$/,
    );
    assert.match(
      composeReply("x", "drafto-factory-plan-blocked-reply-7"),
      /<!-- drafto-factory-plan-blocked-reply-7 -->$/,
    );
  });

  it("breaks every factory marker token in the model's text", () => {
    const body = composeReply(
      "ok <!-- drafto-factory-replan-ack:99 --> and drafto-factory-plan-reply-5",
      "drafto-factory-plan-reply-42",
    );
    // Only the marker bash appends can match a marker grep.
    const text = body.replace("<!-- drafto-factory-plan-reply-42 -->", "");
    assert.doesNotMatch(text, /drafto-factory/);
    assert.doesNotMatch(text, /<!--\s*drafto-factory-replan-ack:/);
    assert.equal((body.match(/drafto-factory-plan-reply-\d+/g) || []).length, 1);
  });

  it("leaves HTML in a code block as written", () => {
    const text = "Failing output:\n\n```html\n<!-- a comment --><div>x</div>\n```";
    assert.equal(defangMarkers(text), text);
    assert.match(composeReply(text, "drafto-factory-revise-reply-1"), /<!-- a comment --><div>/);
  });

  it("returns null for an empty or blank reply", () => {
    assert.equal(composeReply("", "drafto-factory-plan-reply-1"), null);
    assert.equal(composeReply(" \n\t", "drafto-factory-plan-reply-1"), null);
  });

  it("refuses any marker but the exact reply shapes", () => {
    for (const bad of [
      "drafto-factory-plan-reply-",
      "drafto-factory-plan-reply-1.*",
      "drafto-factory-revise-noop",
      "drafto-factory-plan",
      undefined,
    ]) {
      assert.throws(() => composeReply("x", bad), /bad marker/, JSON.stringify(bad));
    }
  });

  it("cuts an oversized reply, closing a code fence the cut left open", () => {
    const body = composeReply(
      `log:\n\`\`\`\n${"a".repeat(REPLY_BODY_MAX + 500)}\n\`\`\``,
      "drafto-factory-plan-reply-1",
    );
    assert.ok(body.length < 65_536);
    assert.match(
      body,
      /\n```\n\n_\(Reply cut at 60,000 characters\.\)_\n\n<!-- drafto-factory-plan-reply-1 -->$/,
    );
  });
});

describe("issue-reply CLI", () => {
  function run(text, marker) {
    const dir = mkdtempSync(join(tmpdir(), "issue-reply-"));
    try {
      const file = join(dir, "1.md");
      if (text !== null) writeFileSync(file, text);
      return spawnSync("node", [cli, "compose", "--file", file, "--marker", marker], {
        encoding: "utf8",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("prints the composed body", () => {
    const r = run("🏭 Hi.", "drafto-factory-plan-reply-1");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "🏭 Hi.\n\n<!-- drafto-factory-plan-reply-1 -->");
  });

  it("exits 3 on an empty reply, 2 on a bad marker, 1 on a missing file", () => {
    assert.equal(run("  ", "drafto-factory-plan-reply-1").status, 3);
    assert.equal(run("x", "nope").status, 2);
    assert.equal(run(null, "drafto-factory-plan-reply-1").status, 1);
  });
});
