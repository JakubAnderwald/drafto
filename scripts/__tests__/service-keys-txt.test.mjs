// Tests for scripts/lib/service-keys-txt.mjs, the reader of the MacBook Air's
// "supabase service keys.txt" (DEV: / PROD: lines), shared by
// migration-stats.mjs, delete-users.mjs, user-stats.mjs and
// run-dev-live-tests.mjs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PROJECTS,
  SERVICE_KEYS_TXT,
  SERVICE_KEY_TAGS,
  defaultKeysTxtPath,
  readServiceKey,
  serviceKeyFromText,
  serviceKeyTagFor,
} from "../lib/service-keys-txt.mjs";
import { PROJECTS as DELETE_USERS_PROJECTS } from "../delete-users.mjs";

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

describe("serviceKeyTagFor", () => {
  it("maps the dev and prod refs to their tags", () => {
    assert.equal(serviceKeyTagFor("huhzactreblzcogqkbsd"), "DEV");
    assert.equal(serviceKeyTagFor("tbmjbxxseonkciqovnpl"), "PROD");
  });

  it("maps any other project to null, never to DEV", () => {
    for (const ref of ["abcdefghijklmnopqrst", "", undefined, null, "toString", "__proto__"]) {
      assert.equal(serviceKeyTagFor(ref), null, String(ref));
    }
  });
});

describe("PROJECTS", () => {
  it("names prod and dev with the refs and tags SERVICE_KEY_TAGS maps", () => {
    assert.deepEqual(Object.keys(PROJECTS).sort(), ["dev", "prod"]);
    for (const { ref, tag } of Object.values(PROJECTS)) {
      assert.equal(SERVICE_KEY_TAGS[ref], tag);
    }
    assert.equal(PROJECTS.prod.ref, "tbmjbxxseonkciqovnpl");
    assert.equal(PROJECTS.dev.ref, "huhzactreblzcogqkbsd");
  });

  it("is frozen, and is the object delete-users.mjs exports", () => {
    assert.ok(Object.isFrozen(PROJECTS) && Object.isFrozen(PROJECTS.prod));
    assert.equal(DELETE_USERS_PROJECTS, PROJECTS);
  });
});

describe("defaultKeysTxtPath", () => {
  it("is the keys file under ~/drafto-secrets", () => {
    assert.equal(defaultKeysTxtPath("/h"), "/h/drafto-secrets/supabase service keys.txt");
  });
});

describe("readServiceKey", () => {
  const KEY_TEXT = "PROD: fake-prod-key-1a2b3c\nDEV: fake-dev-key-4d5e6f\n";
  const reading = (text) => {
    const reads = [];
    return {
      reads,
      readFile: (file, encoding) => {
        reads.push([file, encoding]);
        return text;
      },
    };
  };

  it("returns the project's ref, tag and key from its line", () => {
    const { readFile, reads } = reading(KEY_TEXT);
    assert.deepEqual(readServiceKey({ project: "prod", keysTxt: "/k.txt", readFile }), {
      ref: "tbmjbxxseonkciqovnpl",
      tag: "PROD",
      serviceKey: "fake-prod-key-1a2b3c",
    });
    assert.deepEqual(reads, [["/k.txt", "utf8"]]);
    assert.equal(
      readServiceKey({ project: "dev", keysTxt: "/k.txt", readFile }).serviceKey,
      "fake-dev-key-4d5e6f",
    );
  });

  it("names the file and the missing tag, never another line's key", () => {
    const { readFile } = reading("DEV: fake-dev-key-4d5e6f\n");
    assert.throws(
      () => readServiceKey({ project: "prod", keysTxt: "/k.txt", readFile }),
      (err) => err.message === "no PROD: line in /k.txt",
    );
  });

  it("refuses an unknown project before reading anything", () => {
    for (const project of ["staging", "", undefined, "toString", "__proto__"]) {
      const { readFile, reads } = reading(KEY_TEXT);
      assert.throws(
        () => readServiceKey({ project, keysTxt: "/k.txt", readFile }),
        /unknown project/,
        String(project),
      );
      assert.equal(reads.length, 0);
    }
  });

  it("lets a read error through, naming the file", () => {
    assert.throws(
      () => readServiceKey({ project: "dev", keysTxt: "/nonexistent/keys.txt" }),
      (err) => err.code === "ENOENT" && err.message.includes("/nonexistent/keys.txt"),
    );
  });
});
