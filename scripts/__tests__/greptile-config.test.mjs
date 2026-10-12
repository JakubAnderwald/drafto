// Guard test for greptile.json, the repo config the Greptile GitHub App reads
// from the repo root (ADR-0047). Greptile runs on its free open-source plan
// (CLAUDE.md "Infrastructure cost discipline"), so the keys that keep review
// volume low and keep it out of the merge path are pinned here. Greptile
// silently ignores a key it does not know, and its defaults review Dependabot
// PRs and re-review every push, so a misspelled key would quietly burn quota.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const CONFIG_PATH = path.join(REPO_ROOT, "greptile.json");

const ALLOWED_KEYS = [
  "commentTypes",
  "customContext",
  "excludeAuthors",
  "ignorePatterns",
  "statusCheck",
  "triggerOnUpdates",
];

const IGNORED = [
  // Lockfiles: large, machine-written, nothing to review.
  "pnpm-lock.yaml",
  "**/Gemfile.lock",
  "**/Podfile.lock",
  // Generated native projects.
  "apps/desktop/macos/*.xcodeproj/**",
  "apps/desktop/macos/*.xcworkspace/**",
  "apps/mobile/ios/**",
  "apps/mobile/android/**",
  // Supabase CLI scratch space and generated types.
  "supabase/.temp/**",
  "apps/web/src/lib/supabase/database.types.ts",
  // Test fixtures and historical plans that are not source of truth.
  "scripts/__fixtures__/**",
  "docs/archive/**",
];

const SECRET_KEY = /api[_-]?key|token|secret/i;

// Every object key in a parsed JSON value, at any depth.
function keyNames(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) keyNames(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      keyNames(child, out);
    }
  }
  return out;
}

// A parse error fails the whole suite here, before any key is checked.
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

describe("greptile.json", () => {
  it("parses as a JSON object", () => {
    assert.equal(typeof config, "object");
    assert.ok(config && !Array.isArray(config));
  });

  // An unlisted key is either a typo Greptile would ignore (falling back to a
  // costlier default) or a setting the approved plan never agreed to.
  it("has exactly the allow-listed top-level keys", () => {
    assert.deepEqual(Object.keys(config).sort(), ALLOWED_KEYS);
  });

  // Dependabot opens a steady stream of PRs; reviewing them would spend the
  // OSS plan's quota on lockfile bumps.
  it("skips Dependabot PRs", () => {
    assert.ok(Array.isArray(config.excludeAuthors));
    assert.ok(config.excludeAuthors.includes("dependabot[bot]"));
  });

  // One review when the PR opens; a re-review needs an explicit @greptileai
  // comment. Strict false: a missing key means Greptile's default, which
  // re-reviews every push.
  it("reviews on PR open only", () => {
    assert.equal(config.triggerOnUpdates, false);
  });

  // Out of scope: Greptile is never a required check. A commit status could sit
  // pending or red in statusCheckRollup and stall the factory's merge gate.
  it("posts no commit status", () => {
    assert.equal(config.statusCheck, false);
  });

  // Logic and syntax findings only: style is Prettier's and ESLint's job, and
  // fewer comment types means fewer threads that block the merge.
  it("comments on logic and syntax only", () => {
    assert.deepEqual(config.commentTypes, ["logic", "syntax"]);
  });

  // Greptile documents ignorePatterns as one newline-separated string, not an
  // array; an array would be ignored and every lockfile reviewed.
  it("ignores lockfiles, native projects, generated files, fixtures and the archive", () => {
    assert.equal(typeof config.ignorePatterns, "string");
    const lines = config.ignorePatterns
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (const pattern of IGNORED) {
      assert.ok(lines.includes(pattern), `ignorePatterns is missing ${pattern}`);
    }
  });

  it("points customContext at files that exist", () => {
    const { files } = config.customContext;
    assert.ok(Array.isArray(files) && files.length > 0);
    const paths = files.map((f) => f.path);
    assert.ok(paths.includes("CLAUDE.md"), "CLAUDE.md carries the repo-wide rules");
    for (const file of files) {
      assert.deepEqual(Object.keys(file).sort(), ["description", "path", "scope"]);
      // Relative to the repo root, as Greptile resolves them; a renamed doc
      // would otherwise drop out of the review context unnoticed.
      assert.ok(!path.isAbsolute(file.path), file.path);
      assert.ok(existsSync(path.join(REPO_ROOT, file.path)), `${file.path} does not exist`);
      assert.ok(typeof file.description === "string" && file.description.trim(), file.path);
      // [] means the whole repo.
      assert.ok(Array.isArray(file.scope), file.path);
    }
  });

  // An empty scope would apply a platform-specific rule to the whole repo.
  it("gives every customContext rule a text and a scope", () => {
    const { rules } = config.customContext;
    assert.ok(Array.isArray(rules) && rules.length > 0);
    for (const rule of rules) {
      assert.ok(typeof rule.rule === "string" && rule.rule.trim(), JSON.stringify(rule));
      assert.ok(Array.isArray(rule.scope) && rule.scope.length > 0, rule.rule);
      for (const glob of rule.scope) {
        assert.ok(typeof glob === "string" && glob.trim(), rule.rule);
      }
    }
  });

  // The file is public; credentials belong in the Greptile dashboard. Key names
  // only: rule text may legitimately say "token classes".
  it("names no credential keys", () => {
    const offenders = keyNames(config).filter((k) => SECRET_KEY.test(k));
    assert.deepEqual(offenders, []);
  });

  // The check above passes vacuously if keyNames misses nested keys.
  it("the key scan catches a nested credential key", () => {
    const planted = {
      customContext: { files: [{ path: "x", apiKey: "k" }], rules: [{ api_key: "k" }] },
      nested: { authToken: "t", clientSecret: "s" },
    };
    assert.deepEqual(
      keyNames(planted)
        .filter((k) => SECRET_KEY.test(k))
        .sort(),
      ["apiKey", "api_key", "authToken", "clientSecret"],
    );
  });
});
