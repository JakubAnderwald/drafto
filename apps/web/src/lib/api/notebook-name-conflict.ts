import { findDuplicateNotebook, type NamedNotebook } from "@drafto/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export interface NotebookNameConflict {
  /** The user's notebook that already has the name, or null when the name is free. */
  duplicate: NamedNotebook | null;
  /**
   * On a rename, whether the user owns the renamed notebook (`excludeId`). False means the id
   * is missing or someone else's, which the caller reports as not found before any name
   * conflict. Always true on a create.
   */
  renamedNotebookFound: boolean;
  /** Set when the user's notebooks couldn't be read, so the name couldn't be checked. */
  error: { message: string } | null;
}

/**
 * Rows per request when reading the user's notebook names. PostgREST caps every response at
 * `max_rows` (1000 in `supabase/config.toml`, the hosted default too), so one unpaged read
 * silently drops every notebook past the 1000th. This must not exceed `max_rows`: a page
 * shorter than this is taken as the last one.
 */
export const NOTEBOOK_NAME_PAGE_SIZE = 1000;

type NotebookNamesResult =
  { notebooks: NamedNotebook[]; error: null } | { notebooks: null; error: { message: string } };

/** Every notebook the user owns (id and name), read page by page in a stable order. */
async function readAllNotebookNames(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<NotebookNamesResult> {
  const notebooks: NamedNotebook[] = [];
  for (let from = 0; ; from += NOTEBOOK_NAME_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("notebooks")
      .select("id, name")
      .eq("user_id", userId)
      .order("id", { ascending: true })
      .range(from, from + NOTEBOOK_NAME_PAGE_SIZE - 1);

    if (error) return { notebooks: null, error };
    const page = data ?? [];
    notebooks.push(...page);
    if (page.length < NOTEBOOK_NAME_PAGE_SIZE) return { notebooks, error: null };
  }
}

/**
 * Checks `name` against the user's other notebooks (PrimeTestLab 11035 M-01, ADR-0097).
 *
 * Shared by the REST routes and the MCP tools, so every way in refuses the same names. Pass
 * the renamed notebook's id as `excludeId` on a rename. There is no unique constraint behind
 * this: a create racing another create can still slip through, which the apps tolerate.
 *
 * The comparison runs in JS on every notebook the user owns rather than in a filtered query,
 * because `normalizeNotebookName` (NFC, Unicode whitespace, locale-free lower-casing) has no
 * exact SQL equivalent: an `ilike` would miss an NFD-stored name or fold case differently.
 */
export async function findNotebookNameConflict(
  supabase: SupabaseClient<Database>,
  userId: string,
  name: string,
  excludeId?: string,
): Promise<NotebookNameConflict> {
  const { notebooks, error } = await readAllNotebookNames(supabase, userId);

  if (error) return { duplicate: null, renamedNotebookFound: false, error };
  return {
    duplicate: findDuplicateNotebook(name, notebooks, excludeId) ?? null,
    renamedNotebookFound:
      excludeId === undefined || notebooks.some((notebook) => notebook.id === excludeId),
    error: null,
  };
}
