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
 * rows per request. `failOnPage` makes that page's read fail. `onPageRead` runs after each page
 * is served, so a test can change the table between pages. `cursors` records each page's
 * `gt("id", …)` cursor (null for the first page).
 */
function pagedSupabase(
  initialRows: Row[],
  failOnPage?: number,
  onPageRead?: (page: number, rows: Row[]) => Row[],
) {
  let rows = initialRows;
  const cursors: Array<string | null> = [];
  const limits: number[] = [];
  const filters: Array<[string, string]> = [];
  const orders: string[] = [];
  const from = vi.fn(() => ({
    select: (columns: string) => {
      expect(columns).toBe("id, name");
      let cursor: string | null = null;
      const query = {
        eq: (column: string, value: string) => {
          filters.push([column, value]);
          return query;
        },
        gt: (column: string, value: string) => {
          expect(column).toBe("id");
          cursor = value;
          return query;
        },
        order: (orderColumn: string) => {
          orders.push(orderColumn);
          return query;
        },
        limit: (count: number) => {
          const page = cursors.length;
          cursors.push(cursor);
          limits.push(count);
          if (failOnPage === page) {
            return Promise.resolve({ data: null, error: { message: "db down" } });
          }
          const after = cursor;
          const served = [...rows]
            .sort((a, b) => a.id.localeCompare(b.id))
            .filter((row) => after === null || row.id > after)
            .slice(0, Math.min(count, NOTEBOOK_NAME_PAGE_SIZE));
          if (onPageRead) rows = onPageRead(page, rows);
          return Promise.resolve({ data: served, error: null });
        },
      };
      return query;
    },
  }));
  return {
    supabase: { from } as unknown as SupabaseClient<Database>,
    cursors,
    limits,
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
    const { supabase, cursors, limits, filters, orders } = pagedSupabase([
      { id: "nb-1", name: "Project Ideas" },
    ]);

    const result = await findNotebookNameConflict(supabase, "user-1", " project  IDEAS ");

    expect(result).toEqual({
      duplicate: { id: "nb-1", name: "Project Ideas" },
      renamedNotebookFound: true,
      error: null,
    });
    expect(cursors).toEqual([null]);
    expect(limits).toEqual([NOTEBOOK_NAME_PAGE_SIZE]);
    expect(filters).toEqual([["user_id", "user-1"]]);
    expect(orders).toEqual(["id"]);
  });

  it("finds a duplicate past the first page (more notebooks than max_rows)", async () => {
    const rows = manyNotebooks(NOTEBOOK_NAME_PAGE_SIZE + 5);
    const { supabase, cursors } = pagedSupabase(rows);

    const result = await findNotebookNameConflict(
      supabase,
      "user-1",
      `notebook ${NOTEBOOK_NAME_PAGE_SIZE + 3}`,
    );

    expect(result.duplicate).toEqual(rows[NOTEBOOK_NAME_PAGE_SIZE + 3]);
    expect(cursors).toEqual([null, rows[NOTEBOOK_NAME_PAGE_SIZE - 1].id]);
  });

  it("finds a renamed notebook past the first page instead of reporting it missing", async () => {
    const rows = manyNotebooks(NOTEBOOK_NAME_PAGE_SIZE + 1);
    const renamed = rows[NOTEBOOK_NAME_PAGE_SIZE];
    const { supabase } = pagedSupabase(rows);

    const result = await findNotebookNameConflict(supabase, "user-1", "Fresh name", renamed.id);

    expect(result).toEqual({ duplicate: null, renamedNotebookFound: true, error: null });
  });

  it("reads one more (empty) page when the user has exactly a page of notebooks", async () => {
    const { supabase, cursors } = pagedSupabase(manyNotebooks(NOTEBOOK_NAME_PAGE_SIZE));

    const result = await findNotebookNameConflict(supabase, "user-1", "Fresh name");

    expect(result.duplicate).toBeNull();
    expect(cursors).toHaveLength(2);
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

describe("findNotebookNameConflict — PrimeTestLab 11035 CodeRabbit", () => {
  it("still sees a later page's notebook when one on an earlier page is deleted mid-read", async () => {
    const rows = manyNotebooks(NOTEBOOK_NAME_PAGE_SIZE + 2);
    const first = rows[NOTEBOOK_NAME_PAGE_SIZE];
    // After the first page is read, a notebook on it is deleted: an offset read of the second
    // page would now start one row late and skip `first`.
    const { supabase } = pagedSupabase(rows, undefined, (page, current) =>
      page === 0 ? current.filter((row) => row.id !== rows[0].id) : current,
    );

    const result = await findNotebookNameConflict(supabase, "user-1", first.name);

    expect(result.duplicate).toEqual(first);
  });

  it("finds an owned notebook whose UUID arrives in upper case", async () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const { supabase } = pagedSupabase([
      { id, name: "Recipes" },
      { id: "1f8fad5b-d9cb-469f-a165-70867728950e", name: "Travel" },
    ]);

    const result = await findNotebookNameConflict(supabase, "user-1", "RECIPES", id.toUpperCase());

    expect(result).toEqual({ duplicate: null, renamedNotebookFound: true, error: null });
  });

  it("still reports a foreign UUID as not found, in any case", async () => {
    const { supabase } = pagedSupabase([
      { id: "0f8fad5b-d9cb-469f-a165-70867728950e", name: "Recipes" },
    ]);

    const result = await findNotebookNameConflict(
      supabase,
      "user-1",
      "Recipes",
      "9F8FAD5B-D9CB-469F-A165-70867728950E",
    );

    expect(result.renamedNotebookFound).toBe(false);
  });
});
