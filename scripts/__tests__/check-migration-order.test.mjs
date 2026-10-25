import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkMigrationOrder,
  formatFinding,
  isValidMigrationName,
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

describe("check-migration-order: versionOf / isValidMigrationName", () => {
  it("reads the leading digits before the first underscore", () => {
    assert.equal(versionOf("20261020000001_explicit_data_api_grants.sql"), "20261020000001");
    assert.equal(versionOf("1_x.sql"), "1");
  });

  it("returns null for a name without a numeric version", () => {
    assert.equal(versionOf("seed.sql"), null);
    assert.equal(versionOf("2026_"), null);
    assert.equal(versionOf("v1_x.sql"), null);
  });

  it("accepts only 14-digit versions", () => {
    assert.equal(isValidMigrationName("20261020000001_x.sql"), true);
    assert.equal(isValidMigrationName("2026102000001_x.sql"), false);
    assert.equal(isValidMigrationName("202610200000001_x.sql"), false);
    assert.equal(isValidMigrationName("seed.sql"), false);
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
    assert.equal(suggestVersion(null, new Date("2026-10-25T23:59:59Z")), "20261025000001");
    assert.equal(suggestVersion(null, new Date("2026-10-26T00:00:00Z")), "20261026000001");
  });

  it("falls back to today's first slot with no base version", () => {
    assert.equal(suggestVersion(null, TODAY), "20261025000001");
  });

  it("only ever suggests 14 digits", () => {
    assert.throws(() => suggestVersion("99999999999999", TODAY), /no 14-digit migration version/);
  });
});

describe("check-migration-order: checkMigrationOrder", () => {
  const check = (localFiles, baseFiles = [A, B]) =>
    checkMigrationOrder({ localFiles, baseFiles, today: TODAY });
  const renames = (findings) => findings.map((f) => [f.kind, f.file, f.suggested]);

  it("flags an added file older than the base's newest", () => {
    assert.deepEqual(check([A, B, "20260201000001_c.sql"]), [
      {
        kind: "error",
        reason: "stale",
        file: "20260201000001_c.sql",
        version: "20260201000001",
        suggested: "20261025000001",
        baseMax: "20260301000001",
      },
    ]);
  });

  it("flags an added file that reuses the base's newest version, naming both", () => {
    const [finding, ...rest] = check([A, B, "20260301000001_other.sql"]);
    assert.deepEqual(rest, []);
    assert.equal(finding.kind, "error");
    assert.equal(finding.reason, "duplicate-base");
    assert.equal(finding.file, "20260301000001_other.sql");
    assert.deepEqual(finding.others, [B]);
    assert.equal(finding.suggested, "20261025000001");
  });

  it("passes an added file newer than the base's newest", () => {
    assert.deepEqual(check([A, B, "20260401000001_c.sql"]), []);
  });

  it("never judges files already on the base, however they are ordered", () => {
    // main's own history: 20260922000001 merged after 20261020000001.
    const base = ["20261020000001_grants.sql", "20260922000001_guard.sql"];
    assert.deepEqual(check(base, base), []);
  });

  it("ignores base files missing locally when nothing is added", () => {
    assert.deepEqual(check([A]), []);
  });

  it("returns nothing when the base has no migrations and the added ones are fine", () => {
    assert.deepEqual(check(["20200101000001_c.sql"], []), []);
  });

  it("fails an added version that isn't 14 digits, without a suggestion", () => {
    const found = check([A, B, "2026020100001_c.sql", "202602010000001_d.sql", "notes.sql"]);
    const byFile = (a, b) => (a[2] < b[2] ? -1 : 1);
    assert.deepEqual(found.map((f) => [f.kind, f.reason, f.file, f.suggested]).sort(byFile), [
      ["error", "shape", "202602010000001_d.sql", undefined],
      ["error", "shape", "2026020100001_c.sql", undefined],
      ["error", "shape", "notes.sql", undefined],
    ]);
  });

  it("reports a renamed base migration as a rename to revert, not a stale version", () => {
    // `git mv 20260101000001_a.sql 20260101000001_a_fixed.sql`
    assert.deepEqual(check(["20260101000001_a_fixed.sql", B]), [
      {
        kind: "error",
        reason: "renamed-base",
        file: "20260101000001_a_fixed.sql",
        version: "20260101000001",
        others: [A],
      },
    ]);
  });

  it("fails a version two added files share, naming the other one", () => {
    const found = check([A, B, "20261101000001_x.sql", "20261101000001_y.sql"]);
    assert.deepEqual(found, [
      {
        kind: "error",
        reason: "duplicate",
        file: "20261101000001_y.sql",
        version: "20261101000001",
        suggested: "20261101000002",
        baseMax: "20260301000001",
        others: ["20261101000001_x.sql"],
      },
    ]);
  });

  it("renumbers a fresh migration that must stay after a renamed stale one", () => {
    // The stale CREATE moves to today; the fresh ALTER that depends on it would
    // otherwise sort before it, so it moves too (a move, not an error).
    const base = [A, "20261020000001_grants.sql"];
    const found = check(
      [...base, "20261015000001_create_widgets.sql", "20261022000001_alter_widgets.sql"],
      base,
    );
    assert.deepEqual(renames(found), [
      ["error", "20261015000001_create_widgets.sql", "20261025000001"],
      ["move", "20261022000001_alter_widgets.sql", "20261025000002"],
    ]);
    assert.equal(found[1].reason, "order");
    assert.equal(found[1].after, "20261015000001_create_widgets.sql");
  });

  it("leaves a fresh migration alone when it already sorts after the renamed one", () => {
    const base = [A, "20261020000001_grants.sql"];
    const found = check(
      [...base, "20261015000001_create_widgets.sql", "20261030000001_alter_widgets.sql"],
      base,
    );
    assert.deepEqual(renames(found), [
      ["error", "20261015000001_create_widgets.sql", "20261025000001"],
    ]);
  });

  it("keeps several stale migrations in their current order", () => {
    const found = check([A, B, "20260215000001_d.sql", "20260201000001_c.sql"]);
    assert.deepEqual(renames(found), [
      ["error", "20260201000001_c.sql", "20261025000001"],
      ["error", "20260215000001_d.sql", "20261025000002"],
    ]);
  });

  it("never suggests a version another file holds, so no git mv target exists", () => {
    const local = [A, B, "20260201000001_x.sql", "20261025000001_x.sql"];
    const found = check(local);
    assert.deepEqual(renames(found), [
      ["error", "20260201000001_x.sql", "20261025000002"],
      ["move", "20261025000001_x.sql", "20261025000003"],
    ]);
    const targets = found.map((f) => `${f.suggested}_x.sql`);
    for (const target of targets) assert.ok(!local.includes(target), target);
    // Order is kept: the stale file still sorts before the one that was after it.
    assert.ok(targets[0] < targets[1]);
  });

  it("rolls past a same-day file on the base", () => {
    const base = [A, "20261025000002_today.sql"];
    const [finding] = check([...base, "20260201000001_c.sql"], base);
    assert.equal(finding.suggested, "20261025000003");
  });
});

describe("check-migration-order: formatFinding", () => {
  const opts = { dir: "supabase/migrations", ref: "a".repeat(40) };

  it("emits kind, path, message and a git mv that keeps the name", () => {
    const line = formatFinding(
      {
        kind: "error",
        reason: "stale",
        file: "20260922000001_guard_profile.sql",
        version: "20260922000001",
        baseMax: "20261020000001",
        suggested: "20261025000001",
      },
      opts,
    );
    const [kind, path, message, rename] = line.split("\t");
    assert.equal(kind, "error");
    assert.equal(path, "supabase/migrations/20260922000001_guard_profile.sql");
    assert.match(message, /20260922000001 is not newer than aaaaaaaaaaaa's newest migration/);
    assert.match(message, /\(20261020000001\)/);
    assert.equal(
      rename,
      "git mv supabase/migrations/20260922000001_guard_profile.sql " +
        "supabase/migrations/20261025000001_guard_profile.sql",
    );
  });

  it("emits a move with the file it stays after", () => {
    const line = formatFinding(
      {
        kind: "move",
        reason: "order",
        file: "20261022000001_alter.sql",
        version: "20261022000001",
        suggested: "20261025000002",
        after: "20261015000001_create.sql",
      },
      opts,
    );
    assert.equal(
      line,
      "move\tsupabase/migrations/20261022000001_alter.sql\t" +
        "renumbered to stay after 20261015000001_create.sql\t" +
        "git mv supabase/migrations/20261022000001_alter.sql supabase/migrations/20261025000002_alter.sql",
    );
  });

  it("leaves the rename field empty when there is nothing to rename", () => {
    const shape = formatFinding({ kind: "error", reason: "shape", file: "1_x.sql" }, opts);
    assert.equal(
      shape,
      "error\tsupabase/migrations/1_x.sql\tversion must be 14 digits, YYYYMMDDHHMMSS (name it <version>_<name>.sql)\t",
    );
    const renamed = formatFinding(
      { kind: "error", reason: "renamed-base", file: "20260101000001_b.sql", others: [A] },
      { dir: "supabase/migrations", ref: "origin/main" },
    );
    assert.match(
      renamed,
      /\trenames 20260101000001_a\.sql, which origin\/main already has — migration files on main must not be renamed; revert the rename\t$/,
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

  it("tells the implementer to version a migration after the newest on origin/main", () => {
    assert.match(
      prompt,
      /must be 14 digits and newer than the newest file in `supabase\/migrations\/` on `origin\/main`/,
    );
    assert.match(prompt, /normally today's UTC date as `YYYYMMDD000001_<name>\.sql`/);
    assert.match(
      prompt,
      /if main already has a file dated today or later, the next version after it/,
    );
    assert.match(prompt, /"Migration versions must sort last"/);
  });
});

// End to end: the real `pnpm migration:check` script against a purpose-built repo.
describe("check-migration-safety: migration order in a git repo", () => {
  let dir;
  let baseSha;
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

  function commitAll(message) {
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", message);
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
    commitAll("base migrations");
    baseSha = git("rev-parse", "HEAD");
  });

  after(() => dir && rmSync(dir, { recursive: true, force: true }));

  // Each case starts on main at the base commit, with origin/main present, no other
  // branches and no extra files, even if an earlier case failed half-way.
  beforeEach(() => {
    git("checkout", "-q", "-f", "main");
    git("reset", "-q", "--hard", baseSha);
    git("clean", "-q", "-fdx");
    for (const branch of git("for-each-ref", "--format=%(refname:short)", "refs/heads/").split(
      "\n",
    )) {
      if (branch && branch !== "main") git("branch", "-q", "-D", branch);
    }
    git("update-ref", "refs/remotes/origin/main", baseSha);
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
    assert.doesNotMatch(res.stdout, /Also renumber/);
  });

  it("fails it the same way once committed on a branch", () => {
    git("checkout", "-q", "-b", "feature");
    addMigration("20260201000001_c.sql");
    commitAll("add c");
    const res = check();
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /20260201000001_c\.sql — new migration version/);
  });

  it("lists the moves that keep a later migration after the renamed one, as non-errors", () => {
    addMigration("20260201000001_create_widgets.sql");
    addMigration("20260302000001_alter_widgets.sql");
    const res = check();
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /Results: 1 error\(s\)/);
    assert.match(res.stdout, /ERROR {2}supabase\/migrations\/20260201000001_create_widgets\.sql/);
    assert.doesNotMatch(res.stdout, /ERROR {2}supabase\/migrations\/20260302000001_alter_widgets/);
    const hint = res.stdout.slice(res.stdout.indexOf("Migration order:"));
    assert.match(
      hint,
      /Also renumber these later migrations from this branch, so they stay in their current order:\n {8}git mv supabase\/migrations\/20260302000001_alter_widgets\.sql supabase\/migrations\/\d{14}_alter_widgets\.sql {3}# renumbered to stay after 20260201000001_create_widgets\.sql\n/,
    );
  });

  it("reports a renamed base migration with no git mv", () => {
    renameSync(join(migrations(), A), join(migrations(), "20260101000001_a_fixed.sql"));
    const res = check();
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(
      res.stdout,
      /ERROR {2}supabase\/migrations\/20260101000001_a_fixed\.sql — renames 20260101000001_a\.sql, which origin\/main already has — migration files on main must not be renamed; revert the rename\n/,
    );
    assert.doesNotMatch(res.stdout, /git mv supabase/);
    assert.doesNotMatch(res.stdout, /is not newer than/);
  });

  it("fails two added migrations that share a version, naming both", () => {
    addMigration("20260401000001_x.sql");
    addMigration("20260401000001_y.sql");
    const res = check();
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(
      res.stdout,
      /20260401000001_y\.sql — version 20260401000001 is also used by 20260401000001_x\.sql/,
    );
  });

  it("fails an added version that isn't 14 digits", () => {
    addMigration("202604010000001_c.sql");
    const res = check();
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /202604010000001_c\.sql — version must be 14 digits, YYYYMMDDHHMMSS/);
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
    // origin/main moves to a commit without B, which would pass the older C.
    git("checkout", "-q", "-b", "older");
    rmSync(join(migrations(), B));
    commitAll("drop b");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "-q", "main");
    addMigration("20260201000001_c.sql");
    const res = check({ MIGRATION_BASE_REF: baseSha });
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stdout, new RegExp(`Checking migration order against ${baseSha}`));
    assert.match(res.stdout, /not newer than [0-9a-f]{12}'s newest migration \(20260301000001\)/);
  });

  // CI's shape: on a pull request the checkout is GitHub's two-parent test merge of the
  // PR into main, and CI passes its first parent as MIGRATION_BASE_REF. There is no
  // origin/main in that checkout.
  describe("a two-parent test merge, as CI checks out a PR", () => {
    function testMerge(prMigration) {
      git("update-ref", "-d", "refs/remotes/origin/main");
      git("checkout", "-q", "-b", "pr");
      addMigration(prMigration);
      commitAll("pr: add migration");
      git("checkout", "-q", "main");
      // main moves on while the PR is open, like main gaining 20261020000001.
      addMigration("20260401000001_main_moved.sql");
      commitAll("main: newer migration");
      git("merge", "-q", "--no-ff", "--no-edit", "pr");
      git("rev-parse", "--verify", "HEAD^2");
      return git("rev-parse", "HEAD^1");
    }

    it("fails a PR migration older than the merge's first parent", () => {
      const base = testMerge("20260315000001_pr.sql");
      const res = check({ MIGRATION_BASE_REF: base });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.match(
        res.stdout,
        /20260315000001_pr\.sql — new migration version 20260315000001 is not newer than [0-9a-f]{12}'s newest migration \(20260401000001\)/,
      );
    });

    it("passes a PR migration newer than the merge's first parent", () => {
      const base = testMerge("20260501000001_pr.sql");
      const res = check({ MIGRATION_BASE_REF: base });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.match(res.stdout, new RegExp(`Checking migration order against ${base}`));
    });
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
