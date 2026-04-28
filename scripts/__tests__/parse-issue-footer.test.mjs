import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseIssueFooter, evaluateAllowlist } from "../lib/parse-issue-footer.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "lib", "parse-issue-footer.mjs");

const goodBody = `## Description

Customer reported a bug.

<!-- drafto-support-agent v1
reporter-email: jane@example.com
reporter-allowlisted: false
zoho-thread-id: 8537837000001234567
-->`;

const allowlistedBody = goodBody
  .replace("jane@example.com", "jakub@anderwald.info")
  .replace("reporter-allowlisted: false", "reporter-allowlisted: true");

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

describe("evaluateAllowlist (defence-in-depth gate)", () => {
  const allowlist = "jakub@anderwald.info,joanna@anderwald.info";

  it("allows when claim=true AND email is in the allowlist", () => {
    const r = evaluateAllowlist(allowlistedBody, allowlist);
    assert.equal(r.allowed, true);
    assert.equal(r.reason, "ok");
    assert.equal(r.email, "jakub@anderwald.info");
  });

  it("rejects when the body has no footer", () => {
    const r = evaluateAllowlist("plain body", allowlist);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "no-footer");
  });

  it("rejects when claim is false even if email is in the allowlist", () => {
    const body = allowlistedBody.replace(
      "reporter-allowlisted: true",
      "reporter-allowlisted: false",
    );
    const r = evaluateAllowlist(body, allowlist);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "claim-not-true");
  });

  it("rejects when claim says true but email is NOT in the allowlist (tamper guard)", () => {
    // The whole point: a tampered issue body claiming `reporter-allowlisted: true`
    // for a public sender must NOT pass — defence-in-depth re-checks the
    // footer's email against $SUPPORT_ALLOWLIST.
    const tampered = goodBody.replace("reporter-allowlisted: false", "reporter-allowlisted: true");
    const r = evaluateAllowlist(tampered, allowlist);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "email-not-in-allowlist");
    assert.equal(r.email, "jane@example.com");
  });

  it("rejects when reporter-email is missing", () => {
    const body = `<!-- drafto-support-agent v1
reporter-allowlisted: true
zoho-thread-id: 1
-->`;
    const r = evaluateAllowlist(body, allowlist);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "no-email");
  });

  it("matches case-insensitively (footer email + allowlist both normalised)", () => {
    const body = allowlistedBody.replace("jakub@anderwald.info", "Jakub@Anderwald.INFO");
    const r = evaluateAllowlist(body, "JAKUB@anderwald.info,joanna@anderwald.info");
    assert.equal(r.allowed, true);
  });

  it("accepts an array allowlist as well as CSV", () => {
    const r = evaluateAllowlist(allowlistedBody, ["jakub@anderwald.info", "joanna@anderwald.info"]);
    assert.equal(r.allowed, true);
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

  it("--check-allowlist prints the gate result", () => {
    const r = run(
      ["--check-allowlist", "--allowlist", "jakub@anderwald.info,joanna@anderwald.info"],
      { input: allowlistedBody },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /allowed=true reason=ok/);
  });

  it("--check-allowlist on a tampered body returns allowed=false", () => {
    const tampered = goodBody.replace("reporter-allowlisted: false", "reporter-allowlisted: true");
    const r = run(
      ["--check-allowlist", "--allowlist", "jakub@anderwald.info,joanna@anderwald.info"],
      { input: tampered },
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /allowed=false reason=email-not-in-allowlist/);
  });

  it("rejects when neither --field nor --check-allowlist is provided", () => {
    const r = run([], { input: goodBody });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--field/);
  });
});
