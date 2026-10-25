// Tests for scripts/lib/service-keys-txt.mjs, the reader of the MacBook Air's
// "supabase service keys.txt" (DEV: / PROD: lines), shared by
// migration-stats.mjs and run-dev-live-tests.mjs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SERVICE_KEYS_TXT, serviceKeyFromText } from "../lib/service-keys-txt.mjs";

describe("serviceKeyFromText", () => {
  const text = "PROD: fake-prod-key\nDEV:   fake-dev-key  \n";

  it("returns the trimmed key on the tag's line", () => {
    assert.equal(serviceKeyFromText(text, "DEV"), "fake-dev-key");
    assert.equal(serviceKeyFromText(text, "PROD"), "fake-prod-key");
  });

  it("takes the first matching line and handles CRLF", () => {
    assert.equal(serviceKeyFromText("DEV: first\r\nDEV: second\r\n", "DEV"), "first");
  });

  it("returns null when no line starts with the tag", () => {
    assert.equal(serviceKeyFromText("PROD: x\n", "DEV"), null);
    assert.equal(serviceKeyFromText("  DEV: indented\n# DEV: commented\n", "DEV"), null);
    assert.equal(serviceKeyFromText("", "DEV"), null);
    assert.equal(serviceKeyFromText(undefined, "DEV"), null);
  });

  it("matches the tag exactly, so DEVX: is not DEV:", () => {
    assert.equal(serviceKeyFromText("DEVX: other\n", "DEV"), null);
  });

  it("names the file migration-stats.mjs has always read", () => {
    assert.equal(SERVICE_KEYS_TXT, "supabase service keys.txt");
  });
});
