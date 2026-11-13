/**
 * Drift test: the `x-drafto-client` tags in `DRAFTO_CLIENT_TAGS`
 * (`packages/shared/src/constants.ts`) must match every copy of the list in
 * the activity-days migration: `usage_daily`'s check constraint,
 * `record_activity`'s tag check and `rollup_usage_daily`'s tag list, whose
 * order also decides which row takes a user's untagged work (ADR 0077).
 *
 * A copy is any comma-separated run of quoted SQL strings that includes
 * 'web-mcp'. If this fails, a tag was added, removed or reordered on one
 * side only: change both, with a new migration for the SQL side.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DRAFTO_CLIENT_TAGS } from "../src/constants";

const MIGRATION_PATH = resolve(
  __dirname,
  "../../../supabase/migrations/20261113000003_usage_daily.sql",
);

/** Every list of 2+ quoted SQL strings in <sql>, comment lines left out. */
function quotedLists(sql: string): string[][] {
  const code = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const lists = code.match(/'[^']*'(?:\s*,\s*'[^']*')+/g) ?? [];
  return lists.map((list) => [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]));
}

describe("client tags drift: DRAFTO_CLIENT_TAGS vs 20261113000003_usage_daily.sql", () => {
  let tagLists: string[][];

  beforeAll(() => {
    tagLists = quotedLists(readFileSync(MIGRATION_PATH, "utf8")).filter((list) =>
      list.includes("web-mcp"),
    );
  });

  it("finds the constraint's, record_activity's and the rollup's lists", () => {
    expect(tagLists.length).toBeGreaterThanOrEqual(3);
  });

  it("writes every list exactly as DRAFTO_CLIENT_TAGS, in the same order", () => {
    for (const list of tagLists) {
      expect(list).toEqual([...DRAFTO_CLIENT_TAGS]);
    }
  });

  it("covers the check constraint", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    const constraint = /constraint usage_daily_client_check\s+check \(client in \(([^)]*)\)\)/.exec(
      sql,
    );
    expect(constraint).not.toBeNull();
    expect(quotedLists(constraint?.[1] ?? "")).toEqual([[...DRAFTO_CLIENT_TAGS]]);
  });
});
