import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findOutOfOrder,
  formatFinding,
  suggestVersion,
  versionOf,
} from "../lib/check-migration-order.mjs";

// Tests for the migration order rule in `pnpm migration:check` (ADR 0057). PR #646's
// 20260922000001 migration sat open while main gained 20261020000001; after the rebase
// `supabase db push` refused it as "inserted before the last migration". The rule fails
// a migration a branch ADDS whose version is not newer than the base's newest, and
// never judges the order of main's own history (which holds that very pair).

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, "..", "check-migration-safety.sh");
const helperPath = resolve(here, "..", "lib", "check-migration-order.mjs");

const TODAY = new Date("2026-10-25T12:00:00Z");
const A = "20260101000001_a.sql";
const B = "20260301000001_b.sql";

describe("check-migration-order: versionOf", () => {
  it("reads the leading digits before the first underscore", () => {
    assert.equal(versionOf("20261020000001_explicit_data_api_grants.sql"), "20261020000001");
    assert.equal(versionOf("1_x.sql"), "1");
  });

  it("returns null for a name without a numeric version", () => {
    assert.equal(versionOf("seed.sql"), null);
    assert.equal(versionOf("2026_"), null);
    assert.equal(versionOf("v1_x.sql"), null);
  });
});

describe("check-migration-order: suggestVersion", () => {
  it("uses today's first slot when the base is older", () => {
    assert.equal(suggestVersion("20261020000001", TODAY), "20261025000001");
  });

  it("rolls past same-day and future base versions", () => {
    assert.equal(suggestVersion("20261025000003", TODAY), "20261025000004");
    assert.equal(suggestVersion("20261101000001", TODAY), "20261101000002");
  });

  it("takes the UTC day, not the local one", () => {
    assert.equal(suggestVersion("1", new Date("2026-10-25T23:59:59Z")), "20261025000001");
    assert.equal(suggestVersion("1", new Date("2026-10-26T00:00:00Z")), "20261026000001");
  });

  it("is BigInt-safe past Number.MAX_SAFE_INTEGER", () => {
    // 9007199254740993 is not representable as a Number (it rounds to ...992).
    assert.equal(suggestVersion("9007199254740992", TODAY), "9007199254740993");
    assert.equal(suggestVersion(99999999999999n, TODAY), "100000000000000");
  });

  it("falls back to today's first slot with no base version", () => {
    assert.equal(suggestVersion(null, TODAY), "20261025000001");
  });
});

describe("check-migration-order: findOutOfOrder", () => {
  const find = (localFiles, baseFiles = [A, B]) =>
    findOutOfOrder({ localFiles, baseFiles, today: TODAY });

  it("flags an added file older than the base's newest", () => {
    assert.deepEqual(find([A, B, "20260201000001_c.sql"]), [
      {
        file: "20260201000001_c.sql",
        version: "20260201000001",
        baseMax: "20260301000001",
        suggested: "20261025000001",
      },
    ]);
  });

  it("flags an added file whose version equals the base's newest", () => {
    const [finding] = find([A, B, "20260301000001_other.sql"]);
    assert.equal(finding.file, "20260301000001_other.sql");
  });

  it("passes an added file newer than the base's newest", () => {
    assert.deepEqual(find([A, B, "20260401000001_c.sql"]), []);
  });

  it("never judges files already on the base, however they are ordered", () => {
    // main's own history: 20260922000001 merged after 20261020000001.
    const base = ["20261020000001_grants.sql", "20260922000001_guard.sql"];
    assert.deepEqual(find(base, base), []);
  });

  it("ignores base files missing locally", () => {
    assert.deepEqual(find([A]), []);
  });

  it("returns nothing when the base has no migrations", () => {
    assert.deepEqual(find(["20200101000001_c.sql"], []), []);
  });

  it("ignores files without a numeric version", () => {
    assert.deepEqual(find([A, B, "notes.sql"]), []);
  });

  it("gives every stale file its own suggestion, in version order", () => {
    const found = find([A, B, "20260215000001_d.sql", "20260201000001_c.sql"]);
    assert.deepEqual(
      found.map((f) => [f.file, f.suggested]),
      [
        ["20260201000001_c.sql", "20261025000001"],
        ["20260215000001_d.sql", "20261025000002"],
      ],
    );
  });

  it("skips versions another local file already uses", () => {
    const found = find([A, B, "20261025000001_new.sql", "20260201000001_c.sql"]);
    assert.deepEqual(
      found.map((f) => [f.file, f.suggested]),
      [["20260201000001_c.sql", "20261025000002"]],
    );
  });

  it("rolls past a same-day file on the base", () => {
    const [finding] = find(["20260201000001_c.sql"], [A, "20261025000002_today.sql"]);
    assert.equal(finding.suggested, "20261025000003");
  });
});

describe("check-migration-order: formatFinding", () => {
  it("emits path, message and a git mv that keeps the name", () => {
    const line = formatFinding(
      {
        file: "20260922000001_guard_profile.sql",
        version: "20260922000001",
        baseMax: "20261020000001",
        suggested: "20261025000001",
      },
      { dir: "supabase/migrations", ref: "a".repeat(40) },
    );
    const [path, message, rename] = line.split("\t");
    assert.equal(path, "supabase/migrations/20260922000001_guard_profile.sql");
    assert.match(message, /20260922000001 is not newer than aaaaaaaaaaaa's newest migration/);
    assert.match(message, /\(20261020000001\)/);
    assert.equal(
      rename,
      "git mv supabase/migrations/20260922000001_guard_profile.sql " +
        "supabase/migrations/20261025000001_guard_profile.sql",
    );
  });
});

// The factory writes migrations unattended, so its implement prompt must state the rule
// (the watcher's renumber recipe is pinned in factory-watch-prompt-grounding.test.mjs).
describe("factory implement prompt — migration versions", () => {
  const prompt = readFileSync(resolve(here, "..", "factory-prompt.md"), "utf8").replace(
    /\s+/g,
    " ",
  );

  it("tells the implementer to version a migration after everything on origin/main", () => {
    assert.match(
      prompt,
      /version must be newer than every file in `supabase\/migrations\/` on `origin\/main`/,
    );
    assert.match(prompt, /`YYYYMMDD000001_<name>\.sql`, bumping the last digits past any file/);
    assert.match(prompt, /"Migration versions must sort last"/);
  });
});

// End to end: the real `pnpm migration:check` script against a purpose-built repo.
describe("check-migration-safety: migration order in a git repo", () => {
  let dir;
  const migrations = () => join(dir, "supabase", "migrations");
  const sql = "select 1;\n";

  // A clean env: no inherited base ref or git plumbing variables from the caller (CI
  // sets MIGRATION_BASE_REF for its own step; a git hook sets GIT_DIR).
  function env(extra = {}) {
    const out = { ...process.env, ...extra };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete out[key];
    if (!("MIGRATION_BASE_REF" in extra)) delete out.MIGRATION_BASE_REF;
    return out;
  }

  function git(...args) {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: env() });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  function check(extraEnv) {
    return spawnSync("bash", [scriptPath], { cwd: dir, encoding: "utf8", env: env(extraEnv) });
  }

  function addMigration(name) {
    writeFileSync(join(migrations(), name), sql);
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "migration-order-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("config", "commit.gpgsign", "false");
    mkdirSync(migrations(), { recursive: true });
    addMigration(A);
    addMigration(B);
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", "base migrations");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
  });

  after(() => dir && rmSync(dir, { recursive: true, force: true }));

  // Each case starts from the base commit, with origin/main present and no extras.
  beforeEach(() => {
    git("reset", "-q", "--hard", "HEAD");
    git("clean", "-q", "-fdx");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
  });

  it("fails an added migration older than origin/main's newest, with the git mv", () => {
    addMigration("20260201000001_c.sql");
    const res = check();
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /Checking migration order against origin\/main/);
    assert.match(
      res.stdout,
      /ERROR {2}supabase\/migrations\/20260201000001_c\.sql — new migration version 20260201000001 is not newer than origin\/main's newest migration \(20260301000001\)/,
    );
    assert.match(
      res.stdout,
      /git mv supabase\/migrations\/20260201000001_c\.sql supabase\/migrations\/\d{8}000001_c\.sql/,
    );
    assert.match(res.stdout, /Results: 1 error\(s\)/);
    assert.match(res.stdout, /Migration versions must sort last/);
    assert.doesNotMatch(res.stdout, /safety:ignore' to suppress/);
  });

  it("fails it the same way once committed on a branch", () => {
    git("checkout", "-q", "-b", "feature");
    addMigration("20260201000001_c.sql");
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", "add c");
    const res = check();
    git("checkout", "-q", "main");
    git("branch", "-q", "-D", "feature");
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /20260201000001_c\.sql — new migration version/);
  });

  it("passes an added migration newer than origin/main's newest", () => {
    addMigration("20260401000001_c.sql");
    const res = check();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Checking migration order against origin\/main/);
    assert.match(res.stdout, /Results: 0 error\(s\)/);
  });

  it("does not judge a modified migration that is already on the base", () => {
    appendFileSync(join(migrations(), A), "select 2;\n");
    const res = check();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /new migration version/);
  });

  it("skips with a note when there is no base ref", () => {
    git("update-ref", "-d", "refs/remotes/origin/main");
    addMigration("20260201000001_c.sql");
    const res = check();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Migration order check skipped \(no base ref/);
  });

  it("treats an empty MIGRATION_BASE_REF as unset", () => {
    addMigration("20260201000001_c.sql");
    const res = check({ MIGRATION_BASE_REF: "" });
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /Checking migration order against origin\/main/);
  });

  it("uses MIGRATION_BASE_REF over origin/main", () => {
    const base = git("rev-parse", "HEAD");
    // origin/main moves to a commit without B, which would pass the older C.
    git("checkout", "-q", "-b", "older");
    rmSync(join(migrations(), B));
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", "drop b");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "-q", "main");
    git("branch", "-q", "-D", "older");
    addMigration("20260201000001_c.sql");
    const res = check({ MIGRATION_BASE_REF: base });
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, new RegExp(`Checking migration order against ${base}`));
    assert.match(res.stdout, /not newer than [0-9a-f]{12}'s newest migration \(20260301000001\)/);
  });

  it("fails when MIGRATION_BASE_REF does not resolve", () => {
    const res = check({ MIGRATION_BASE_REF: "nonexistent" });
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /MIGRATION_BASE_REF=nonexistent does not resolve to a commit/);
    assert.match(res.stdout, /Results: 1 error\(s\)/);
    assert.doesNotMatch(res.stdout, /Migration versions must sort last/);
  });

  it("leaves the order rule out when files are passed explicitly", () => {
    addMigration("20260201000001_c.sql");
    const res = spawnSync("bash", [scriptPath, "supabase/migrations/20260201000001_c.sql"], {
      cwd: dir,
      encoding: "utf8",
      env: env(),
    });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.doesNotMatch(res.stdout, /migration order/i);
  });

  it("skips with a note outside a git work tree", () => {
    const plain = mkdtempSync(join(tmpdir(), "migration-order-nogit-"));
    try {
      mkdirSync(join(plain, "supabase", "migrations"), { recursive: true });
      writeFileSync(join(plain, "supabase", "migrations", A), sql);
      const res = spawnSync("bash", [scriptPath], {
        cwd: plain,
        encoding: "utf8",
        env: env({ GIT_CEILING_DIRECTORIES: dirname(plain) }),
      });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, /Migration order check skipped \(no base ref: not inside a git/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("exits 2 from the helper CLI when the base ref does not resolve", () => {
    const res = spawnSync("node", [helperPath, "--base", "nonexistent"], {
      cwd: dir,
      encoding: "utf8",
      env: env(),
    });
    assert.equal(res.status, 2);
    assert.equal(res.stdout, "");
    assert.match(res.stderr, /does not resolve to a commit/);
  });
});
