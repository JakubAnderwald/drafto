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
 * Checks `name` against the user's other notebooks (PrimeTestLab 11035 M-01, ADR-0097).
 *
 * Shared by the REST routes and the MCP tools, so every way in refuses the same names. Pass
 * the renamed notebook's id as `excludeId` on a rename. There is no unique constraint behind
 * this: a create racing another create can still slip through, which the apps tolerate.
 */
export async function findNotebookNameConflict(
  supabase: SupabaseClient<Database>,
  userId: string,
  name: string,
  excludeId?: string,
): Promise<NotebookNameConflict> {
  const { data, error } = await supabase.from("notebooks").select("id, name").eq("user_id", userId);

  if (error) return { duplicate: null, renamedNotebookFound: false, error };
  const notebooks = data ?? [];
  return {
    duplicate: findDuplicateNotebook(name, notebooks, excludeId) ?? null,
    renamedNotebookFound:
      excludeId === undefined || notebooks.some((notebook) => notebook.id === excludeId),
    error: null,
  };
}
