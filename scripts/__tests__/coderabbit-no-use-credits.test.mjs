// Guard test for the free-tier-only rule (CLAUDE.md "Infrastructure cost
// discipline", ADR-0036): the CodeRabbit CLI's paid overage is opt-in per
// invocation, so no file under scripts/ may ever spell out the flag. Code and
// tests that need it build it by concatenation, as this file does.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildReviewArgs } from "../lib/coderabbit-review.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(HERE, "..");
const NEEDLE = "--use-" + "credits";

const TEXT_EXTENSIONS = new Set([
  ".mjs",
  ".cjs",
  ".js",
  ".ts",
  ".sh",
  ".bash",
  ".py",
  ".rb",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".txt",
  ".toml",
  ".plist",
]);
const MAX_BYTES = 1024 * 1024;

function isSkippedDir(rel, name) {
  return (
    name === "node_modules" || name.startsWith(".") || rel === path.join("__tests__", "fixtures")
  );
}

// Every text file under root, as paths relative to root.
function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs);
    if (entry.isDirectory()) {
      if (!isSkippedDir(rel, entry.name)) walk(root, abs, out);
      continue;
    }
    // Symlinks are not followed: a link out of scripts/ is not scripts/ content.
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    if (ext && !TEXT_EXTENSIONS.has(ext)) continue;
    if (statSync(abs).size > MAX_BYTES) continue;
    // An extensionless binary is not a script.
    if (!ext && readFileSync(abs).includes(0)) continue;
    out.push(rel);
  }
  return out;
}

function offenders(root, files) {
  const hits = [];
  for (const rel of files) {
    readFileSync(path.join(root, rel), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.includes(NEEDLE)) hits.push(`${rel}:${i + 1}`);
      });
  }
  return hits;
}

describe("no paid-overage CodeRabbit flag under scripts/", () => {
  const files = walk(SCRIPTS);

  it("walks the files that drive the CodeRabbit lane", () => {
    for (const expected of [
      path.join("lib", "coderabbit-cli.mjs"),
      path.join("lib", "coderabbit-review.mjs"),
      "factory-agent.sh",
      path.join("__tests__", "coderabbit-no-use-credits.test.mjs"),
    ]) {
      assert.ok(files.includes(expected), `walk did not visit ${expected}`);
    }
    assert.ok(files.length > 20, `suspiciously few files scanned: ${files.length}`);
  });

  it("skips node_modules, fixtures and dot-directories", () => {
    for (const rel of files) {
      const dirs = rel.split(path.sep).slice(0, -1);
      assert.ok(!dirs.includes("node_modules"), rel);
      assert.ok(!dirs.some((p) => p.startsWith(".")), rel);
      assert.ok(!rel.startsWith(path.join("__tests__", "fixtures") + path.sep), rel);
    }
  });

  it("no scanned file contains the flag", () => {
    assert.deepEqual(offenders(SCRIPTS, files), []);
  });

  it("buildReviewArgs never emits the flag", () => {
    for (const baseSha of [
      "a".repeat(40),
      "0123456789abcdef0123456789abcdef01234567",
      "F".repeat(40),
    ]) {
      const args = buildReviewArgs({ baseSha });
      assert.ok(!args.some((a) => a.includes(NEEDLE)), JSON.stringify(args));
      assert.ok(!args.join(" ").includes(NEEDLE));
    }
  });

  // The scan above passes vacuously if the walker or matcher is broken, so
  // prove both on a planted tree first.
  it("the scanner catches a planted flag and honours its skips", () => {
    const root = mkdtempSync(path.join(tmpdir(), "no-use-credits-"));
    try {
      const plant = (rel, content) => {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), content);
      };
      plant("lib/runner.mjs", `spawn("coderabbit", ["review", "${NEEDLE}"]);\n`);
      plant("agent.sh", `#!/bin/bash\nok\ncoderabbit review ${NEEDLE}=true\n`);
      plant("bin/extensionless", `#!/bin/sh\nexec coderabbit ${NEEDLE}\n`);
      plant("docs/notes.md", "clean\n");
      plant("node_modules/pkg/index.js", NEEDLE);
      plant("__tests__/fixtures/coderabbit/x.ndjson", NEEDLE);
      plant(".cache/x.mjs", NEEDLE);
      plant("image.png", NEEDLE);
      plant("bin/blob", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(NEEDLE)]));

      const planted = walk(root);
      assert.deepEqual(planted.sort(), [
        "agent.sh",
        path.join("bin", "extensionless"),
        path.join("docs", "notes.md"),
        path.join("lib", "runner.mjs"),
      ]);
      assert.deepEqual(offenders(root, planted).sort(), [
        "agent.sh:3",
        `${path.join("bin", "extensionless")}:2`,
        `${path.join("lib", "runner.mjs")}:1`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
