import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Tests for scripts/check-migration-safety.sh (`pnpm migration:check`) and its grants
// rule, scripts/lib/check-migration-grants.awk. The rule exists because Supabase stops
// auto-granting the Data API roles on new public tables on 2026-10-30 (ADR 0052): a
// table created without a GRANT is unreachable from supabase-js, so the check fails
// the migration instead.

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, "..", "check-migration-safety.sh");
const awkPath = resolve(here, "..", "lib", "check-migration-grants.awk");
const migrationsDir = resolve(here, "..", "..", "supabase", "migrations");
const grantsMigration = "20261020000001_explicit_data_api_grants.sql";

// Writes each { name: sql } entry to a temp dir and runs the check over those files,
// passed in insertion order.
function check(files) {
  const dir = mkdtempSync(join(tmpdir(), "migration-check-"));
  try {
    const paths = Object.entries(files).map(([name, sql]) => {
      const path = join(dir, name);
      writeFileSync(path, sql);
      return path;
    });
    return spawnSync("bash", [scriptPath, ...paths], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const table = (name, columns = "id uuid primary key") =>
  `create table ${name} (\n  ${columns}\n);\n`;
const grant = (name, roles = "authenticated") => `grant select on ${name} to ${roles};\n`;
const NO_GRANT = /has no GRANT to authenticated or service_role/;

function assertPasses(res) {
  assert.equal(res.status, 0, res.stdout + res.stderr);
}

function assertFails(res, pattern) {
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, pattern);
}

describe("check-migration-safety: Data API grants on tables", () => {
  it("passes a table granted in the same migration", () => {
    assertPasses(check({ "001.sql": table("public.widgets") + grant("public.widgets") }));
  });

  it("fails a table with no grant, naming the file, line and table", () => {
    const res = check({ "001.sql": `-- widgets\n${table("public.widgets")}` });
    assertFails(res, /001\.sql:2 — public\.widgets has no GRANT to authenticated or service_role/);
    assert.match(res.stdout, /Results: 1 error\(s\)/);
    assert.match(res.stdout, /Data API grants: grant the table/);
  });

  it("sees a create split over several lines", () => {
    const res = check({ "001.sql": "create table\n  public.widgets (id uuid);\n" });
    assertFails(res, /001\.sql:1 — public\.widgets has no GRANT/);
  });

  it("matches a grant spread over several lines with a comma list and `on table`", () => {
    const sql = [
      table("public.widgets"),
      table("public.gadgets"),
      "grant select, insert, update, delete",
      "  on table",
      "  public.widgets,",
      "  public.gadgets",
      "  to authenticated, service_role;",
      "",
    ].join("\n");
    assertPasses(check({ "001.sql": sql }));
  });

  it("treats unqualified and quoted names as public", () => {
    const sql =
      table("widgets") +
      table('"public"."gadgets"') +
      grant("widgets") +
      grant('"public"."gadgets"');
    assertPasses(check({ "001.sql": sql }));
  });

  it("ignores tables in other schemas, temp tables and partitions", () => {
    const sql = [
      table("private.widgets"),
      "create temp table scratch (id int);",
      "create table public.events_2026 partition of public.events for values in (2026);",
      "",
    ].join("\n");
    assertPasses(check({ "001.sql": sql }));
  });

  it("only counts grants to authenticated or service_role", () => {
    assertFails(check({ "001.sql": table("public.a") + grant("public.a", "postgres") }), NO_GRANT);
    assertFails(check({ "001.sql": table("public.b") + grant("public.b", "anon") }), NO_GRANT);
    assertPasses(check({ "001.sql": table("public.c") + grant("public.c", "service_role") }));
  });

  it("accepts `-- safety:ignore` in the create statement for a table kept off the API", () => {
    const sql = "create table public.internal_log ( -- safety:ignore\n  id uuid primary key\n);\n";
    assertPasses(check({ "001.sql": sql }));
  });

  it("accepts `grant … on all tables in schema public` after the create, not before", () => {
    const schemaGrant = 'grant select on all tables in schema "public" to authenticated;\n';
    assertPasses(check({ "001.sql": table("public.widgets") + schemaGrant }));
    assertFails(check({ "001.sql": schemaGrant + table("public.widgets") }), NO_GRANT);
  });

  it("does not count grants on functions, sequences or schemas", () => {
    const sql = [
      table("public.widgets"),
      "grant execute on function public.widgets() to authenticated;",
      "grant usage on schema public to authenticated;",
      "grant usage, select on all sequences in schema public to authenticated;",
      "",
    ].join("\n");
    assertFails(check({ "001.sql": sql }), NO_GRANT);
  });

  it("ignores grants in comments and dollar-quoted bodies", () => {
    const sql = [
      table("public.widgets"),
      "-- grant select on public.widgets to authenticated;",
      "/* grant select on public.widgets to authenticated; */",
      "create function f() returns void language sql as $$",
      "  grant select on public.widgets to authenticated;",
      "$$;",
      "",
    ].join("\n");
    assertFails(check({ "001.sql": sql }), NO_GRANT);
  });

  it("does not split statements on `--` or `;` inside a string literal", () => {
    const sql =
      table("public.widgets") +
      "comment on table public.widgets is 'a -- b; c';\n" +
      grant("public.widgets");
    assertPasses(check({ "001.sql": sql }));
  });

  it("counts a final grant without a semicolon", () => {
    const sql = table("public.widgets") + "grant select on public.widgets to authenticated";
    assertPasses(check({ "001.sql": sql }));
  });

  it("fails a table whose last API grant a later REVOKE ALL removes, at the revoke", () => {
    const res = check({
      "001.sql": table("public.widgets") + grant("public.widgets"),
      "002.sql": "revoke all on public.widgets from authenticated;\n",
    });
    assertFails(res, /002\.sql:1 — public\.widgets has no GRANT/);
  });

  it("passes a REVOKE ALL that leaves an API role with access", () => {
    const res = check({
      "001.sql": table("public.widgets") + grant("public.widgets", "anon, authenticated"),
      "002.sql": "revoke all on public.widgets from anon;\n",
    });
    assertPasses(res);
  });

  it("accepts a grant in a later migration of the set, whatever the argument order", () => {
    const res = check({
      "002.sql": grant("public.widgets"),
      "001.sql": table("public.widgets"),
    });
    assertPasses(res);
  });

  it("keeps grants across `create table if not exists` of an existing table", () => {
    const res = check({
      "001.sql": table("public.widgets") + grant("public.widgets"),
      "002.sql": table("if not exists public.widgets"),
    });
    assertPasses(res);
  });

  it("rejects a grant from before the table was dropped and re-created", () => {
    const res = check({
      "001.sql": table("public.widgets") + grant("public.widgets"),
      "002.sql": `drop table if exists public.widgets;\n${table("public.widgets")}`,
    });
    assertFails(res, /002\.sql:2 — public\.widgets has no GRANT/);
  });

  it("fails a serial column and passes an identity column", () => {
    const serial = table("public.events", "id bigserial primary key") + grant("public.events");
    assertFails(check({ "001.sql": serial }), /public\.events has a serial column/);
    const identity =
      table("public.events", "id bigint generated always as identity primary key") +
      grant("public.events");
    assertPasses(check({ "001.sql": identity }));
  });
});

describe("check-migration-safety: Data API grants on views", () => {
  const view = (opts = "") =>
    `create or replace view public.widget_counts${opts} as select 1 as n;\n`;

  it("passes a security_invoker view granted in the same migration", () => {
    const sql = view(" with (security_invoker = true)") + grant("public.widget_counts");
    assertPasses(check({ "001.sql": sql }));
  });

  it("fails a view with no grant", () => {
    assertFails(check({ "001.sql": view(" with (security_invoker)") }), NO_GRANT);
  });

  it("fails a granted view without security_invoker", () => {
    const res = check({ "001.sql": view() + grant("public.widget_counts") });
    assertFails(res, /view public\.widget_counts lacks security_invoker = true/);
  });

  it("accepts security_invoker set by a later ALTER VIEW", () => {
    const sql =
      view() +
      "alter view public.widget_counts set (security_invoker = on);\n" +
      grant("public.widget_counts");
    assertPasses(check({ "001.sql": sql }));
  });

  it("keeps a view's grants across `create or replace` in a later migration", () => {
    const res = check({
      "001.sql": view(" with (security_invoker = true)") + grant("public.widget_counts"),
      "002.sql": view(" with (security_invoker = true)"),
    });
    assertPasses(res);
  });

  it("leaves materialized views off the API (no grant needed)", () => {
    const sql = "create materialized view public.widget_stats as select 1 as n;\n";
    assertPasses(check({ "001.sql": sql }));
  });

  it("fails a recursive view with no grant", () => {
    const sql =
      "create recursive view public.tree (n) with (security_invoker) as select 1 union all select n + 1 from tree where n < 3;\n";
    assertFails(check({ "001.sql": sql }), NO_GRANT);
  });
});

describe("check-migration-safety: destructive SQL (regression)", () => {
  it("still fails DROP TABLE without IF EXISTS and TRUNCATE, without the grants hint", () => {
    const res = check({ "001.sql": "drop table public.widgets;\ntruncate public.gadgets;\n" });
    assertFails(res, /DROP TABLE without IF EXISTS/);
    assert.match(res.stdout, /TRUNCATE statement/);
    assert.doesNotMatch(res.stdout, /Data API grants/);
  });
});

// The full set passing through the shell script is CI's `pnpm migration:check` step.
// These call the awk rule directly, which is fast, against the real migrations.
describe("check-migration-safety: the repo's migrations", () => {
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const grantsRule = (files) =>
    spawnSync("awk", ["-f", awkPath, ...files.map((f) => join(migrationsDir, f))], {
      encoding: "utf8",
    });

  it("have no grant findings", () => {
    const res = grantsRule(migrations);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, "");
  });

  it("report all six original tables when replayed up to before the grants migration", () => {
    const res = grantsRule(migrations.filter((f) => f < grantsMigration));
    assert.equal(res.status, 0, res.stderr);
    for (const name of [
      "profiles",
      "notebooks",
      "notes",
      "attachments",
      "api_keys",
      "note_content_history",
    ]) {
      assert.match(res.stdout, new RegExp(`public\\.${name} has no GRANT`));
    }
  });
});
