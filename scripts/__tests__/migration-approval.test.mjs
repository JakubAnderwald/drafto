import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { migrationSqlHash, prMigrationFiles } from "../lib/migration-approval.mjs";
import { computeRenumber, writeRenumberCommit } from "../lib/migration-renumber.mjs";

// ADR-0078. The migration-approved label vouches for a hash of the PR's
// migration SQL with the PR's own versions left out: the factory's mechanical
// renumber (ADR-0077) keeps the approval, any other edit voids it.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "..", "lib", "migration-approval.mjs");
const TODAY = new Date("2026-11-13T12:00:00Z");

const BASE = "20261020000001_explicit_data_api_grants.sql";
const NOTE = "20261111000001_note_text_chars.sql";
const QUOTA = "20261111000001_storage_quota.sql";

const quotaSql = (v) =>
  `-- ${v}_storage_quota: per-user storage quota (applied to dev as ${v})\n` +
  "alter table public.profiles add column storage_bytes bigint;\n";

const mig = (name) => `supabase/migrations/${name}`;

describe("migrationSqlHash", () => {
  const hash = (files) => migrationSqlHash({ files });
  const added = (name, content) => ({ path: mig(name), content, added: true });

  it("is 16 hex characters", () => {
    assert.match(hash([added(QUOTA, quotaSql("20261111000001"))]), /^[0-9a-f]{16}$/);
  });

  it("keeps the hash across a renumber, self-references inside the SQL included", () => {
    const before = [
      added(QUOTA, quotaSql("20261111000001")),
      added(
        "20261111000002_storage_quota_policy.sql",
        "-- after 20261111000001_storage_quota.sql\ncreate policy q on public.profiles;\n",
      ),
    ];
    const after = [
      added("20261113000001_storage_quota.sql", quotaSql("20261113000001")),
      added(
        "20261113000002_storage_quota_policy.sql",
        "-- after 20261113000001_storage_quota.sql\ncreate policy q on public.profiles;\n",
      ),
    ];
    assert.equal(hash(after), hash(before));
  });

  it("keeps the hash when a renumber splits two files that shared a version", () => {
    const before = [
      added("20261201000001_x.sql", "-- then 20261201000001_y.sql\n"),
      added("20261201000001_y.sql", "-- after 20261201000001_x\n"),
    ];
    const after = [
      added("20261201000001_x.sql", "-- then 20261201000002_y.sql\n"),
      added("20261201000002_y.sql", "-- after 20261201000001_x\n"),
    ];
    assert.equal(hash(after), hash(before));
  });

  it("changes when two of the PR's migrations swap versions, so the order they run in changes", () => {
    const create = "create table public.quota (id int);\n";
    const alter = "alter table public.quota add column n int;\n";
    const inOrder = [
      added("20261111000001_create_quota.sql", create),
      added("20261111000002_alter_quota.sql", alter),
    ];
    const swapped = [
      added("20261111000002_create_quota.sql", create),
      added("20261111000001_alter_quota.sql", alter),
    ];
    assert.notEqual(hash(swapped), hash(inOrder));
    // Moving both while keeping their order (a renumber) doesn't.
    const moved = [
      added("20261113000001_create_quota.sql", create),
      added("20261113000002_alter_quota.sql", alter),
    ];
    assert.equal(hash(moved), hash(inOrder));
  });

  it("keeps the hash when a 13-digit version is renumbered to 14 digits", () => {
    const sql = (v) => `-- ${v}_storage_quota\nalter table public.profiles add column q int;\n`;
    const later = added("20261114000001_later.sql", "-- after 20261114000001_later\nselect 1;\n");
    const before = [added("2026111300001_storage_quota.sql", sql("2026111300001")), later];
    const after = [added("20261113000001_storage_quota.sql", sql("20261113000001")), later];
    assert.equal(hash(after), hash(before));
    // The 13-digit version is the PR's own: editing the SQL around it still counts.
    assert.notEqual(
      hash([added("2026111300001_storage_quota.sql", `${sql("2026111300001")}select 2;\n`), later]),
      hash(before),
    );
  });

  it("changes on any SQL edit", () => {
    const base = [added(QUOTA, quotaSql("20261111000001"))];
    for (const content of [
      quotaSql("20261111000001").replace("bigint", "int"),
      `${quotaSql("20261111000001")}drop table public.notes;\n`,
      quotaSql("20261111000001").replace("-- ", "--"),
    ]) {
      assert.notEqual(hash([{ ...base[0], content }]), hash(base), content);
    }
  });

  it("changes when a file is added, deleted or renamed to another name", () => {
    const quota = added(QUOTA, quotaSql("20261111000001"));
    const base = hash([quota]);
    assert.notEqual(hash([quota, added("20261111000002_more.sql", "select 1;\n")]), base);
    assert.notEqual(
      hash([quota, { path: mig(BASE), content: null, added: false, deleted: true }]),
      base,
    );
    assert.notEqual(hash([{ ...quota, path: mig("20261111000001_storage_limit.sql") }]), base);
  });

  it("covers every file under supabase/migrations, at any depth and with any extension", () => {
    const quota = added(QUOTA, quotaSql("20261111000001"));
    const base = hash([quota]);
    for (const extra of [
      { path: mig("README.md"), content: "Notes.\n", added: true },
      { path: mig("seed_data.sql"), content: "insert into t values (1);\n", added: true },
      { path: mig("archive/20250101000001_old.sql"), content: "select 1;\n", added: true },
      { path: mig("archive/20250101000001_old.sql"), content: "select 1;\n", added: false },
      { path: mig("archive/20250101000001_old.sql"), content: null, added: false, deleted: true },
    ]) {
      const withExtra = hash([quota, extra]);
      assert.notEqual(withExtra, base, JSON.stringify(extra));
      // And an edit to it changes the hash too.
      if (!extra.deleted) {
        assert.notEqual(
          hash([quota, { ...extra, content: `${extra.content}-- edit\n` }]),
          withExtra,
        );
      }
    }
  });

  it("keys a file in a subfolder by its full path, never by rank", () => {
    // A versioned name one level down isn't a migration the CLI runs: renaming
    // it changes the hash, where renaming a direct one wouldn't.
    const sub = (name) => [
      added(QUOTA, quotaSql("20261111000001")),
      { path: mig(`archive/${name}`), content: "select 1;\n", added: true },
    ];
    assert.notEqual(hash(sub("20250101000002_old.sql")), hash(sub("20250101000001_old.sql")));
  });

  it("normalizes the PR's versions in files that aren't its migrations, so a renumber keeps them", () => {
    const readme = (v) => ({ path: mig("README.md"), content: `See ${v}.\n`, added: false });
    const before = [added(QUOTA, quotaSql("20261111000001")), readme("20261111000001")];
    const after = [
      added("20261113000001_storage_quota.sql", quotaSql("20261113000001")),
      readme("20261113000001"),
    ];
    assert.equal(hash(after), hash(before));
  });

  it("keys a changed existing migration by its full path, version included", () => {
    const changed = (name) => [{ path: mig(name), content: "select 1;\n", added: false }];
    assert.notEqual(
      hash(changed("20261020000002_explicit_data_api_grants.sql")),
      hash(changed(BASE)),
    );
    // Added, the same file's version is left out.
    const one = (name) => [added(name, "select 1;\n")];
    assert.equal(hash(one("20261020000002_explicit_data_api_grants.sql")), hash(one(BASE)));
    // And an added file never hashes like a changed one.
    assert.notEqual(hash(one(BASE)), hash(changed(BASE)));
  });

  it("normalizes the PR's versions in a changed existing migration too", () => {
    const line = (v) => `select 1;\n-- see ${v}_storage_quota\n`;
    const before = [
      added(QUOTA, quotaSql("20261111000001")),
      { path: mig(BASE), content: line("20261111000001"), added: false },
    ];
    const after = [
      added("20261113000001_storage_quota.sql", quotaSql("20261113000001")),
      { path: mig(BASE), content: line("20261113000001"), added: false },
    ];
    assert.equal(hash(after), hash(before));
  });

  it("leaves versions the PR doesn't add alone, and only digit-bounded ones", () => {
    const withRef = (ref) => [added(QUOTA, `-- after ${ref}\nselect 1;\n`)];
    // main's version, not the PR's: changing it changes the hash.
    assert.notEqual(hash(withRef("20261020000001")), hash(withRef("20261020000002")));
    // A longer number that merely contains the PR's version isn't normalized.
    assert.notEqual(hash(withRef("120261111000001")), hash(withRef("120261113000001")));
  });

  it("doesn't depend on the order of the files", () => {
    const files = [
      added(QUOTA, quotaSql("20261111000001")),
      { path: mig(BASE), content: "select 2;\n", added: false },
      added("20261111000002_more.sql", "select 3;\n"),
    ];
    assert.equal(hash([...files].reverse()), hash(files));
    assert.equal(hash([files[1], files[0], files[2]]), hash(files));
  });

  it("tells two added files with the same name apart", () => {
    const pair = (a, b) => [added("20261111000001_fix.sql", a), added("20261112000001_fix.sql", b)];
    assert.notEqual(
      hash(pair("select 1;\n", "select 2;\n")),
      hash(pair("select 2;\n", "select 1;\n")),
    );
  });
});

// ── End to end, against a bare origin ───────────────────────────────────────

function cleanEnv() {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
  return env;
}

function gitIn(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv() });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(dir, rel, content) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

function cli(cwd, args) {
  const r = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env: cleanEnv() });
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

describe("migration-approval.mjs hash (end to end, #802/#829)", () => {
  let dir;
  let origin;
  let author;
  let factory;
  let bHead;
  let mainAfterA;
  let approved;

  function commit(cwd, message) {
    gitIn(cwd, ["add", "-A"]);
    gitIn(cwd, ["commit", "-q", "--no-verify", "-m", message]);
    return gitIn(cwd, ["rev-parse", "HEAD"]);
  }

  // Publishes <sha> (in <repo>) as GitHub's refs/pull/802/head.
  function publish(repo, sha) {
    gitIn(repo, ["push", "-q", "-f", "origin", `${sha}:refs/pull/802/head`]);
  }

  const hashAt = (head) => cli(factory, ["hash", "--root", factory, "--pr", "802", "--head", head]);

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "migration-approval-"));
    origin = join(dir, "origin.git");
    author = join(dir, "author");
    factory = join(dir, "factory");
    gitIn(dir, ["init", "-q", "--bare", "-b", "main", origin]);
    gitIn(dir, ["init", "-q", "-b", "main", author]);
    gitIn(author, ["config", "user.email", "t@example.com"]);
    gitIn(author, ["config", "user.name", "T"]);
    gitIn(author, ["config", "commit.gpgsign", "false"]);
    write(author, `supabase/migrations/${BASE}`, "select 1;\n");
    write(author, "supabase/migrations/README.md", "Migrations.\n");
    commit(author, "base");
    gitIn(author, ["remote", "add", "origin", origin]);
    gitIn(author, ["push", "-q", "origin", "main"]);

    // #829 at 20261111000001, merged first.
    gitIn(author, ["checkout", "-q", "-b", "issue-820"]);
    write(
      author,
      `supabase/migrations/${NOTE}`,
      "create function public.note_text_chars() returns int;\n",
    );
    commit(author, "pr 829");
    // #802 at the same version: a self-reference and a bare version in its own
    // SQL, a line added to a migration main already has, and a file that isn't
    // a migration (README.md), which the hash covers too and the renumber
    // rewrites.
    gitIn(author, ["checkout", "-q", "-b", "issue-794", "main"]);
    write(author, `supabase/migrations/${QUOTA}`, quotaSql("20261111000001"));
    write(
      author,
      `supabase/migrations/${BASE}`,
      "select 1;\n-- 20261111000001_storage_quota adds storage_bytes\n",
    );
    write(author, "supabase/migrations/README.md", "Migrations, with 20261111000001.\n");
    bHead = commit(author, "pr 802");
    publish(author, bHead);
    gitIn(author, ["checkout", "-q", "main"]);
    gitIn(author, ["merge", "-q", "--squash", "issue-820"]);
    mainAfterA = commit(author, "feat: product metrics (#829)");
    gitIn(author, ["push", "-q", "origin", "main"]);
    gitIn(dir, ["clone", "-q", origin, factory]);
  });

  after(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("hashes every file the PR adds or changes under supabase/migrations", () => {
    const r = hashAt(bHead);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.out.hash, /^[0-9a-f]{16}$/);
    assert.deepEqual(r.out.files, [mig(BASE), mig(QUOTA), mig("README.md")]);
    approved = r.out.hash;
    // The library agrees with the CLI, and reads main's NOTE as main's, not the PR's.
    const { files } = prMigrationFiles({ cwd: factory, head: bHead, main: mainAfterA });
    assert.deepEqual(
      files.map((f) => [f.path, f.added]),
      [
        [mig(BASE), false],
        [mig(QUOTA), true],
        [mig("README.md"), false],
      ],
    );
    assert.equal(migrationSqlHash({ files }), approved);
  });

  let R;
  it("keeps the hash across the factory's own renumber commit (ADR-0077)", () => {
    const plan = computeRenumber({ cwd: factory, head: bHead, main: mainAfterA, today: TODAY });
    assert.equal(plan.status, "fixable", plan.reason);
    assert.deepEqual(plan.map, { [QUOTA]: "20261113000001_storage_quota.sql" });
    R = writeRenumberCommit({ cwd: factory, head: bHead, changes: plan.changes, map: plan.map });
    // R really rewrote the versions, in the PR's file and in main's.
    assert.match(
      gitIn(factory, ["show", `${R}:supabase/migrations/20261113000001_storage_quota.sql`]),
      /^-- 20261113000001_storage_quota: .* as 20261113000001\)$/m,
    );
    assert.match(
      gitIn(factory, ["show", `${R}:supabase/migrations/${BASE}`]),
      /^-- 20261113000001_storage_quota adds/m,
    );
    publish(factory, R);
    const r = hashAt(R);
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      gitIn(factory, ["show", `${R}:supabase/migrations/README.md`]),
      /^Migrations, with 20261113000001\.$/m,
    );
    assert.deepEqual(r.out.files, [
      mig(BASE),
      mig("20261113000001_storage_quota.sql"),
      mig("README.md"),
    ]);
    assert.equal(r.out.hash, approved);
  });

  let M;
  it("keeps it once GitHub's update-branch merges main onto the renumber", () => {
    gitIn(author, ["fetch", "-q", "origin", "refs/pull/802/head", "main"]);
    gitIn(author, ["checkout", "-q", "--detach", R]);
    gitIn(author, ["merge", "-q", "--no-ff", "--no-edit", "origin/main"]);
    M = gitIn(author, ["rev-parse", "HEAD"]);
    publish(author, M);
    const r = hashAt(M);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.hash, approved);
  });

  it("changes once the SQL is edited", () => {
    gitIn(author, ["checkout", "-q", "--detach", M]);
    write(
      author,
      "supabase/migrations/20261113000001_storage_quota.sql",
      quotaSql("20261113000001").replace("bigint", "int"),
    );
    const edited = commit(author, "fix: int");
    publish(author, edited);
    const r = hashAt(edited);
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(r.out.hash, approved);
    gitIn(author, ["checkout", "-q", "main"]);
  });

  it("fails with a message when the PR can't be fetched or the head isn't in it", () => {
    const missing = cli(factory, ["hash", "--root", factory, "--pr", "999", "--head", bHead]);
    assert.equal(missing.status, 1);
    assert.equal(missing.out, null);
    assert.match(JSON.parse(missing.stderr).error, /couldn't fetch main and PR #999/);
    const stranger = cli(factory, [
      "hash",
      "--root",
      factory,
      "--pr",
      "802",
      "--head",
      "f".repeat(40),
    ]);
    assert.equal(stranger.status, 1);
    assert.match(JSON.parse(stranger.stderr).error, /isn't in the fetched PR #802/);
    const usage = cli(factory, ["hash", "--root", factory, "--pr", "802"]);
    assert.equal(usage.status, 1);
    assert.match(JSON.parse(usage.stderr).error, /--head is required/);
  });
});
