import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkMigrationOrder } from "../lib/check-migration-order.mjs";
import {
  addedLineNumbers,
  claimedVersions,
  makeRewriter,
  manualComment,
  mergedMigrationNames,
  objectOverlap,
  objectsTouched,
  planRenumber,
  pushRenumber,
  renumberComment,
  rewriteLines,
  verifyRenumber,
  writeRenumberCommit,
} from "../lib/migration-renumber.mjs";

// ADR-0076. PRs #802 (storage quota) and #829 (product metrics) both added
// migration 20261111000001. Once #829 merged, #802 only went red after an
// update-branch, and the way back was an LLM fix pass, a re-review and a second
// Approved drag. The factory now renames the stale PR's migrations itself, in a
// commit a check proves is nothing but that rename.

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..");
const CLI = resolve(SCRIPTS, "lib", "migration-renumber.mjs");
const SAFETY = resolve(SCRIPTS, "check-migration-safety.sh");
const AGENT = resolve(SCRIPTS, "factory-agent.sh");
const TODAY = new Date("2026-11-13T12:00:00Z");

const BASE = "20261020000001_explicit_data_api_grants.sql";
const NOTE = "20261111000001_note_text_chars.sql";
const QUOTA = "20261111000001_storage_quota.sql";

describe("mergedMigrationNames", () => {
  it("is main, less what the PR deleted, plus what it added", () => {
    assert.deepEqual(
      mergedMigrationNames({
        mbNames: ["a.sql", "b.sql", "gone.sql"],
        headNames: ["a.sql", "b.sql", "pr.sql"],
        mainNames: ["a.sql", "b.sql", "gone.sql", "main.sql"],
      }),
      ["a.sql", "b.sql", "main.sql", "pr.sql"],
    );
  });

  it("is what makes a duplicate read as duplicate-base, not renamed-base", () => {
    // Fed only the head's files, the PR's file looks like a rename of main's.
    const headOnly = checkMigrationOrder({
      localFiles: [BASE, QUOTA],
      baseFiles: [BASE, NOTE],
      today: TODAY,
    });
    assert.equal(headOnly[0].reason, "renamed-base");
    const merged = checkMigrationOrder({
      localFiles: mergedMigrationNames({
        mbNames: [BASE],
        headNames: [BASE, QUOTA],
        mainNames: [BASE, NOTE],
      }),
      baseFiles: [BASE, NOTE],
      today: TODAY,
    });
    assert.equal(merged[0].reason, "duplicate-base");
  });
});

describe("checkMigrationOrder extraTaken", () => {
  it("only moves suggestions past the extra versions, and reports the same findings", () => {
    const args = { localFiles: [BASE, NOTE, QUOTA], baseFiles: [BASE, NOTE], today: TODAY };
    const plain = checkMigrationOrder(args);
    const extra = checkMigrationOrder({
      ...args,
      extraTaken: ["20261113000001", "20261113000002_other.sql", "junk"],
    });
    assert.equal(plain[0].suggested, "20261113000001");
    assert.equal(extra[0].suggested, "20261113000003");
    assert.deepEqual(
      extra.map(({ suggested, ...rest }) => rest),
      plain.map(({ suggested, ...rest }) => rest),
    );
  });
});

describe("planRenumber", () => {
  const plan = (o) => planRenumber({ today: TODAY, ...o });

  it("is clean when the PR's migrations already sort after main's", () => {
    const r = plan({
      mbNames: [BASE],
      headNames: [BASE, "20261201000001_new.sql"],
      mainNames: [BASE, NOTE],
    });
    assert.equal(r.status, "clean");
    assert.deepEqual(r.map, {});
  });

  it("moves a stale migration to today's first free slot", () => {
    const r = plan({
      mbNames: [BASE],
      headNames: [BASE, "20261101000001_stale.sql"],
      mainNames: [BASE, "20261105000001_main.sql"],
    });
    assert.equal(r.status, "fixable");
    assert.deepEqual(r.map, { "20261101000001_stale.sql": "20261113000001_stale.sql" });
  });

  it("moves a duplicate of a version main gained since the merge base (#802/#829)", () => {
    const r = plan({ mbNames: [BASE], headNames: [BASE, QUOTA], mainNames: [BASE, NOTE] });
    assert.equal(r.status, "fixable");
    assert.equal(r.findings[0].reason, "duplicate-base");
    assert.deepEqual(r.map, { [QUOTA]: "20261113000001_storage_quota.sql" });
  });

  it("moves the second of two PR migrations that share a version", () => {
    const r = plan({
      mbNames: [BASE],
      headNames: [BASE, "20261201000001_x.sql", "20261201000001_y.sql"],
      mainNames: [BASE],
    });
    assert.equal(r.status, "fixable");
    assert.equal(r.findings[0].reason, "duplicate");
    assert.deepEqual(r.map, { "20261201000001_y.sql": "20261201000002_y.sql" });
  });

  it("moves a fresh migration too when it must stay after a renamed stale one", () => {
    const r = plan({
      mbNames: [BASE],
      headNames: [BASE, "20261105000001_create_widgets.sql", "20261112000001_alter_widgets.sql"],
      mainNames: [BASE, "20261110000001_main.sql"],
    });
    assert.equal(r.status, "fixable");
    assert.deepEqual(r.map, {
      "20261105000001_create_widgets.sql": "20261113000001_create_widgets.sql",
      "20261112000001_alter_widgets.sql": "20261113000002_alter_widgets.sql",
    });
    assert.deepEqual(
      r.findings.map((f) => f.reason),
      ["stale", "order"],
    );
  });

  it("skips versions other open PRs claim", () => {
    const r = plan({
      mbNames: [BASE],
      headNames: [BASE, QUOTA],
      mainNames: [BASE, NOTE],
      extraTaken: ["20261113000001", "20261113000002"],
    });
    assert.deepEqual(r.map, { [QUOTA]: "20261113000003_storage_quota.sql" });
  });

  it("holds a version that isn't 14 digits, or a renamed main migration, for a person", () => {
    const shape = plan({
      mbNames: [BASE],
      headNames: [BASE, "2026111300001_short.sql"],
      mainNames: [BASE],
    });
    assert.equal(shape.status, "manual");
    assert.match(shape.reason, /isn't 14 digits/);
    const renamed = plan({
      mbNames: [BASE],
      headNames: ["20261020000001_renamed.sql"],
      mainNames: [BASE],
    });
    assert.equal(renamed.status, "manual");
    assert.match(renamed.reason, /renames `20261020000001_explicit_data_api_grants\.sql`/);
  });

  it("holds SQL that touches an object main's newer migrations also touch", () => {
    const r = plan({
      mbNames: [BASE],
      headNames: [BASE, QUOTA],
      mainNames: [BASE, NOTE],
      prSql: { [QUOTA]: "create or replace function public.note_text_chars() returns int;" },
      mainSql: { [NOTE]: "CREATE OR REPLACE FUNCTION note_text_chars(c jsonb) returns int;" },
    });
    assert.equal(r.status, "manual");
    assert.deepEqual(r.overlap, [
      { object: "function public.note_text_chars", pr: [QUOTA], main: [NOTE] },
    ]);
    assert.match(
      r.reason,
      /function public\.note_text_chars \(20261111000001_note_text_chars\.sql\)/,
    );
    assert.match(r.reason, /Renumbering changes which definition runs last/);
  });

  it("renumbers SQL that touches different objects", () => {
    const r = plan({
      mbNames: [BASE],
      headNames: [BASE, QUOTA],
      mainNames: [BASE, NOTE],
      prSql: { [QUOTA]: "alter table public.profiles add column storage_bytes bigint;" },
      mainSql: { [NOTE]: "create or replace function public.note_text_chars() returns int;" },
    });
    assert.equal(r.status, "fixable");
  });
});

describe("objectsTouched / objectOverlap", () => {
  it("names created, altered and dropped objects, schema-qualified and case-folded", () => {
    const sql = `
      create policy "Users read" on notes for select using (true);
      drop trigger if exists t1 on public.notes;
      create trigger t1 before insert or update on public.notes
        for each row execute function public.f();
      create unique index if not exists notes_idx on public.notes (id);
      create index on public.notes (x);
      drop function if exists public.a(int), b();
      drop table if exists x, public.y;
      alter table only "Public"."Notes" add column z int;
      create type public.mood as enum ('a');
      create or replace view v as select 1;
      create sequence if not exists s;
    `;
    assert.deepEqual(objectsTouched(sql), [
      "function public.a",
      "function public.b",
      "index public.notes_idx",
      "policy users read on public.notes",
      "sequence public.s",
      "table public.notes",
      "table public.x",
      "table public.y",
      "trigger t1 on public.notes",
      "type public.mood",
      "view public.v",
    ]);
  });

  it("ignores comments, string literals and function bodies", () => {
    const sql = `
      -- create table commented(id int);
      /* drop table blocked; */
      select 'create table quoted(id int)';
      do $$ begin create table inside(id int); end $$;
      create function public.g() returns void language plpgsql as $body$
      begin drop table hidden; end $body$;
    `;
    assert.deepEqual(objectsTouched(sql), ["function public.g"]);
  });

  it("reads this repo's real migrations", () => {
    const sql = readFileSync(
      resolve(SCRIPTS, "..", "supabase", "migrations", "20261112000002_product_metrics.sql"),
      "utf8",
    );
    const objects = objectsTouched(sql);
    assert.ok(objects.includes("table public.metrics_excluded_users"));
    assert.ok(objects.includes("function public.metrics_signups"));
  });

  it("reports only objects both sides touch", () => {
    assert.deepEqual(
      objectOverlap(
        { "p.sql": "alter table public.notes add column a int; create function f() returns int;" },
        { "m.sql": "alter table notes add column b int;" },
      ),
      [{ object: "table public.notes", pr: ["p.sql"], main: ["m.sql"] }],
    );
  });
});

describe("makeRewriter / rewriteLines / addedLineNumbers", () => {
  const map = { [QUOTA]: "20261113000001_storage_quota.sql" };

  it("replaces the full stem first, then a digit-bounded bare version", () => {
    const bare = [];
    const out = makeRewriter(map)(
      "supabase/migrations/20261111000001_storage_quota.sql 20261111000001 120261111000001",
      (v) => bare.push(v),
    );
    assert.equal(
      out,
      "supabase/migrations/20261113000001_storage_quota.sql 20261113000001 120261111000001",
    );
    assert.deepEqual(bare, ["20261111000001"]);
  });

  it("applies the whole map in one pass, so a move chain never compounds", () => {
    const rw = makeRewriter({
      "20260101000001_a.sql": "20260101000002_a.sql",
      "20260101000002_b.sql": "20260101000003_b.sql",
    });
    assert.equal(
      rw("20260101000001_a then 20260101000002_b"),
      "20260101000002_a then 20260101000003_b",
    );
  });

  it("rewrites only the added lines", () => {
    const text = "20261111000001_storage_quota\n20261111000001_storage_quota\n";
    const out = rewriteLines(text, new Set([2]), makeRewriter(map));
    assert.equal(out.text, "20261111000001_storage_quota\n20261113000001_storage_quota\n");
  });

  it("reads added line numbers from -U0 hunks", () => {
    const diff = "@@ -0,0 +1,2 @@\n+a\n+b\n@@ -5 +7 @@\n-x\n+y\n@@ -9,2 +10,0 @@\n-z\n";
    assert.deepEqual(
      [...addedLineNumbers(diff)].sort((a, b) => a - b),
      [1, 2, 7],
    );
  });
});

describe("claimedVersions", () => {
  it("lists other open PRs' migration files with the uncapped gh pr diff --name-only", () => {
    const calls = [];
    const gh = (args) => {
      calls.push(args.join(" "));
      if (args[1] === "list") return JSON.stringify([{ number: 802 }, { number: 829 }]);
      return "apps/web/x.ts\nsupabase/migrations/20261111000001_note_text_chars.sql\nsupabase/migrations/nested/x.sql\n";
    };
    assert.deepEqual(claimedVersions({ excludePr: 802, gh }), [
      { pr: 829, file: "20261111000001_note_text_chars.sql" },
    ]);
    assert.ok(calls.some((c) => c === "pr diff 829 --repo JakubAnderwald/drafto --name-only"));
    assert.ok(!calls.some((c) => c.startsWith("pr diff 802")));
    assert.ok(!calls.some((c) => c.includes("--json files")));
  });
});

describe("comments", () => {
  it("gives the map and the dev repair, and warns when the old version is also main's", () => {
    const body = renumberComment({
      pr: 802,
      to: "e".repeat(40),
      map: { [QUOTA]: "20261113000001_storage_quota.sql" },
      findings: [
        { reason: "duplicate-base", file: QUOTA, version: "20261111000001", others: [NOTE] },
      ],
    });
    assert.match(
      body,
      /\| `20261111000001_storage_quota\.sql` \| `20261113000001_storage_quota\.sql` \|/,
    );
    assert.match(
      body,
      /supabase migration repair --status reverted 20261111000001\nsupabase migration repair --status applied 20261113000001/,
    );
    assert.match(body, /also the version of main's `20261111000001_note_text_chars\.sql`/);
    assert.match(body, /Prod needs nothing: it is pushed only from `main`, after the merge/);
    assert.doesNotMatch(body, /tbmjbxxseonkciqovnpl/);
  });

  it("names the reason and the column on a manual hold", () => {
    const body = manualComment({ pr: 802, reason: "it overlaps", where: "Approved" });
    assert.match(body, /can't renumber them mechanically: it overlaps\./);
    assert.match(body, /The card stays in \*\*Approved\*\*/);
  });
});

// ── End to end, against a bare origin ───────────────────────────────────────

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "MIGRATION_BASE_REF"]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

function gitIn(cwd, args, env = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv(env) });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(dir, rel, content) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

function cli(cwd, args, env = {}) {
  const r = spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8", env: cleanEnv(env) });
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

describe("migration-renumber end to end (#802/#829)", () => {
  let dir;
  let origin;
  let author;
  let factory;
  let aHead;
  let bHead;
  let mainAfterA;
  const opts = ["--claimed-json", "[]", "--today", "2026-11-13"];

  function commit(cwd, message) {
    gitIn(cwd, ["add", "-A"]);
    gitIn(cwd, ["commit", "-q", "--no-verify", "-m", message]);
    return gitIn(cwd, ["rev-parse", "HEAD"]);
  }

  // A factory PR: branch factory/issue-<issue> from main, also published as
  // GitHub's refs/pull/<pr>/head.
  function openPr(issue, pr, files, from = "main") {
    gitIn(author, ["checkout", "-q", "-B", `issue-${issue}`, from]);
    for (const [rel, content] of Object.entries(files)) write(author, rel, content);
    const sha = commit(author, `pr ${pr}`);
    gitIn(author, [
      "push",
      "-q",
      "-f",
      "origin",
      `HEAD:refs/heads/factory/issue-${issue}`,
      `HEAD:refs/pull/${pr}/head`,
    ]);
    gitIn(author, ["checkout", "-q", "main"]);
    return sha;
  }

  function squashMerge(branch, message) {
    gitIn(author, ["checkout", "-q", "main"]);
    gitIn(author, ["pull", "-q", "--ff-only", "origin", "main"]);
    gitIn(author, ["merge", "-q", "--squash", branch]);
    const sha = commit(author, message);
    gitIn(author, ["push", "-q", "origin", "main"]);
    return sha;
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "migration-renumber-"));
    origin = join(dir, "origin.git");
    author = join(dir, "author");
    factory = join(dir, "factory");
    gitIn(dir, ["init", "-q", "--bare", "-b", "main", origin]);
    gitIn(dir, ["init", "-q", "-b", "main", author]);
    gitIn(author, ["config", "user.email", "t@example.com"]);
    gitIn(author, ["config", "user.name", "T"]);
    gitIn(author, ["config", "commit.gpgsign", "false"]);
    write(author, `supabase/migrations/${BASE}`, "select 1;\n");
    write(author, "docs/migrations-log.md", "# Log\n\n- 20261020000001: grants\n");
    commit(author, "base");
    gitIn(author, ["remote", "add", "origin", origin]);
    gitIn(author, ["push", "-q", "origin", "main"]);

    // #829: note_text_chars at 20261111000001, referenced by its own files.
    aHead = openPr(820, 829, {
      [`supabase/migrations/${NOTE}`]:
        "create or replace function public.note_text_chars(content jsonb) returns int\n" +
        "language sql as $$ select 1 $$;\n",
      "docs/metrics.md": "Counted by 20261111000001_note_text_chars (version 20261111000001).\n",
    });
    // #802: storage_quota at the same version, with a stem reference, a bare
    // reference and a line added to a file main already has.
    bHead = openPr(794, 802, {
      [`supabase/migrations/${QUOTA}`]:
        "-- 20261111000001_storage_quota: per-user storage quota\n" +
        "alter table public.profiles add column storage_bytes bigint;\n",
      "apps/web/__tests__/quota.test.ts":
        'const sql = read("supabase/migrations/20261111000001_storage_quota.sql");\n' +
        "// applied to dev as 20261111000001\n",
      "docs/migrations-log.md":
        "# Log\n\n- 20261020000001: grants\n- 20261111000001_storage_quota: quota\n",
    });
    mainAfterA = squashMerge("issue-820", "feat: product metrics (#829)");
    gitIn(dir, ["clone", "-q", origin, factory]);
  });

  after(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("prechecks #802 as fixable without pushing anything", () => {
    const r = cli(factory, [
      "precheck",
      "--root",
      factory,
      "--pr",
      "802",
      "--head",
      bHead,
      ...opts,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.status, "fixable");
    assert.equal(r.out.main, mainAfterA);
    assert.deepEqual(r.out.map, { [QUOTA]: "20261113000001_storage_quota.sql" });
    assert.equal(gitIn(origin, ["rev-parse", "refs/heads/factory/issue-794"]), bHead);
  });

  let R;
  it("pushes R on #802's head: B's files renamed and rewritten, nothing else", () => {
    const r = cli(factory, [
      "apply",
      "--root",
      factory,
      "--issue",
      "794",
      "--pr",
      "802",
      "--head",
      bHead,
      ...opts,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.status, "pushed", r.out.reason);
    R = r.out.to;
    assert.equal(r.out.from, bHead);
    assert.equal(gitIn(origin, ["rev-parse", "refs/heads/factory/issue-794"]), R);
    assert.equal(gitIn(factory, ["rev-parse", `${R}^@`]), bHead, "R's only parent is the PR head");
    assert.equal(
      gitIn(factory, ["log", "-1", "--format=%an <%ae>|%cn <%ce>", R]),
      "Drafto factory <factory@drafto.eu>|Drafto factory <factory@drafto.eu>",
    );
    assert.deepEqual(
      gitIn(factory, ["diff", "--name-status", "--no-renames", bHead, R]).split("\n").sort(),
      [
        "A\tsupabase/migrations/20261113000001_storage_quota.sql",
        "D\tsupabase/migrations/20261111000001_storage_quota.sql",
        "M\tapps/web/__tests__/quota.test.ts",
        "M\tdocs/migrations-log.md",
      ].sort(),
    );
    assert.equal(
      gitIn(factory, ["show", `${R}:apps/web/__tests__/quota.test.ts`]),
      'const sql = read("supabase/migrations/20261113000001_storage_quota.sql");\n// applied to dev as 20261113000001',
    );
    assert.equal(
      gitIn(factory, ["show", `${R}:docs/migrations-log.md`]),
      "# Log\n\n- 20261020000001: grants\n- 20261113000001_storage_quota: quota",
    );
    assert.match(
      gitIn(factory, ["show", `${R}:supabase/migrations/20261113000001_storage_quota.sql`]),
      /^-- 20261113000001_storage_quota: per-user storage quota\n/,
    );
    assert.match(r.out.comment, /20261113000001_storage_quota\.sql/);
  });

  it("leaves #829's files and references alone once merged with main", () => {
    const wt = join(dir, "merged");
    gitIn(factory, ["fetch", "-q", "origin"]);
    gitIn(factory, ["worktree", "add", "-q", "--detach", wt, R]);
    gitIn(wt, ["config", "user.email", "t@example.com"]);
    gitIn(wt, ["config", "user.name", "T"]);
    gitIn(wt, ["merge", "-q", "--no-ff", "--no-edit", "origin/main"]);
    assert.equal(
      readFileSync(join(wt, "docs/metrics.md"), "utf8"),
      "Counted by 20261111000001_note_text_chars (version 20261111000001).\n",
    );
    assert.ok(
      readFileSync(join(wt, "supabase/migrations", NOTE), "utf8").includes("note_text_chars"),
    );
    // The repo's own migration check, as CI runs it on the merge.
    const res = spawnSync("bash", [SAFETY], {
      cwd: wt,
      encoding: "utf8",
      env: cleanEnv({ MIGRATION_BASE_REF: mainAfterA }),
    });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Checking migration order against/);
    // …and the head before the renumber fails it.
    gitIn(wt, ["checkout", "-q", "--detach", bHead]);
    gitIn(wt, ["merge", "-q", "--no-ff", "--no-edit", "origin/main"]);
    const stale = spawnSync("bash", [SAFETY], {
      cwd: wt,
      encoding: "utf8",
      env: cleanEnv({ MIGRATION_BASE_REF: mainAfterA }),
    });
    assert.equal(stale.status, 1, stale.stdout);
    assert.match(
      stale.stdout,
      /20261111000001_storage_quota\.sql — new migration version 20261111000001 is already used by/,
    );
    gitIn(factory, ["worktree", "remove", "--force", wt]);
  });

  it("verifies R, and the CLI agrees", () => {
    const map = { [QUOTA]: "20261113000001_storage_quota.sql" };
    assert.deepEqual(verifyRenumber({ cwd: factory, from: bHead, to: R, map }), {
      ok: true,
      reasons: [],
    });
    const r = cli(factory, [
      "verify",
      "--root",
      factory,
      "--from",
      bHead,
      "--to",
      R,
      "--map",
      JSON.stringify(map),
    ]);
    assert.equal(r.status, 0, JSON.stringify(r.out));
    assert.equal(r.out.ok, true);
  });

  it("prechecks the renumbered head as clean", () => {
    const r = cli(factory, ["precheck", "--root", factory, "--pr", "802", "--head", R, ...opts]);
    // pull/802/head still points at B in this origin: the CLI plans the head it is given.
    assert.equal(r.out.status, "clean", r.out.reason);
  });

  describe("verify rejects a commit that is more than the rename", () => {
    const map = { [QUOTA]: "20261113000001_storage_quota.sql" };
    const NEW = "supabase/migrations/20261113000001_storage_quota.sql";
    const OLD = `supabase/migrations/${QUOTA}`;
    const show = (ref, p) => `${gitIn(factory, ["show", `${ref}:${p}`])}\n`;
    const tampered = (changes) =>
      verifyRenumber({
        cwd: factory,
        from: bHead,
        to: writeRenumberCommit({ cwd: factory, head: bHead, changes, map }),
        map,
      });
    const renamed = (content) => ({ path: NEW, removes: OLD, mode: "100644", content });

    it("an SQL edit inside the renamed migration", () => {
      const r = tampered([renamed(show(R, NEW).replace("bigint", "int"))]);
      assert.equal(r.ok, false);
      assert.match(
        r.reasons.join("\n"),
        /20261113000001_storage_quota\.sql:2 changes more than the migration names/,
      );
    });

    it("a rewrite of a line the PR didn't add", () => {
      const r = tampered([
        renamed(show(R, NEW)),
        {
          path: "docs/migrations-log.md",
          mode: "100644",
          content: "# Log!\n\n- 20261020000001: grants\n- 20261113000001_storage_quota: quota\n",
        },
      ]);
      assert.equal(r.ok, false);
      assert.match(
        r.reasons.join("\n"),
        /docs\/migrations-log\.md:1 changes a line this PR didn't add/,
      );
    });

    it("a file the PR doesn't change", () => {
      const r = tampered([
        renamed(show(R, NEW)),
        { path: "docs/metrics.md", mode: "100644", content: "x\n" },
      ]);
      assert.equal(r.ok, false);
      assert.match(r.reasons.join("\n"), /docs\/metrics\.md: unexpected A/);
    });

    it("a copy instead of a rename, or a map R doesn't follow", () => {
      const copy = tampered([{ path: NEW, mode: "100644", content: show(R, NEW) }]);
      assert.equal(copy.ok, false);
      assert.match(copy.reasons.join("\n"), /wasn't renamed/);
      const wrongMap = verifyRenumber({
        cwd: factory,
        from: bHead,
        to: R,
        map: { [QUOTA]: "20261113000009_storage_quota.sql" },
      });
      assert.equal(wrongMap.ok, false);
    });

    it("a commit whose parent isn't the PR head", () => {
      const r = verifyRenumber({ cwd: factory, from: aHead, to: R, map });
      assert.equal(r.ok, false);
      assert.match(r.reasons.join("\n"), /only parent must be/);
    });
  });

  it("refuses to push anywhere but a factory branch", () => {
    assert.throws(
      () => pushRenumber({ cwd: factory, sha: R, branch: "main" }),
      /not a factory branch/,
    );
  });

  it("is rejected, not forced, once the branch moved", () => {
    const stale = openPr(900, 901, {
      [`supabase/migrations/20261101000001_stale.sql`]: "select 2;\n",
    });
    // A fix lands on the branch after the factory read the head.
    gitIn(author, ["checkout", "-q", "-B", "issue-900", stale]);
    write(author, "fix.txt", "fix\n");
    const moved = commit(author, "a fix");
    gitIn(author, [
      "push",
      "-q",
      "origin",
      "HEAD:refs/heads/factory/issue-900",
      "HEAD:refs/pull/901/head",
    ]);
    gitIn(author, ["checkout", "-q", "main"]);
    const r = cli(factory, [
      "apply",
      "--root",
      factory,
      "--issue",
      "900",
      "--pr",
      "901",
      "--head",
      stale,
      ...opts,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.status, "rejected", JSON.stringify(r.out));
    assert.equal(gitIn(origin, ["rev-parse", "refs/heads/factory/issue-900"]), moved);
  });

  it("holds a bare version the merge base already mentions", () => {
    // The merge base's tree names 20261111000001 (main's docs), so a bare
    // 20261111000001 the PR adds could mean that one: a person decides.
    const base = gitIn(author, ["rev-parse", "main"]);
    const head = openPr(
      950,
      951,
      {
        [`supabase/migrations/20261111000001_quota_two.sql`]: "select 3;\n",
        "notes.md": "remember 20261111000001\n",
      },
      base,
    );
    const r = cli(factory, ["precheck", "--root", factory, "--pr", "951", "--head", head, ...opts]);
    assert.equal(r.out.status, "manual", JSON.stringify(r.out));
    assert.match(r.out.reason, /notes\.md:1 \(20261111000001\)/);
    assert.match(r.out.comment, /need a person to renumber them/);
  });

  it("holds SQL that redefines what main's newer migration defines", () => {
    const head = openPr(
      960,
      961,
      {
        [`supabase/migrations/20261101000001_redefine.sql`]:
          "create or replace function public.note_text_chars(content jsonb) returns int\n" +
          "language sql as $$ select 2 $$;\n",
      },
      gitIn(author, ["rev-parse", "main~1"]),
    );
    const r = cli(factory, ["precheck", "--root", factory, "--pr", "961", "--head", head, ...opts]);
    assert.equal(r.out.status, "manual");
    assert.match(r.out.reason, /function public\.note_text_chars/);
  });

  it("reports an unreachable PR head instead of planning on nothing", () => {
    const r = cli(factory, [
      "precheck",
      "--root",
      factory,
      "--pr",
      "999",
      "--head",
      bHead,
      ...opts,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.status, "unreachable");
  });

  // The bash gate, end to end: the real migration_renumber_gate with only gh
  // (the GitHub API) stubbed. It renumbers #802 like the CLI above, records it,
  // asks GitHub to merge main in, and comments once.
  it("migration_renumber_gate renumbers #802 and records it", () => {
    const head = openPr(
      970,
      971,
      {
        [`supabase/migrations/20261111000001_gate.sql`]: "select 4;\n",
      },
      gitIn(author, ["rev-parse", "main~1"]),
    );
    const calls = join(dir, "gate-calls");
    const state = join(dir, "gate-state.json");
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    // The node helper looks other open PRs up with the gh binary.
    write(bin, "gh", '#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo "[]"; exit 0; fi\nexit 1\n');
    chmodSync(join(bin, "gh"), 0o755);
    const fns = ["migration_renumber_gate", "update_pr_branch"]
      .map((fn) => `eval "$(awk '/^${fn}\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${AGENT}")"`)
      .join("\n");
    const snippet = `
set -euo pipefail
CALLS="${calls}"; : >"$CALLS"
LOG_FILE="${join(dir, "gate-log")}"
STATE_FILE="${state}"
SCRIPT_DIR="${SCRIPTS}"
REPO_ROOT="${factory}"
DRY_RUN=0
FACTORY_MAX_MIGRATION_RENUMBERS=3
log() { echo "LOG $*" >>"$CALLS"; }
worktree_within_head() { return 0; }
issue_has_marker() { return 1; }
gh() {
  case "$1 $2" in
    "pr diff") printf 'supabase/migrations/20261111000001_gate.sql\\n' ;;
    "issue comment") echo "COMMENT $3 $(printf '%s' "$*" | grep -o 'drafto-factory-migration-renumber:[0-9a-f]*')" >>"$CALLS" ;;
    "api --method") echo "UPDATE $*" >>"$CALLS" ;;
  esac
}
${fns}
migration_renumber_gate 970 971 ${head} "Approved" || echo "RC=$? RESULT=$MIGRATION_RENUMBER_RESULT"
`;
    const r = spawnSync("bash", ["-c", snippet], {
      encoding: "utf8",
      env: cleanEnv({ PATH: `${bin}:${process.env.PATH}` }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RC=1 RESULT=renumbered/);
    const to = gitIn(origin, ["rev-parse", "refs/heads/factory/issue-970"]);
    assert.notEqual(to, head);
    const out = readFileSync(calls, "utf8");
    assert.match(
      out,
      new RegExp(
        `UPDATE api --method PUT repos/JakubAnderwald/drafto/pulls/971/update-branch -f expected_head_sha=${to}`,
      ),
    );
    assert.match(
      out,
      new RegExp(`COMMENT 970 drafto-factory-migration-renumber:${to.slice(0, 12)}`),
    );
    const issue = JSON.parse(readFileSync(state, "utf8")).issues["970"];
    assert.equal(issue.renumberFrom, head);
    assert.equal(issue.renumberTo, to);
    // The gate plans with the real date, so only the shape is fixed here.
    const map = JSON.parse(issue.renumberMap);
    assert.deepEqual(Object.keys(map), ["20261111000001_gate.sql"]);
    assert.match(map["20261111000001_gate.sql"], /^\d{14}_gate\.sql$/);
    assert.ok(map["20261111000001_gate.sql"] > "20261111000001_gate.sql");
    assert.equal(issue.migrationRenumbers, "1");
  });
});

// The gate's other outcomes, with the helper and GitHub stubbed.
describe("migration_renumber_gate (stubbed)", () => {
  const H = "f".repeat(40);
  const R = "d".repeat(40);
  const MAP = { [QUOTA]: "20261113000001_storage_quota.sql" };
  function gate({
    files = `supabase/migrations/${QUOTA}\napps/web/x.ts`,
    precheck = { status: "fixable", map: MAP },
    apply = { status: "pushed", to: R, map: MAP, comment: "RENUMBERED" },
    count = "0",
    max = 3,
    dry = 0,
    within = 0,
    preFails = 0,
    marker = 1,
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "renumber-gate-"));
    const q = (o) => JSON.stringify(o).replaceAll("'", "'\\''");
    const snippet = `
set -euo pipefail
CALLS="${dir}/calls"; : >"$CALLS"
LOG_FILE="${dir}/log"; STATE_FILE="${dir}/state.json"
SCRIPT_DIR=/factory/scripts; REPO_ROOT=/factory
DRY_RUN=${dry}; FACTORY_MAX_MIGRATION_RENUMBERS=${max}
log() { echo "LOG $*" >>"$CALLS"; }
worktree_within_head() { return ${within}; }
issue_has_marker() { echo "MARKER? $2" >>"$CALLS"; return ${marker}; }
update_pr_branch() { echo "UPDATE $*" >>"$CALLS"; }
node() {
  case "$2" in
    precheck) echo "PRECHECK $*" >>"$CALLS"; [[ ${preFails} -eq 0 ]] || return 1; echo '${q(precheck)}' ;;
    apply) echo "APPLY $*" >>"$CALLS"; echo '${q(apply)}' ;;
    factory:get-issue) echo '{"migrationRenumbers":"${count}"}' ;;
    factory:set-issue-field) echo "SET $4 $5" >>"$CALLS" ;;
  esac
}
gh() {
  case "$1 $2" in
    "pr diff") printf '%s\\n' '${files}' ;;
    "issue comment") echo "COMMENT $(printf '%s' "$*" | tr '\\n' ' ')" >>"$CALLS" ;;
  esac
}
eval "$(awk '/^migration_renumber_gate\\(\\)/{f=1} f{print} f&&/^}/{exit}' "${AGENT}")"
if migration_renumber_gate 794 802 ${H} "Approved"; then rc=0; else rc=$?; fi
echo "RC=$rc RESULT=$MIGRATION_RENUMBER_RESULT"
echo "---"
cat "$CALLS"
`;
    try {
      const r = spawnSync("bash", ["-c", snippet], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      const [out, calls] = r.stdout.split("---\n");
      return { out: out.trim(), calls: calls.trim().split("\n").filter(Boolean) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("goes on at once for a PR without migrations, without running the helper", () => {
    const r = gate({ files: "apps/web/x.ts\nsupabase/config.toml" });
    assert.equal(r.out, "RC=0 RESULT=clean");
    assert.deepEqual(r.calls, []);
  });

  it("goes on when the precheck finds nothing to renumber", () => {
    const r = gate({ precheck: { status: "clean" } });
    assert.equal(r.out, "RC=0 RESULT=clean");
    assert.ok(!r.calls.some((c) => c.startsWith("APPLY") || c.startsWith("SET")));
  });

  it("renumbers: counts it first, records R, updates the branch onto R, comments once", () => {
    const r = gate();
    assert.equal(r.out, "RC=1 RESULT=renumbered");
    const sets = r.calls.filter((c) => c.startsWith("SET"));
    assert.deepEqual(sets, [
      "SET migrationRenumbers 1",
      `SET renumberFrom ${H}`,
      `SET renumberTo ${R}`,
      `SET renumberMap ${JSON.stringify(MAP)}`,
    ]);
    const applyAt = r.calls.findIndex((c) => c.startsWith("APPLY"));
    assert.ok(r.calls.indexOf("SET migrationRenumbers 1") < applyAt);
    assert.match(
      r.calls[applyAt],
      /apply --root \/factory --issue 794 --pr 802 --head f{40} --where Approved/,
    );
    assert.ok(r.calls.includes(`UPDATE 802 ${R}`));
    assert.ok(r.calls.includes(`MARKER? drafto-factory-migration-renumber:${R.slice(0, 12)}`));
    assert.ok(
      r.calls.some((c) =>
        c.startsWith(
          `COMMENT issue comment 794 --repo JakubAnderwald/drafto --body RENUMBERED  <!-- drafto-factory-migration-renumber:${R.slice(0, 12)} -->`,
        ),
      ),
    );
    assert.ok(!r.calls.some((c) => /bump-attempts|branchUpdates|ciRerun/.test(c)));
  });

  it("doesn't comment twice on the same R", () => {
    const r = gate({ marker: 0 });
    assert.equal(r.out, "RC=1 RESULT=renumbered");
    assert.ok(!r.calls.some((c) => c.startsWith("COMMENT")));
  });

  it("holds a plan that needs a person, commenting once per head", () => {
    const r = gate({ precheck: { status: "manual", reason: "overlap", comment: "HOLD" } });
    assert.equal(r.out, "RC=1 RESULT=manual");
    assert.ok(
      r.calls.includes(`MARKER? drafto-factory-migration-renumber-manual:${H.slice(0, 12)}`),
    );
    assert.ok(r.calls.some((c) => c.startsWith("COMMENT") && c.includes("HOLD")));
    assert.ok(!r.calls.some((c) => c.startsWith("APPLY") || c.startsWith("SET")));
  });

  it("holds with a comment once the cap is spent, and fails closed on an unreadable count", () => {
    for (const count of ["3", "garbage"]) {
      const r = gate({ count });
      assert.equal(r.out, "RC=1 RESULT=capped", count);
      assert.ok(r.calls.some((c) => c.includes("drafto-factory-migration-renumber-cap:")));
      assert.ok(!r.calls.some((c) => c.startsWith("APPLY")), count);
    }
  });

  it("won't renumber past commits the worktree has and the PR lacks", () => {
    const r = gate({ within: 1 });
    assert.equal(r.out, "RC=1 RESULT=error");
    assert.ok(!r.calls.some((c) => c.startsWith("APPLY") || c.startsWith("SET")));
  });

  it("gives the count back when the push is rejected", () => {
    const r = gate({ apply: { status: "rejected", reason: "moved" } });
    assert.equal(r.out, "RC=1 RESULT=error");
    assert.deepEqual(
      r.calls.filter((c) => c.startsWith("SET")),
      ["SET migrationRenumbers 1", "SET migrationRenumbers 0"],
    );
    assert.ok(!r.calls.some((c) => c.startsWith("UPDATE")));
  });

  it("only logs in a dry run", () => {
    const r = gate({ dry: 1 });
    assert.equal(r.out, "RC=1 RESULT=renumbered");
    assert.ok(
      r.calls.some((c) => c.startsWith("LOG DRY-RUN: would renumber PR #802's migrations")),
    );
    assert.ok(!r.calls.some((c) => /^(APPLY|SET|UPDATE|COMMENT)/.test(c)));
  });

  it("reports an error when the precheck can't run", () => {
    const r = gate({ preFails: 1 });
    assert.equal(r.out, "RC=1 RESULT=error");
  });
});
