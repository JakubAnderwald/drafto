import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseIssueFooter } from "../lib/parse-issue-footer.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "lib", "parse-issue-footer.mjs");

const goodBody = `## Description

Customer reported a bug.

<!-- drafto-support-agent v1
reporter-email: jane@example.com
reporter-allowlisted: false
zoho-thread-id: 8537837000001234567
-->`;

describe("parseIssueFooter", () => {
  it("extracts all three documented fields", () => {
    const out = parseIssueFooter(goodBody);
    assert.deepEqual(out, {
      "reporter-email": "jane@example.com",
      "reporter-allowlisted": "false",
      "zoho-thread-id": "8537837000001234567",
    });
  });

  it("returns null on bodies without a footer", () => {
    assert.equal(parseIssueFooter("no footer here"), null);
    assert.equal(parseIssueFooter(""), null);
    assert.equal(parseIssueFooter(null), null);
    assert.equal(parseIssueFooter(undefined), null);
  });

  it("ignores text outside the fenced footer block", () => {
    const body = `Random preamble: reporter-email: hostile@example.com\n\n${goodBody}\n\nTrailer: zoho-thread-id: 999`;
    const out = parseIssueFooter(body);
    assert.equal(out["reporter-email"], "jane@example.com");
    assert.equal(out["zoho-thread-id"], "8537837000001234567");
  });

  it("tolerates extra whitespace inside the footer", () => {
    const body = `<!--   drafto-support-agent v1
  reporter-email:   spaced@example.com
  reporter-allowlisted:   false
-->`;
    const out = parseIssueFooter(body);
    assert.equal(out["reporter-email"], "spaced@example.com");
    assert.equal(out["reporter-allowlisted"], "false");
  });

  it("skips lines without a colon and lines starting with colon", () => {
    const body = `<!-- drafto-support-agent v1
reporter-email: a@b.co
not a key value pair
: orphan-colon
-->`;
    const out = parseIssueFooter(body);
    assert.deepEqual(Object.keys(out), ["reporter-email"]);
  });

  it("returns null for a footer marker without a closing block", () => {
    const body = `<!-- drafto-support-agent v1\nreporter-email: x@y.co`;
    assert.equal(parseIssueFooter(body), null);
  });

  it("CRLF line endings work the same as LF", () => {
    const body = goodBody.replace(/\n/g, "\r\n");
    const out = parseIssueFooter(body);
    assert.equal(out["reporter-email"], "jane@example.com");
  });
});

describe("parse-issue-footer CLI", () => {
  function run(args, { input } = {}) {
    return spawnSync("node", [CLI, ...args], { encoding: "utf8", input });
  }

  it("--field reporter-email prints the value", () => {
    const r = run(["--field", "reporter-email"], { input: goodBody });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "jane@example.com");
  });

  it("--field zoho-thread-id prints the routing id (the only load-bearing field today)", () => {
    const r = run(["--field", "zoho-thread-id"], { input: goodBody });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "8537837000001234567");
  });

  it("--field on a missing field prints empty", () => {
    const r = run(["--field", "missing"], { input: goodBody });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
  });

  it("--field on a body with no footer prints empty", () => {
    const r = run(["--field", "reporter-email"], { input: "no footer" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
  });

  it("rejects when --field is not provided", () => {
    const r = run([], { input: goodBody });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--field/);
  });
});
