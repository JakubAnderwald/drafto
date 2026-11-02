// Static checks on the profiles privilege-column guard (issue #457). The
// migration is the only thing stopping a signed-in user from PATCHing their own
// profile to is_admin / is_approved = true, and a Postgres instance is not
// available in CI, so these tests pin the exact guard shape. The live check in
// profile-privilege-guard.live.test.mjs exercises it against the dev project.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = path.join(REPO_ROOT, "supabase", "migrations");
const GUARD_FILE = "20260922000001_guard_profile_privilege_columns.sql";
const GUARD_PATH = path.join(MIGRATIONS, GUARD_FILE);

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

const sql = normalizeSql(readFileSync(GUARD_PATH, "utf8"));

describe("profiles privilege guard migration", () => {
  it("installs a BEFORE UPDATE row trigger on public.profiles", () => {
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

  it("rejects a flag change from the API roles unless the caller is an admin", () => {
    // One condition, pinned whole: each flag compared with IS DISTINCT FROM,
    // the role gate and the admin exemption all AND-ed, then a 42501 raise
    // (insufficient_privilege, which PostgREST answers with 403).
    assert.match(
      sql,
      /if \( ?old\.is_admin is distinct from new\.is_admin or old\.is_approved is distinct from new\.is_approved ?\) and current_user in \('authenticated', 'anon'\) and not public\.is_admin\(\) then raise exception '[^']+' using errcode = '42501'; end if; return new;/,
    );
  });

  it("is a SECURITY INVOKER plpgsql function with a pinned search_path", () => {
    assert.match(
      sql,
      /create or replace function public\.guard_profile_privilege_columns\(\) returns trigger language plpgsql security invoker set search_path = public, pg_catalog as \$\$/,
    );
  });

  it("never declares SECURITY DEFINER (current_user would become the owner)", () => {
    assert.doesNotMatch(sql, /security definer/);
  });

  it("sorts after public.is_admin() and the admin bootstrap", () => {
    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const at = (name) => {
      const index = files.indexOf(name);
      assert.notEqual(index, -1, `${name} is missing`);
      return index;
    };
    const guard = at(GUARD_FILE);
    // public.is_admin() is defined here.
    assert.ok(guard > at("20260225000001_fix_rls_recursion.sql"));
    // The bootstrap sets is_admin / is_approved and must run before the guard.
    assert.ok(guard > at("20260420000001_admin_bootstrap.sql"));
  });

  it("passes the migration safety check", () => {
    const result = spawnSync("bash", ["scripts/check-migration-safety.sh", GUARD_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Results: 0 error\(s\), 0 warning\(s\)/);
  });
});
