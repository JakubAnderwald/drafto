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
  claimedCheck,
  claimedVersions,
  liveClaims,
  makeRewriter,
  manualComment,
  mergedMigrationNames,
  objectOverlap,
  objectsTouched,
  olderClaims,
  ownPrNumbers,
  planRenumber,
  pushRenumber,
  renumberComment,
  rewriteLines,
  stripSql,
  verifyRenumber,
  writeRenumberCommit,
} from "../lib/migration-renumber.mjs";

// ADR-0077. PRs #802 (storage quota) and #829 (product metrics) both added
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

  // ADR-0079: the implement post-check, before either PR merged.
  it("moves a fresh migration off an older open PR's version, only when asked", () => {
    const mine = "20261113000001_mine.sql";
    const args = { mbNames: [BASE], headNames: [BASE, mine], mainNames: [BASE] };
    const older = [{ pr: 829, file: "20261113000001_theirs.sql" }];
    assert.equal(plan({ ...args, extraTaken: older }).status, "clean", "no moveOff, no move");
    const r = plan({ ...args, extraTaken: older, moveOff: older });
    assert.equal(r.status, "fixable");
    assert.deepEqual(r.map, { [mine]: "20261113000002_mine.sql" });
    assert.equal(r.findings[0].reason, "claimed");
    assert.deepEqual(r.findings[0].prs, [829]);
  });
});

describe("olderClaims", () => {
  it("keeps only claims of open PRs numbered below this one", () => {
    const claimed = [
      { pr: 829, file: "a.sql" },
      { pr: 835, file: "b.sql" },
      { pr: 840, file: "c.sql" },
      "20261113000001",
      { file: "no-pr.sql" },
    ];
    assert.deepEqual(olderClaims(claimed, 835), [{ pr: 829, file: "a.sql" }]);
    assert.deepEqual(olderClaims(claimed, "841"), claimed.slice(0, 3));
    assert.deepEqual(olderClaims(null, 835), []);
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

  it("reads an E'' string's backslash escapes, so the next statement still counts", () => {
    const sql = String.raw`
      comment on function public.bar() is E'don\'t \\ stop';
      create or replace function public.foo() returns int language sql as $$ select 1 $$;
      select e'it\'s', 'plain\';
      create table public.after_e (id int);
    `;
    assert.deepEqual(objectsTouched(sql), ["function public.foo", "table public.after_e"]);
    // An identifier that ends in e before a quote doesn't start an escape string.
    assert.equal(stripSql(String.raw`select some'a\';`), "select some'';");
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
  const JQ = ".[] | [.status, .filename] | @tsv";

  it("lists other open PRs' added migrations from the paginated files endpoint", () => {
    const calls = [];
    const gh = (args) => {
      calls.push(args.join(" "));
      if (args[1] === "list") return JSON.stringify([{ number: 802 }, { number: 829 }]);
      return [
        "modified\tapps/web/x.ts",
        "added\tsupabase/migrations/20261111000001_note_text_chars.sql",
        "added\tsupabase/migrations/nested/20261111000002_x.sql",
        "added\tsupabase/migrations/seed.sql",
        "",
      ].join("\n");
    };
    assert.deepEqual(claimedVersions({ excludePr: 802, gh, warn: () => {} }), {
      claimed: [{ pr: 829, file: "20261111000001_note_text_chars.sql" }],
      skipped: [],
      checked: 1,
      total: 1,
      gaveUp: false,
    });
    assert.ok(
      calls.includes(`api --paginate repos/JakubAnderwald/drafto/pulls/829/files --jq ${JQ}`),
    );
    assert.ok(!calls.some((c) => c.includes("pulls/802/")));
    // gh pr diff fails with HTTP 406 on a huge diff; gh pr view --json files stops at 100.
    assert.ok(!calls.some((c) => c.startsWith("pr diff") || c.includes("--json files")));
  });

  // A PR that edits or deletes one of main's migrations doesn't take its version.
  it("counts only added files and a rename's new name as claims", () => {
    const gh = (args) => {
      if (args[1] === "list") return JSON.stringify([{ number: 829 }]);
      return [
        "added\tsupabase/migrations/20261113000001_added.sql",
        "renamed\tsupabase/migrations/20261113000002_renamed.sql",
        "modified\tsupabase/migrations/20261020000001_edited.sql",
        "removed\tsupabase/migrations/20261020000002_removed.sql",
        "copied\tsupabase/migrations/20261113000003_copied.sql",
        "changed\tsupabase/migrations/20261113000004_mode.sql",
      ].join("\n");
    };
    assert.deepEqual(
      claimedVersions({ gh, warn: () => {} }).claimed.map((c) => c.file),
      ["20261113000001_added.sql", "20261113000002_renamed.sql"],
    );
  });

  it("skips a PR whose files can't be listed, instead of failing the sweep", () => {
    const warnings = [];
    const gh = (args) => {
      if (args[1] === "list") return JSON.stringify([{ number: 801 }, { number: 829 }]);
      if (args[2].includes("/801/")) throw new Error("gh api failed: HTTP 502");
      return "added\tsupabase/migrations/20261111000001_note_text_chars.sql\n";
    };
    const r = claimedVersions({ excludePr: 802, gh, warn: (m) => warnings.push(m) });
    assert.deepEqual(r.claimed, [{ pr: 829, file: "20261111000001_note_text_chars.sql" }]);
    assert.deepEqual(r.skipped, [801]);
    assert.match(warnings.join("\n"), /couldn't list PR #801's files.*HTTP 502/);
  });

  it("still throws when the open PRs can't be listed at all", () => {
    const gh = () => {
      throw new Error("gh pr list failed");
    };
    assert.throws(() => claimedVersions({ excludePr: 802, gh }), /gh pr list failed/);
  });

  it("takes the open PRs from the caller instead of listing them", () => {
    const calls = [];
    const gh = (args) => {
      calls.push(args.join(" "));
      return "added\tsupabase/migrations/20261113000001_x.sql\n";
    };
    const r = claimedVersions({ prs: [{ number: 829 }], gh, warn: () => {} });
    assert.deepEqual(r.claimed, [{ pr: 829, file: "20261113000001_x.sql" }]);
    assert.ok(!calls.some((c) => c.startsWith("pr list")));
  });

  // The budget stops the sweep once: the PRs left aren't each a failure.
  it("stops reading PRs once the deadline passes", () => {
    let t = 0;
    const warnings = [];
    const gh = () => {
      t += 20;
      return "added\tsupabase/migrations/20261113000001_x.sql\n";
    };
    const r = claimedVersions({
      prs: [1, 2, 3, 4].map((number) => ({ number })),
      gh,
      warn: (m) => warnings.push(m),
      deadline: 30,
      now: () => t,
    });
    assert.deepEqual(
      { checked: r.checked, total: r.total, gaveUp: r.gaveUp, skipped: r.skipped },
      { checked: 2, total: 4, gaveUp: true, skipped: [] },
    );
    assert.deepEqual(warnings, []);
    // A call the budget cut short isn't counted against that PR either.
    t = 0;
    const cut = claimedVersions({
      prs: [{ number: 1 }, { number: 2 }],
      gh: () => {
        t = 99;
        throw new Error("gh ran out of time");
      },
      warn: (m) => warnings.push(m),
      deadline: 30,
      now: () => t,
    });
    assert.deepEqual([cut.checked, cut.skipped, cut.gaveUp], [0, [], true]);
    assert.deepEqual(warnings, []);
  });
});

describe("liveClaims", () => {
  it("keeps valid claims newer than main's newest", () => {
    const claimed = [
      { pr: 1, file: "20261111000001_old.sql" },
      { pr: 2, file: "20261112000002_same.sql" },
      { pr: 3, file: "20261113000001_new.sql" },
      { pr: 4, file: "9_short.sql" },
      { pr: 5 },
    ];
    assert.deepEqual(
      liveClaims(claimed, "20261112000002").map((c) => c.pr),
      [3],
    );
    assert.deepEqual(
      liveClaims(claimed, null).map((c) => c.pr),
      [1, 2, 3],
    );
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
    // Repairing dev leaves main's file at the old version unapplied there.
    assert.match(
      body,
      /After the repair, main's `20261111000001_note_text_chars\.sql` at `20261111000001` shows as not applied on dev, because dev never ran it, and `supabase db push --include-all` \(dev only\) applies it\./,
    );
    assert.match(body, /Prod needs nothing: it is pushed only from `main`, after the merge/);
    assert.doesNotMatch(body, /tbmjbxxseonkciqovnpl/);
  });

  // ADR-0079: the implement post-check's renumber says which open PR had the
  // version, not that main moved.
  it("says which older open PR already used the version", () => {
    const mine = "20261113000001_mine.sql";
    const body = renumberComment({
      pr: 835,
      to: "e".repeat(40),
      map: { [mine]: "20261113000002_mine.sql" },
      findings: [
        {
          reason: "claimed",
          file: mine,
          version: "20261113000001",
          others: ["20261113000001_theirs.sql"],
          prs: [829],
        },
      ],
    });
    assert.match(
      body,
      /^🏭 \*\*Renumbered PR #835's migrations: an older open PR already uses their version\.\*\*/,
    );
    assert.match(
      body,
      /- `20261113000001` was already used by open PR #829 \(`20261113000001_theirs\.sql`\)\./,
    );
    assert.match(body, /so the newer PR moves/);
    assert.doesNotMatch(body, /after `main` moved|update-branch merges/);
    assert.doesNotMatch(body, /past the ones `main` gained/);
    assert.match(body, /\| `20261113000001_mine\.sql` \| `20261113000002_mine\.sql` \|/);
    assert.match(body, /supabase migration repair --status reverted 20261113000001/);
  });

  // ADR-0079 (b): a migration the implement run added moved off a newer PR's version.
  it("says the run added it when the version was another open PR's", () => {
    const mine = "20261113000005_y.sql";
    const body = renumberComment({
      pr: 986,
      to: "e".repeat(40),
      map: { [mine]: "20261113000006_y.sql" },
      findings: [
        {
          reason: "claimed",
          file: mine,
          version: "20261113000005",
          others: ["20261113000005_newest.sql"],
          prs: [991],
          addedInRun: true,
        },
      ],
    });
    assert.match(
      body,
      /^🏭 \*\*Renumbered PR #986's migrations: another open PR already uses their version\.\*\*/,
    );
    assert.match(
      body,
      /- `20261113000005` was already used by open PR #991 \(`20261113000005_newest\.sql`\), and this implement run added it\./,
    );
    assert.match(body, /a migration an implement run adds moves off any open PR's version/);
    assert.doesNotMatch(body, /so the newer PR moves/);
  });

  // Not a hold: the card goes on to the fix loop's recipe, and from Approved
  // that costs a second approval, which the comment says so the person checks
  // the rename (above all an object overlap) before giving it.
  it("names the reason and the fix-loop fallback, and the re-approval from Approved", () => {
    const approved = manualComment({ pr: 802, reason: "it overlaps", where: "Approved" });
    assert.match(approved, /Reason: it overlaps\./);
    assert.match(approved, /The fix loop renumbers them instead/);
    assert.match(
      approved,
      /From \*\*Approved\*\* that means the card goes back to In Review and needs your approval again/,
    );
    assert.match(approved, /Check that rename before you approve it/);
    assert.doesNotMatch(approved, /Hold —|stays in/);
    const inReview = manualComment({ pr: 802, reason: "it overlaps", where: "In Review" });
    assert.doesNotMatch(inReview, /From \*\*Approved\*\*/);
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
    assert.match(r.out.comment, /the factory can't do it mechanically/);
    // Not a hold: the comment points at the fix loop's recipe, the fallback.
    assert.match(r.out.comment, /The fix loop renumbers them instead/);
    assert.doesNotMatch(r.out.comment, /Hold —|stays in/);
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

  // A gh on PATH for the CLI's open-PR sweep: `pr list` lists the PRs in
  // `prs`, `api … pulls/<n>/files` prints that PR's files as the files API's
  // `<status>\t<path>` (`added` unless the entry carries its own status),
  // anything else fails.
  function ghBin(name, prs) {
    const bin = join(dir, `bin-${name}`);
    mkdirSync(bin, { recursive: true });
    const list = JSON.stringify(Object.keys(prs).map((n) => ({ number: Number(n) })));
    const line = (f) => `'${f.includes("\t") ? f : `added\t${f}`}'`;
    const cases = Object.entries(prs)
      .map(([n, files]) => `  *pulls/${n}/files*) printf '%s\\n' ${files.map(line).join(" ")} ;;`)
      .join("\n");
    write(
      bin,
      "gh",
      `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo '${list}'; exit 0; fi\ncase "$*" in\n${cases}\n  *) exit 1 ;;\nesac\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    return { PATH: `${bin}:${process.env.PATH}` };
  }

  // ADR-0079: the implement bundle's versions, clear of main and every open PR.
  describe("next-version", () => {
    it("prints main's newest and the versions no open PR uses, in order", () => {
      const env = ghBin("next", {
        802: ["supabase/migrations/20261113000001_x.sql", "apps/web/a.ts"],
        901: ["supabase/migrations/20261113000002_y.sql"],
        // At or below main's newest: can't collide, so it's left out of `claimed`.
        903: ["supabase/migrations/20261101000001_old.sql"],
        // Edits one of main's migrations: not a claim.
        904: ["modified\tsupabase/migrations/20261113000004_edit.sql"],
      });
      const args = ["next-version", "--root", factory, "--today", "2026-11-13"];
      const r = cli(factory, args, env);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.out, {
        mainNewest: "20261111000001",
        ownNewest: null,
        versions: [
          "20261113000003",
          "20261113000004",
          "20261113000005",
          "20261113000006",
          "20261113000007",
        ],
        claimed: [
          { pr: 802, file: "20261113000001_x.sql" },
          { pr: 901, file: "20261113000002_y.sql" },
        ],
        skipped: [],
      });
    });

    // A revision: its own PR's migrations aren't claims, and the new ones sort after them.
    it("with --own-pr, starts after the PR's own newest migration and drops its claims", () => {
      const env = ghBin("own", {
        802: ["supabase/migrations/20261113000001_x.sql"],
        981: [
          "supabase/migrations/20261113000002_mine.sql",
          "supabase/migrations/20261113000004_mine2.sql",
        ],
        990: ["supabase/migrations/20261113000006_newer.sql"],
      });
      const r = cli(
        factory,
        ["next-version", "--root", factory, "--today", "2026-11-13", "--own-pr", "981"],
        env,
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.out.ownNewest, "20261113000004");
      assert.deepEqual(r.out.versions, [
        "20261113000005",
        "20261113000007",
        "20261113000008",
        "20261113000009",
        "20261113000010",
      ]);
      assert.deepEqual(
        r.out.claimed.map((c) => c.pr),
        [802, 990],
      );
    });

    it("fails when --own-pr's files can't be listed: its newest is part of the floor", () => {
      const env = ghBin("ownfail", { 802: ["supabase/migrations/20261113000001_x.sql"] });
      // gh has no case for PR 981's files, so listing them fails.
      const bin = env.PATH.split(":")[0];
      write(
        bin,
        "gh",
        readFileSync(join(bin, "gh"), "utf8").replace(
          `echo '[{"number":802}]'`,
          `echo '[{"number":802},{"number":981}]'`,
        ),
      );
      const r = cli(factory, ["next-version", "--root", factory, "--own-pr", "981"], env);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /couldn't list PR #981's files/);
      // Without --own-pr the same failure only skips that PR.
      const plain = cli(factory, ["next-version", "--root", factory], env);
      assert.equal(plain.status, 0, plain.stderr);
      assert.deepEqual(plain.out.skipped, [981]);
    });

    it("is today's first slots with no open PRs", () => {
      const r = cli(
        factory,
        ["next-version", "--root", factory, "--today", "2026-11-13"],
        ghBin("none", {}),
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.out.versions[0], "20261113000001");
      assert.equal(r.out.versions.length, 5);
      assert.deepEqual(r.out.claimed, []);
    });

    it("fails when the open PRs can't be listed, so the bundle falls back to null", () => {
      const bin = join(dir, "bin-down");
      mkdirSync(bin, { recursive: true });
      write(bin, "gh", "#!/bin/sh\necho 'HTTP 502' >&2\nexit 1\n");
      chmodSync(join(bin, "gh"), 0o755);
      const down = cli(factory, ["next-version", "--root", factory], {
        PATH: `${bin}:${process.env.PATH}`,
      });
      assert.equal(down.status, 1);
      assert.equal(down.out, null);
      assert.match(down.stderr, /"error":"gh pr list failed/);
    });
  });

  // ADR-0079: the implement post-check moves the newer PR off an older open
  // PR's version, before either merged. Main hasn't moved, so nothing else would.
  describe("--move-off-claimed", () => {
    const MINE = "20261113000001_mine.sql";
    const older = [{ pr: 975, file: "20261113000001_older.sql" }];
    let head;
    before(() => {
      head = openPr(980, 981, {
        [`supabase/migrations/${MINE}`]: "select 5;\n",
        "docs/mine.md": "Adds 20261113000001_mine.\n",
      });
    });
    const precheck = (...extra) =>
      cli(factory, [
        "precheck",
        "--root",
        factory,
        "--pr",
        "981",
        "--head",
        head,
        "--today",
        "2026-11-13",
        ...extra,
      ]);

    it("moves this PR off an older open PR's version, and only when asked", () => {
      const asked = precheck("--claimed-json", JSON.stringify(older), "--move-off-claimed", "1");
      assert.equal(asked.status, 0, asked.stderr);
      assert.equal(asked.out.status, "fixable", asked.out.reason);
      assert.deepEqual(asked.out.map, { [MINE]: "20261113000002_mine.sql" });
      assert.equal(asked.out.findings[0].reason, "claimed");
      // --watch and --release don't ask: the same claims leave it alone.
      const notAsked = precheck("--claimed-json", JSON.stringify(older));
      assert.equal(notAsked.out.status, "clean");
      const off = precheck("--claimed-json", JSON.stringify(older), "--move-off-claimed", "0");
      assert.equal(off.out.status, "clean");
    });

    it("never moves this PR off a newer PR's version: that one moves instead", () => {
      const newer = [{ pr: 990, file: "20261113000001_newer.sql" }];
      const r = precheck("--claimed-json", JSON.stringify(newer), "--move-off-claimed", "1");
      assert.equal(r.out.status, "clean");
    });

    it("sweeps the open PRs itself before planning, skipping every claimed version", () => {
      const env = ghBin("move", {
        975: [`supabase/migrations/${older[0].file}`],
        981: [`supabase/migrations/${MINE}`],
        990: ["supabase/migrations/20261113000002_newer.sql"],
      });
      const r = cli(
        factory,
        [
          "precheck",
          "--root",
          factory,
          "--pr",
          "981",
          "--head",
          head,
          "--today",
          "2026-11-13",
          "--move-off-claimed",
          "1",
        ],
        env,
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.out.status, "fixable", r.out.reason);
      assert.deepEqual(r.out.map, { [MINE]: "20261113000003_mine.sql" });
      assert.deepEqual(r.out.claimed, [
        { pr: 975, file: older[0].file },
        { pr: 990, file: "20261113000002_newer.sql" },
      ]);
    });

    it("rejects a value other than 1 or 0", () => {
      const r = precheck("--claimed-json", "[]", "--move-off-claimed", "yes");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /--move-off-claimed takes 1 or 0/);
    });

    it("never counts this PR's own files as a claim against it", () => {
      const own = [{ pr: 981, file: MINE }];
      const r = precheck("--claimed-json", JSON.stringify(own), "--move-off-claimed", "1");
      assert.equal(r.out.status, "clean", r.out.reason);
      assert.deepEqual(r.out.claimed, []);
    });

    it("apply pushes the proven rename, with a comment naming the older PR", () => {
      const r = cli(factory, [
        "apply",
        "--root",
        factory,
        "--issue",
        "980",
        "--pr",
        "981",
        "--head",
        head,
        "--today",
        "2026-11-13",
        "--claimed-json",
        JSON.stringify(older),
        "--move-off-claimed",
        "1",
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.out.status, "pushed", r.out.reason);
      const to = r.out.to;
      assert.equal(gitIn(origin, ["rev-parse", "refs/heads/factory/issue-980"]), to);
      assert.equal(
        gitIn(factory, ["log", "-1", "--format=%s", to]),
        "chore(migrations): renumber this PR's migrations off an older open PR's versions",
      );
      assert.equal(gitIn(factory, ["show", `${to}:docs/mine.md`]), "Adds 20261113000002_mine.");
      assert.match(r.out.comment, /already uses their version/);
      assert.match(r.out.comment, /`20261113000001` was already used by open PR #975/);
      const map = { [MINE]: "20261113000002_mine.sql" };
      assert.deepEqual(verifyRenumber({ cwd: factory, from: head, to, map }), {
        ok: true,
        reasons: [],
      });
    });
  });

  // ADR-0079 (b): a migration the implement run added moves off ANY open
  // PR's version, even a newer PR's; one the PR already had doesn't.
  describe("--new-since", () => {
    const KEPT = "20261113000004_kept.sql";
    const ADDED = "20261113000005_added.sql";
    // Both are newer than #986, so the lower-number rule alone moves neither.
    const newer = [
      { pr: 990, file: "20261113000004_newer.sql" },
      { pr: 991, file: "20261113000005_newest.sql" },
    ];
    let pre;
    let head;
    before(() => {
      // #986's head before the run has KEPT; the run's commit adds ADDED.
      pre = openPr(985, 986, { [`supabase/migrations/${KEPT}`]: "select 6;\n" });
      gitIn(author, ["checkout", "-q", "issue-985"]);
      write(author, `supabase/migrations/${ADDED}`, "select 7;\n");
      head = commit(author, "the run");
      gitIn(author, [
        "push",
        "-q",
        "-f",
        "origin",
        "HEAD:refs/heads/factory/issue-985",
        "HEAD:refs/pull/986/head",
      ]);
      gitIn(author, ["checkout", "-q", "main"]);
    });
    const run = (...extra) =>
      cli(factory, [
        "precheck",
        "--root",
        factory,
        "--pr",
        "986",
        "--head",
        head,
        "--today",
        "2026-11-13",
        "--claimed-json",
        JSON.stringify(newer),
        "--move-off-claimed",
        "1",
        ...extra,
      ]);

    it("moves the run's migration off a newer PR's version, and leaves the older one", () => {
      const r = run("--new-since", pre);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.out.status, "fixable", r.out.reason);
      assert.deepEqual(r.out.map, { [ADDED]: "20261113000006_added.sql" });
      assert.equal(r.out.findings[0].reason, "claimed");
      assert.equal(r.out.findings[0].addedInRun, true);
      assert.deepEqual(r.out.findings[0].prs, [991]);
    });

    it("leaves both alone without it, as --watch and --release run", () => {
      assert.equal(run().out.status, "clean");
    });

    it("moves every migration of a brand-new PR (`all`)", () => {
      const r = run("--new-since", "all");
      assert.equal(r.out.status, "fixable", r.out.reason);
      // Main's newest is 20261111000001, so today's first free slots.
      assert.deepEqual(r.out.map, {
        [KEPT]: "20261113000001_kept.sql",
        [ADDED]: "20261113000002_added.sql",
      });
    });

    it("falls back to the lower-number rule when the old head isn't in the repo", () => {
      const r = run("--new-since", "abcdef1234567");
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.out.status, "clean");
      assert.match(r.stderr, /abcdef1234567 isn't in the local repo/);
    });

    it("is refused without --move-off-claimed 1, and with a bad value", () => {
      const bare = cli(factory, [
        "precheck",
        "--root",
        factory,
        "--pr",
        "986",
        "--head",
        head,
        "--claimed-json",
        "[]",
        "--new-since",
        pre,
      ]);
      assert.equal(bare.status, 1);
      assert.match(bare.stderr, /--new-since needs --move-off-claimed 1/);
      const bad = run("--new-since", "yesterday");
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /--new-since is required/);
    });

    it("apply pushes the rename with a comment that says the run added it", () => {
      const r = cli(factory, [
        "apply",
        "--root",
        factory,
        "--issue",
        "985",
        "--pr",
        "986",
        "--head",
        head,
        "--today",
        "2026-11-13",
        "--claimed-json",
        JSON.stringify(newer),
        "--move-off-claimed",
        "1",
        "--new-since",
        pre,
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.out.status, "pushed", r.out.reason);
      assert.equal(
        gitIn(factory, ["log", "-1", "--format=%s", r.out.to]),
        "chore(migrations): renumber this PR's migrations off other open PRs' versions",
      );
      assert.match(r.out.comment, /and this implement run added it/);
      assert.deepEqual(
        verifyRenumber({
          cwd: factory,
          from: head,
          to: r.out.to,
          map: { [ADDED]: "20261113000006_added.sql" },
        }),
        { ok: true, reasons: [] },
      );
    });
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
    const fns = ["migration_renumber_gate", "update_pr_branch", "pr_head_oid"]
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
    "pr view") echo "VIEW $*" >>"$CALLS"; git --git-dir="${origin}" rev-parse refs/heads/factory/issue-970 ;;
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
    // It read the PR head back as R before asking for the update.
    assert.ok(out.indexOf("VIEW pr view 971") < out.indexOf("UPDATE "));
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
    headAfter = 1,
    mode = "",
    claimedJson = "",
    newSince = "",
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
sleep() { echo "SLEEP $*" >>"$CALLS"; }
# GitHub shows R as the PR head from read number <headAfter> on.
pr_head_oid() {
  echo "HEADOID $1" >>"$CALLS"
  if [[ $(grep -c '^HEADOID' "$CALLS") -ge ${headAfter} ]]; then echo "${R}"; else echo "${H}"; fi
}
node() {
  case "$2" in
    precheck) echo "PRECHECK $*" >>"$CALLS"; [[ ${preFails} -eq 0 ]] || return 1; echo '${q(precheck)}' ;;
    apply) echo "APPLY $*" >>"$CALLS"; echo '${q(apply)}' ;;
    factory:get-issue) echo "GETCOUNT" >>"$CALLS"; echo '{"migrationRenumbers":"${count}"}' ;;
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
if migration_renumber_gate 794 802 ${H} "Approved" ${mode || claimedJson || newSince ? `"" '${mode}' '${claimedJson.replaceAll("'", "'\\''")}' '${newSince}'` : ""}; then rc=0; else rc=$?; fi
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
    assert.ok(r.calls.indexOf("HEADOID 802") < r.calls.indexOf(`UPDATE 802 ${R}`));
    assert.ok(!r.calls.some((c) => c.startsWith("SLEEP")), "R showed at once");
    assert.doesNotMatch(r.calls[applyAt], /--claimed-json/, "precheck gave no list");
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

  // One sweep of the other open PRs per renumber: apply plans with precheck's.
  it("hands apply the versions precheck found other open PRs using", () => {
    const claimed = [{ pr: 829, file: "20261111000001_note_text_chars.sql" }];
    const r = gate({ precheck: { status: "fixable", map: MAP, claimed } });
    assert.equal(r.out, "RC=1 RESULT=renumbered");
    const apply = r.calls.find((c) => c.startsWith("APPLY"));
    assert.ok(apply.endsWith(`--where Approved --claimed-json ${JSON.stringify(claimed)}`), apply);
    const none = gate({ precheck: { status: "fixable", map: MAP, claimed: null } });
    assert.doesNotMatch(
      none.calls.find((c) => c.startsWith("APPLY")),
      /--claimed-json/,
    );
  });

  // update-branch expects R as the head, and GitHub shows it a moment after the push.
  it("waits for GitHub to show R as the head before updating the branch", () => {
    const late = gate({ headAfter: 3 });
    assert.equal(late.out, "RC=1 RESULT=renumbered");
    assert.deepEqual(
      late.calls.filter((c) => /^(HEADOID|SLEEP|UPDATE)/.test(c)),
      ["HEADOID 802", "SLEEP 2", "HEADOID 802", "SLEEP 2", "HEADOID 802", `UPDATE 802 ${R}`],
    );
    const never = gate({ headAfter: 99 });
    assert.equal(never.out, "RC=1 RESULT=renumbered");
    assert.equal(never.calls.filter((c) => c.startsWith("HEADOID")).length, 5);
    assert.equal(never.calls.filter((c) => c.startsWith("SLEEP")).length, 4);
    assert.ok(!never.calls.some((c) => c.startsWith("UPDATE")));
    assert.ok(
      never.calls.some((c) =>
        /doesn't show it as the PR head yet, so a later tick updates/.test(c),
      ),
    );
    // The renumber is still recorded and commented on: the head is R either way.
    assert.ok(never.calls.includes(`SET renumberTo ${R}`));
    assert.ok(never.calls.some((c) => c.startsWith("COMMENT")));
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
    assert.ok(!r.calls.some((c) => /^(APPLY|SET|UPDATE|COMMENT|HEADOID|SLEEP)/.test(c)));
  });

  it("reports an error when the precheck can't run", () => {
    const r = gate({ preFails: 1 });
    assert.equal(r.out, "RC=1 RESULT=error");
  });

  // ADR-0079: only the implement post-check passes "claimed".
  describe("claimed mode (the implement post-check)", () => {
    it("asks precheck and apply to move off older PRs' versions; the default never does", () => {
      const r = gate({ mode: "claimed" });
      assert.equal(r.out, "RC=1 RESULT=renumbered");
      const pre = r.calls.find((c) => c.startsWith("PRECHECK"));
      const apply = r.calls.find((c) => c.startsWith("APPLY"));
      assert.ok(pre.endsWith("--where Approved --move-off-claimed 1"), pre);
      assert.ok(apply.endsWith("--where Approved --move-off-claimed 1"), apply);
      // The renumber is recorded and commented like any other.
      assert.ok(r.calls.includes(`SET renumberTo ${R}`));
      assert.ok(r.calls.some((c) => c.startsWith("COMMENT") && c.includes("RENUMBERED")));
      const plain = gate();
      assert.ok(!plain.calls.some((c) => c.includes("--move-off-claimed")));
    });

    it("puts precheck's claims before the flag on apply", () => {
      const claimed = [{ pr: 829, file: "20261111000001_note_text_chars.sql" }];
      const r = gate({ mode: "claimed", precheck: { status: "fixable", map: MAP, claimed } });
      const apply = r.calls.find((c) => c.startsWith("APPLY"));
      assert.ok(
        apply.endsWith(`--claimed-json ${JSON.stringify(claimed)} --move-off-claimed 1`),
        apply,
      );
    });

    // The bundle's claims spare precheck a second sweep of the open PRs.
    it("hands precheck the given claims, and both the head before the run", () => {
      const claimedJson = JSON.stringify([{ pr: 829, file: "20261111000001_note_text_chars.sql" }]);
      const since = "e".repeat(40);
      const r = gate({ mode: "claimed", claimedJson, newSince: since });
      const pre = r.calls.find((c) => c.startsWith("PRECHECK"));
      const apply = r.calls.find((c) => c.startsWith("APPLY"));
      assert.ok(
        pre.endsWith(
          `--where Approved --claimed-json ${claimedJson} --move-off-claimed 1 --new-since ${since}`,
        ),
        pre,
      );
      assert.ok(apply.endsWith(`--move-off-claimed 1 --new-since ${since}`), apply);
      // An empty list is still a list: no sweep.
      const none = gate({ mode: "claimed", claimedJson: "[]", newSince: "all" });
      assert.ok(
        none.calls
          .find((c) => c.startsWith("PRECHECK"))
          .endsWith("--claimed-json [] --move-off-claimed 1 --new-since all"),
      );
      // No claims given: precheck sweeps them itself.
      const sweep = gate({ mode: "claimed", newSince: "all" });
      assert.doesNotMatch(
        sweep.calls.find((c) => c.startsWith("PRECHECK")),
        /--claimed-json/,
      );
      // Outside claimed mode both are ignored (--watch and --release pass neither).
      const plain = gate({ claimedJson, newSince: since });
      assert.doesNotMatch(
        plain.calls.find((c) => c.startsWith("PRECHECK")),
        /--claimed-json|--new-since/,
      );
    });

    // Bounded by one post-check per implement run; the merge-time budget stays whole.
    it("neither reads nor spends migrationRenumbers", () => {
      for (const count of ["0", "3", "garbage"]) {
        const r = gate({ mode: "claimed", count });
        assert.equal(r.out, "RC=1 RESULT=renumbered", count);
        assert.ok(!r.calls.includes("GETCOUNT"), count);
        assert.ok(!r.calls.some((c) => c.startsWith("SET migrationRenumbers")), count);
        assert.ok(!r.calls.some((c) => c.includes("renumber-cap")), count);
      }
      const rejected = gate({ mode: "claimed", apply: { status: "rejected", reason: "moved" } });
      assert.equal(rejected.out, "RC=1 RESULT=error");
      assert.ok(!rejected.calls.some((c) => c.startsWith("SET migrationRenumbers")));
      // The merge-time gate still counts.
      assert.ok(gate().calls.includes("GETCOUNT"));
    });

    // Its comment describes the red-CI fallback; nothing is red at implement.
    it("only logs a plan that needs a person", () => {
      const manual = gate({
        mode: "claimed",
        precheck: { status: "manual", reason: "overlap", comment: "HOLD" },
      });
      assert.equal(manual.out, "RC=1 RESULT=manual");
      assert.ok(!manual.calls.some((c) => c.startsWith("COMMENT") || c.startsWith("MARKER?")));
      const applyManual = gate({
        mode: "claimed",
        apply: { status: "manual", reason: "overlap", comment: "HOLD" },
      });
      assert.equal(applyManual.out, "RC=1 RESULT=manual");
      assert.ok(!applyManual.calls.some((c) => c.startsWith("COMMENT")));
    });
  });
});

// Only the implement post-check may move a PR off another open PR's version:
// at --watch or --release the older PR would move too (ADR-0079).
describe("migration_renumber_gate call sites", () => {
  const script = readFileSync(AGENT, "utf8");
  it("pass the claimed mode from implement_migration_claim_check alone", () => {
    const calls = script
      .split("\n")
      .filter((l) => /^\s+(?:&& ! |if ! )?migration_renumber_gate /.test(l));
    assert.ok(calls.length >= 4, `found ${calls.length} call sites`);
    const claimed = calls.filter((l) => /\bclaimed\b/.test(l));
    assert.deepEqual(claimed, [
      '  migration_renumber_gate "$issue_num" "$pr_num" "$head_sha" "In Progress" "" claimed \\',
    ]);
  });
});

// `pnpm migration:check`'s open-PR warning (ADR-0079), with gh injected.
describe("claimedCheck", () => {
  const MINE = "20261113000001_mine.sql";
  let repo;
  let sha;
  before(() => {
    repo = mkdtempSync(join(tmpdir(), "claimed-check-"));
    gitIn(repo, ["init", "-q", "-b", "main"]);
    gitIn(repo, ["config", "user.email", "t@example.com"]);
    gitIn(repo, ["config", "user.name", "T"]);
    gitIn(repo, ["config", "commit.gpgsign", "false"]);
    write(repo, `supabase/migrations/${BASE}`, "select 1;\n");
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["commit", "-q", "--no-verify", "-m", "base"]);
    gitIn(repo, ["checkout", "-q", "-b", "feature"]);
    sha = gitIn(repo, ["rev-parse", "HEAD"]);
    // Added on this branch, uncommitted: the check reads the working tree.
    write(repo, `supabase/migrations/${MINE}`, "select 2;\n");
    write(repo, "supabase/migrations/20261113000002_alone.sql", "select 3;\n");
  });
  after(() => repo && rmSync(repo, { recursive: true, force: true }));

  // gh as the check calls it. `prs` is what `gh pr list` returns; `files` maps
  // a PR number to its file paths (all `added`), or null for a failing list.
  function fakeGh({ auth = true, listError, prs, files = {} } = {}) {
    const calls = [];
    const list = prs ?? Object.keys(files).map((n) => ({ number: Number(n) }));
    const gh = (args) => {
      calls.push(args.join(" "));
      if (args[0] === "auth") {
        if (!auth) throw new Error("gh auth status failed: not logged in");
        return "";
      }
      if (args[0] === "pr" && args[1] === "list") {
        if (listError) throw new Error("gh pr list failed: HTTP 502");
        return JSON.stringify(list);
      }
      if (args[0] === "pr") throw new Error(`unexpected gh ${args.join(" ")}`);
      const n = /pulls\/(\d+)\/files/.exec(args[2] ?? "")?.[1];
      if (files[n] === null) throw new Error("gh api failed: HTTP 500");
      return (files[n] ?? []).map((f) => `added\t${f}`).join("\n");
    };
    return { gh, calls };
  }
  const run = (opts, extra = {}) => {
    const { gh, calls } = fakeGh(opts);
    return { lines: claimedCheck({ root: repo, base: "main" }, { gh, ...extra }), calls };
  };
  const FILES = {
    829: ["supabase/migrations/20261113000001_theirs.sql", "apps/web/x.ts"],
    835: [`supabase/migrations/${MINE}`],
    840: ["supabase/migrations/20261201000001_later.sql"],
  };
  const WARN_829 = `warn\tsupabase/migrations/${MINE}\tversion 20261113000001 is also added by open PR #829 (20261113000001_theirs.sql); the PR that merges second must renumber`;

  it("warns for each added migration another open PR adds, listing the open PRs once", () => {
    const { lines, calls } = run({
      prs: [
        { number: 829, headRefName: "other", headRefOid: "1".repeat(40) },
        { number: 835, headRefName: "feature", headRefOid: "2".repeat(40) },
        { number: 840, headRefName: "later", headRefOid: "3".repeat(40) },
      ],
      files: FILES,
    });
    assert.deepEqual(lines, [WARN_829]);
    assert.deepEqual(
      calls.filter((c) => c.startsWith("pr ")),
      [
        "pr list --repo JakubAnderwald/drafto --state open --json number,headRefName,headRefOid --limit 200",
      ],
    );
    // No `gh pr view`: the list says which PR is this checkout's.
    assert.ok(!calls.some((c) => c.startsWith("pr view")));
  });

  // This checkout's own PR: by its branch, or by its head commit when detached.
  it("leaves out this checkout's own PR, by branch name or by head commit", () => {
    const byBranch = run({
      prs: [
        { number: 829, headRefName: "other", headRefOid: "1".repeat(40) },
        { number: 835, headRefName: "feature", headRefOid: "2".repeat(40) },
      ],
      files: FILES,
    });
    assert.deepEqual(byBranch.lines, [WARN_829]);
    assert.ok(!byBranch.calls.some((c) => c.includes("pulls/835/")), "the own PR isn't read");

    gitIn(repo, ["checkout", "-q", "--detach"]);
    try {
      const bySha = run({
        prs: [
          { number: 829, headRefName: "other", headRefOid: "1".repeat(40) },
          { number: 835, headRefName: "feature", headRefOid: sha },
        ],
        files: FILES,
      });
      assert.deepEqual(bySha.lines, [WARN_829]);
      assert.ok(!bySha.calls.some((c) => c.includes("pulls/835/")));
      // Detached, a PR whose branch is literally "HEAD" isn't this checkout's.
      const notOwn = run({
        prs: [{ number: 835, headRefName: "HEAD", headRefOid: "2".repeat(40) }],
        files: FILES,
      });
      assert.match(notOwn.lines[0] ?? "", /also added by open PR #835/);
    } finally {
      gitIn(repo, ["checkout", "-q", "feature"]);
    }
  });

  it("compares every open PR when none is this checkout's", () => {
    const { lines } = run({
      prs: [{ number: 835, headRefName: "someone-else", headRefOid: "2".repeat(40) }],
      files: { 835: [`supabase/migrations/${MINE}`] },
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /also added by open PR #835/);
  });

  it("says nothing when gh isn't logged in, and lists no PRs", () => {
    const { lines, calls } = run({ auth: false, files: { 829: [] } });
    assert.deepEqual(lines, []);
    assert.deepEqual(calls, ["auth status"]);
  });

  it("fails open with a note when GitHub can't be read", () => {
    assert.deepEqual(run({ listError: true }).lines, [
      "note\tOpen-PR migration version check skipped (couldn't list the open PRs).",
    ]);
    const partial = run({
      files: { 829: ["supabase/migrations/20261113000001_theirs.sql"], 840: null },
    }).lines;
    assert.equal(partial.length, 2);
    assert.match(partial[1], /^note\tCouldn't list the files of open PR #840/);
  });

  // Once the budget is spent, one note says how far it got, not one per PR.
  it("gives up once the budget is spent, with one note", () => {
    let t = 0;
    const prs = [829, 850, 851, 852, 853].map((number) => ({ number }));
    const { gh } = fakeGh({ prs, files: FILES });
    const slow = (args) => {
      if (args[0] === "api") t += 20_000;
      return gh(args);
    };
    const lines = claimedCheck({ root: repo, base: "main" }, { gh: slow, now: () => t });
    assert.deepEqual(lines, [
      WARN_829,
      "note\tOpen-PR migration version check gave up after 30s; checked 2 of 5 open PRs.",
    ]);
  });

  it("calls gh only when the checkout adds a migration", () => {
    const { gh, calls } = fakeGh();
    const lines = claimedCheck({ root: repo, base: "main", dir: "docs" }, { gh });
    assert.deepEqual(lines, []);
    assert.deepEqual(calls, []);
  });
});

describe("ownPrNumbers", () => {
  const list = [
    { number: 1, headRefName: "feature", headRefOid: "a".repeat(40) },
    { number: 2, headRefName: "other", headRefOid: "b".repeat(40) },
    { number: 3, headRefName: "HEAD", headRefOid: "c".repeat(40) },
  ];
  it("matches the branch, or the head commit, and never a detached HEAD's name", () => {
    assert.deepEqual([...ownPrNumbers(list, { branch: "feature", sha: "" })], [1]);
    assert.deepEqual([...ownPrNumbers(list, { branch: "HEAD", sha: "b".repeat(40) })], [2]);
    assert.deepEqual([...ownPrNumbers(list, { branch: "HEAD", sha: "" })], []);
    assert.deepEqual([...ownPrNumbers(null, { branch: "feature", sha: "" })], []);
  });
});
