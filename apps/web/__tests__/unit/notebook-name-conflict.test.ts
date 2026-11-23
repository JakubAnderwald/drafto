import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  findNotebookNameConflict,
  NOTEBOOK_NAME_PAGE_SIZE,
} from "@/lib/api/notebook-name-conflict";

type Row = { id: string; name: string };

/**
 * A notebooks table that, like PostgREST, never returns more than `NOTEBOOK_NAME_PAGE_SIZE`
 * rows per request. `failOnPage` makes that page's read fail.
 */
function pagedSupabase(rows: Row[], failOnPage?: number) {
  const ranges: Array<[number, number]> = [];
  const filters: Array<[string, string]> = [];
  const orders: string[] = [];
  const from = vi.fn(() => ({
    select: (columns: string) => {
      expect(columns).toBe("id, name");
      return {
        eq: (column: string, value: string) => {
          filters.push([column, value]);
          return {
            order: (orderColumn: string) => {
              orders.push(orderColumn);
              return {
                range: (start: number, end: number) => {
                  ranges.push([start, end]);
                  if (failOnPage === ranges.length - 1) {
                    return Promise.resolve({ data: null, error: { message: "db down" } });
                  }
                  const capped = Math.min(end, start + NOTEBOOK_NAME_PAGE_SIZE - 1);
                  return Promise.resolve({ data: rows.slice(start, capped + 1), error: null });
                },
              };
            },
          };
        },
      };
    },
  }));
  return {
    supabase: { from } as unknown as SupabaseClient<Database>,
    ranges,
    filters,
    orders,
  };
}

function manyNotebooks(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `nb-${String(i).padStart(5, "0")}`,
    name: `Notebook ${i}`,
  }));
}

describe("findNotebookNameConflict — PrimeTestLab 11035 review", () => {
  it("reads one page for a user with fewer notebooks than a page", async () => {
    const { supabase, ranges, filters, orders } = pagedSupabase([
      { id: "nb-1", name: "Project Ideas" },
    ]);

    const result = await findNotebookNameConflict(supabase, "user-1", " project  IDEAS ");

    expect(result).toEqual({
      duplicate: { id: "nb-1", name: "Project Ideas" },
      renamedNotebookFound: true,
      error: null,
    });
    expect(ranges).toEqual([[0, NOTEBOOK_NAME_PAGE_SIZE - 1]]);
    expect(filters).toEqual([["user_id", "user-1"]]);
    expect(orders).toEqual(["id"]);
  });

  it("finds a duplicate past the first page (more notebooks than max_rows)", async () => {
    const rows = manyNotebooks(NOTEBOOK_NAME_PAGE_SIZE + 5);
    const { supabase, ranges } = pagedSupabase(rows);

    const result = await findNotebookNameConflict(
      supabase,
      "user-1",
      `notebook ${NOTEBOOK_NAME_PAGE_SIZE + 3}`,
    );

    expect(result.duplicate).toEqual(rows[NOTEBOOK_NAME_PAGE_SIZE + 3]);
    expect(ranges).toEqual([
      [0, NOTEBOOK_NAME_PAGE_SIZE - 1],
      [NOTEBOOK_NAME_PAGE_SIZE, 2 * NOTEBOOK_NAME_PAGE_SIZE - 1],
    ]);
  });

  it("finds a renamed notebook past the first page instead of reporting it missing", async () => {
    const rows = manyNotebooks(NOTEBOOK_NAME_PAGE_SIZE + 1);
    const renamed = rows[NOTEBOOK_NAME_PAGE_SIZE];
    const { supabase } = pagedSupabase(rows);

    const result = await findNotebookNameConflict(supabase, "user-1", "Fresh name", renamed.id);

    expect(result).toEqual({ duplicate: null, renamedNotebookFound: true, error: null });
  });

  it("reads one more (empty) page when the user has exactly a page of notebooks", async () => {
    const { supabase, ranges } = pagedSupabase(manyNotebooks(NOTEBOOK_NAME_PAGE_SIZE));

    const result = await findNotebookNameConflict(supabase, "user-1", "Fresh name");

    expect(result.duplicate).toBeNull();
    expect(ranges).toHaveLength(2);
  });

  it("reports a missing renamed notebook", async () => {
    const { supabase } = pagedSupabase([{ id: "nb-1", name: "Recipes" }]);

    const result = await findNotebookNameConflict(supabase, "user-1", "Recipes", "nb-missing");

    expect(result.renamedNotebookFound).toBe(false);
  });

  it("returns the error when a later page can't be read, without a partial answer", async () => {
    const { supabase } = pagedSupabase(manyNotebooks(NOTEBOOK_NAME_PAGE_SIZE + 5), 1);

    const result = await findNotebookNameConflict(supabase, "user-1", "Notebook 1");

    expect(result).toEqual({
      duplicate: null,
      renamedNotebookFound: false,
      error: { message: "db down" },
    });
  });
});
