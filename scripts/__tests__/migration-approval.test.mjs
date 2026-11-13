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

describe("migrationSqlHash", () => {
  const hash = (files) => migrationSqlHash({ files });

  it("is 16 hex characters", () => {
    assert.match(
      hash([{ name: QUOTA, content: quotaSql("20261111000001"), added: true }]),
      /^[0-9a-f]{16}$/,
    );
  });

  it("keeps the hash across a renumber, self-references inside the SQL included", () => {
    const before = [
      { name: QUOTA, content: quotaSql("20261111000001"), added: true },
      {
        name: "20261111000002_storage_quota_policy.sql",
        content: "-- after 20261111000001_storage_quota.sql\ncreate policy q on public.profiles;\n",
        added: true,
      },
    ];
    const after = [
      {
        name: "20261113000001_storage_quota.sql",
        content: quotaSql("20261113000001"),
        added: true,
      },
      {
        name: "20261113000002_storage_quota_policy.sql",
        content: "-- after 20261113000001_storage_quota.sql\ncreate policy q on public.profiles;\n",
        added: true,
      },
    ];
    assert.equal(hash(after), hash(before));
  });

  it("keeps the hash when a renumber splits two files that shared a version", () => {
    const before = [
      { name: "20261201000001_x.sql", content: "-- then 20261201000001_y.sql\n", added: true },
      { name: "20261201000001_y.sql", content: "-- after 20261201000001_x\n", added: true },
    ];
    const after = [
      { name: "20261201000001_x.sql", content: "-- then 20261201000002_y.sql\n", added: true },
      { name: "20261201000002_y.sql", content: "-- after 20261201000001_x\n", added: true },
    ];
    assert.equal(hash(after), hash(before));
  });

  it("changes on any SQL edit", () => {
    const base = [{ name: QUOTA, content: quotaSql("20261111000001"), added: true }];
    for (const content of [
      quotaSql("20261111000001").replace("bigint", "int"),
      `${quotaSql("20261111000001")}drop table public.notes;\n`,
      quotaSql("20261111000001").replace("-- ", "--"),
    ]) {
      assert.notEqual(hash([{ ...base[0], content }]), hash(base), content);
    }
  });

  it("changes when a file is added, deleted or renamed to another name", () => {
    const quota = { name: QUOTA, content: quotaSql("20261111000001"), added: true };
    const base = hash([quota]);
    assert.notEqual(
      hash([quota, { name: "20261111000002_more.sql", content: "select 1;\n", added: true }]),
      base,
    );
    assert.notEqual(
      hash([quota, { name: BASE, content: null, added: false, deleted: true }]),
      base,
    );
    assert.notEqual(hash([{ ...quota, name: "20261111000001_storage_limit.sql" }]), base);
  });

  it("keys a changed existing migration by its full name, version included", () => {
    const changed = (name) => [{ name, content: "select 1;\n", added: false }];
    assert.notEqual(
      hash(changed("20261020000002_explicit_data_api_grants.sql")),
      hash(changed(BASE)),
    );
    // Added, the same file's version is left out.
    const added = (name) => [{ name, content: "select 1;\n", added: true }];
    assert.equal(hash(added("20261020000002_explicit_data_api_grants.sql")), hash(added(BASE)));
    // And an added file never hashes like a changed one.
    assert.notEqual(hash(added(BASE)), hash(changed(BASE)));
  });

  it("normalizes the PR's versions in a changed existing migration too", () => {
    const line = (v) => `select 1;\n-- see ${v}_storage_quota\n`;
    const before = [
      { name: QUOTA, content: quotaSql("20261111000001"), added: true },
      { name: BASE, content: line("20261111000001"), added: false },
    ];
    const after = [
      {
        name: "20261113000001_storage_quota.sql",
        content: quotaSql("20261113000001"),
        added: true,
      },
      { name: BASE, content: line("20261113000001"), added: false },
    ];
    assert.equal(hash(after), hash(before));
  });

  it("leaves versions the PR doesn't add alone, and only digit-bounded ones", () => {
    const withRef = (ref) => [
      { name: QUOTA, content: `-- after ${ref}\nselect 1;\n`, added: true },
    ];
    // main's version, not the PR's: changing it changes the hash.
    assert.notEqual(hash(withRef("20261020000001")), hash(withRef("20261020000002")));
    // A longer number that merely contains the PR's version isn't normalized.
    assert.notEqual(hash(withRef("120261111000001")), hash(withRef("120261113000001")));
  });

  it("doesn't depend on the order of the files", () => {
    const files = [
      { name: QUOTA, content: quotaSql("20261111000001"), added: true },
      { name: BASE, content: "select 2;\n", added: false },
      { name: "20261111000002_more.sql", content: "select 3;\n", added: true },
    ];
    assert.equal(hash([...files].reverse()), hash(files));
    assert.equal(hash([files[1], files[0], files[2]]), hash(files));
  });

  it("tells two added files with the same name apart", () => {
    const pair = (a, b) => [
      { name: "20261111000001_fix.sql", content: a, added: true },
      { name: "20261112000001_fix.sql", content: b, added: true },
    ];
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
    // SQL, a line added to a migration main already has, and a file the hash
    // doesn't cover (not *.sql).
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

  it("hashes the PR's added and changed *.sql files directly under supabase/migrations", () => {
    const r = hashAt(bHead);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.out.hash, /^[0-9a-f]{16}$/);
    assert.deepEqual(r.out.files, [BASE, QUOTA]);
    approved = r.out.hash;
    // The library agrees with the CLI, and reads main's NOTE as main's, not the PR's.
    const { files } = prMigrationFiles({ cwd: factory, head: bHead, main: mainAfterA });
    assert.deepEqual(
      files.map((f) => [f.name, f.added]),
      [
        [BASE, false],
        [QUOTA, true],
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
    assert.deepEqual(r.out.files, [BASE, "20261113000001_storage_quota.sql"]);
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
