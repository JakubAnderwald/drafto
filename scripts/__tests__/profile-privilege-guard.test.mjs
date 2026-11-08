// Static checks on the profiles privilege-column guard (issues #457 and #794).
// The guard is the only thing stopping a signed-in user from PATCHing their own
// profile to is_admin / is_approved = true or lifting their own
// storage_quota_bytes, and a Postgres instance is not available in CI, so these
// tests pin the exact guard shape. The live check in
// profile-privilege-guard.live.test.mjs exercises it against the dev project.
//
// 20260922000001 installs the trigger and the first version of the function.
// Later migrations redefine the function (`create or replace`) to guard more
// columns, and the newest definition is the one that runs. So the condition is
// pinned on the newest definition, and every definition must keep the shape
// that makes the guard work (SECURITY INVOKER, the role gate, the 42501 raise).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = path.join(REPO_ROOT, "supabase", "migrations");
// Installs the trigger (and the function's first version).
const GUARD_FILE = "20260922000001_guard_profile_privilege_columns.sql";

// The columns the newest definition must guard, in the order its condition
// compares them. A new column users must not set for themselves goes here and
// into a new migration's `create or replace function`.
const GUARDED_COLUMNS = ["is_admin", "is_approved", "storage_quota_bytes"];

// Lowercased SQL with `--` comments removed and whitespace collapsed, so the
// header comment (which mentions SECURITY DEFINER) cannot satisfy or trip a check.
function normalizeSql(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

const MIGRATION_FILES = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const MIGRATION_SQL = new Map(
  MIGRATION_FILES.map((f) => [f, normalizeSql(readFileSync(path.join(MIGRATIONS, f), "utf8"))]),
);

// The function's name, schema-qualified or not, quoted or not.
const GUARD_NAME = '(?:"?public"?\\.)?"?guard_profile_privilege_columns"?';
const DEFINITION_START = new RegExp(`create (?:or replace )?function ${GUARD_NAME} ?\\(`, "g");

// Each definition of the guard function, from its `create` to the end of its
// `$$` body, oldest first. Only `$$` quoting is understood; any other tag makes
// the slice run on, and the shape checks below fail loudly rather than pass.
const DEFINITIONS = MIGRATION_FILES.flatMap((file) => {
  const sql = MIGRATION_SQL.get(file);
  return [...sql.matchAll(DEFINITION_START)].map((match) => {
    const bodyStart = sql.indexOf("$$", match.index);
    const bodyEnd = bodyStart === -1 ? -1 : sql.indexOf("$$", bodyStart + 2);
    if (bodyEnd === -1) throw new Error(`${file}: guard function body has no closing $$`);
    return { file, sql: sql.slice(match.index, bodyEnd + 2) };
  });
});
const LATEST = DEFINITIONS.at(-1);

const sql = MIGRATION_SQL.get(GUARD_FILE);

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("profiles privilege guard migration", () => {
  it("installs a BEFORE UPDATE row trigger on public.profiles", () => {
    assert.ok(sql, `${GUARD_FILE} is missing`);
    assert.match(
      sql,
      /create trigger guard_profile_privilege_columns before update on public\.profiles for each row execute function public\.guard_profile_privilege_columns\(\);/,
    );
  });

  it("drops the trigger first so the migration can be re-applied", () => {
    const drop = sql.indexOf(
      "drop trigger if exists guard_profile_privilege_columns on public.profiles;",
    );
    const create = sql.indexOf("create trigger guard_profile_privilege_columns");
    assert.notEqual(drop, -1);
    assert.ok(drop < create, "drop must come before create");
  });

  it("finds the first definition and every redefinition, including #794's", () => {
    const files = DEFINITIONS.map((d) => d.file);
    assert.equal(files[0], GUARD_FILE);
    assert.ok(
      files.includes("20261108000001_per_user_storage_quota.sql"),
      `definitions found in: ${files.join(", ")}`,
    );
  });

  it("guards every privilege column in the newest definition (the one that runs)", () => {
    // One condition, pinned whole: each column compared with IS DISTINCT FROM,
    // the role gate and the admin exemption all AND-ed, then a 42501 raise
    // (insufficient_privilege, which PostgREST answers with 403).
    const compared = GUARDED_COLUMNS.map(
      (c) => `old\\.${escapeRegExp(c)} is distinct from new\\.${escapeRegExp(c)}`,
    ).join(" or ");
    assert.match(
      LATEST.sql,
      // The whole body, so nothing can return early before the check.
      new RegExp(
        `as \\$\\$ begin if \\( ?${compared} ?\\) and current_user in \\('authenticated', 'anon'\\) and not public\\.is_admin\\(\\) then raise exception '[^']+' using errcode = '42501'; end if; return new; end; \\$\\$$`,
      ),
      `newest definition, in ${LATEST.file}`,
    );
  });

  it("keeps the role gate, admin exemption and 42501 raise in every definition", () => {
    for (const { file, sql: definition } of DEFINITIONS) {
      assert.match(
        definition,
        /\) and current_user in \('authenticated', 'anon'\) and not public\.is_admin\(\) then raise exception '[^']+' using errcode = '42501'; end if; return new;/,
        file,
      );
    }
  });

  it("is a SECURITY INVOKER plpgsql function with a pinned search_path in every definition", () => {
    for (const { file, sql: definition } of DEFINITIONS) {
      assert.match(
        definition,
        /^create or replace function public\.guard_profile_privilege_columns\(\) returns trigger language plpgsql security invoker set search_path = public, pg_catalog as \$\$/,
        file,
      );
    }
  });

  it("never declares SECURITY DEFINER (current_user would become the owner)", () => {
    // Checked per definition: a migration may define other, SECURITY DEFINER
    // functions next to this one.
    for (const { file, sql: definition } of DEFINITIONS) {
      assert.doesNotMatch(definition, /security definer/, file);
    }
  });

  it("is never altered, dropped or switched off by a migration", () => {
    for (const [file, text] of MIGRATION_SQL) {
      assert.doesNotMatch(
        text,
        new RegExp(`(?:alter|drop) (?:function|routine) (?:if exists )?${GUARD_NAME}`),
        file,
      );
      assert.doesNotMatch(
        text,
        /alter table (?:only )?(?:public\.)?profiles disable trigger/,
        file,
      );
      // Dropping the trigger is fine only to re-create it later in the same file.
      for (const drop of text.matchAll(
        /drop trigger (?:if exists )?"?guard_profile_privilege_columns/g,
      )) {
        assert.ok(
          text.indexOf("create trigger guard_profile_privilege_columns", drop.index) !== -1,
          `${file} drops the guard trigger without re-creating it`,
        );
      }
    }
  });

  it("sorts every definition after public.is_admin() and the admin bootstrap", () => {
    const at = (name) => {
      const index = MIGRATION_FILES.indexOf(name);
      assert.notEqual(index, -1, `${name} is missing`);
      return index;
    };
    for (const { file } of DEFINITIONS) {
      const guard = at(file);
      // public.is_admin() is defined here.
      assert.ok(guard > at("20260225000001_fix_rls_recursion.sql"), file);
      // The bootstrap sets is_admin / is_approved and must run before the guard.
      assert.ok(guard > at("20260420000001_admin_bootstrap.sql"), file);
    }
  });

  it("passes the migration safety check", () => {
    for (const file of new Set(DEFINITIONS.map((d) => d.file))) {
      const result = spawnSync(
        "bash",
        ["scripts/check-migration-safety.sh", path.join(MIGRATIONS, file)],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      assert.equal(result.status, 0, `${file}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /Results: 0 error\(s\), 0 warning\(s\)/, file);
    }
  });
});
