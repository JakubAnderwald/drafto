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

/**
 * Every notebook the user owns (id and name), read page by page in id order. Each page starts
 * after the last id read rather than at an offset, so a notebook deleted from an earlier page
 * while this runs can't shift a later one past the next page's start.
 */
async function readAllNotebookNames(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<NotebookNamesResult> {
  const notebooks: NamedNotebook[] = [];
  let afterId: string | null = null;
  for (;;) {
    let query = supabase.from("notebooks").select("id, name").eq("user_id", userId);
    if (afterId !== null) query = query.gt("id", afterId);
    const { data, error } = await query
      .order("id", { ascending: true })
      .limit(NOTEBOOK_NAME_PAGE_SIZE);

    if (error) return { notebooks: null, error };
    const page = data ?? [];
    notebooks.push(...page);
    if (page.length < NOTEBOOK_NAME_PAGE_SIZE) return { notebooks, error: null };
    afterId = page[page.length - 1].id;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `id` as the database returns it. Postgres accepts an upper-case UUID in a URL but always
 * returns ids in lower case, so an upper-case one is lower-cased before it's compared with
 * them. Anything else is compared as given.
 */
function canonicalNotebookId(id: string): string {
  return UUID.test(id) ? id.toLowerCase() : id;
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
  const renamedId = excludeId === undefined ? undefined : canonicalNotebookId(excludeId);

  if (error) return { duplicate: null, renamedNotebookFound: false, error };
  return {
    duplicate: findDuplicateNotebook(name, notebooks, renamedId) ?? null,
    renamedNotebookFound:
      renamedId === undefined || notebooks.some((notebook) => notebook.id === renamedId),
    error: null,
  };
}
