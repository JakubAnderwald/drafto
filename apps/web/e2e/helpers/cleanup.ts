import { STALE_AFTER_MS, selectStale, type NoteRow, type NotebookRow } from "./e2e-patterns";
import type { E2ESession } from "./e2e-supabase";

/**
 * Rows per select page, matching PostgREST's `max_rows`. Paging carries on until a page
 * comes back empty, so a lower cap costs extra requests but never truncates the scan.
 */
const PAGE_SIZE = 1000;

/**
 * Ids per delete statement. Keeps the request URL short and each cascade well inside the
 * authenticated role's statement timeout.
 */
export const DELETE_CHUNK_SIZE = 100;

interface QueryError {
  message: string;
}

type QueryResult<T> = PromiseLike<{ data: T[] | null; error: QueryError | null }>;

export interface DeleteResult {
  /** Rows deleted. Ids that were already gone, such as a notebook a spec deleted itself, aren't counted. */
  deleted: number;
  /** Ids in chunks whose delete failed. */
  failed: string[];
  errors: string[];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

async function deleteInChunks(
  ids: readonly string[],
  deleteChunk: (chunk: string[]) => QueryResult<{ id: string }>,
): Promise<DeleteResult> {
  const result: DeleteResult = { deleted: 0, failed: [], errors: [] };
  for (const chunkIds of chunk([...new Set(ids)], DELETE_CHUNK_SIZE)) {
    const { data, error } = await deleteChunk(chunkIds);
    if (error) {
      result.failed.push(...chunkIds);
      result.errors.push(error.message);
    } else {
      result.deleted += data?.length ?? 0;
    }
  }
  return result;
}

/** Hard-deletes the E2E user's notes with these ids, trashed or not. */
export function deleteNotesById(
  session: E2ESession,
  ids: readonly string[],
): Promise<DeleteResult> {
  return deleteInChunks(ids, (chunkIds) =>
    session.client
      .from("notes")
      .delete()
      .eq("user_id", session.userId)
      .in("id", chunkIds)
      .select("id"),
  );
}

/**
 * Deletes the E2E user's notebooks with these ids. `on delete cascade` takes their notes
 * with them, and from the notes their attachments and content history.
 */
export function deleteNotebooksById(
  session: E2ESession,
  ids: readonly string[],
): Promise<DeleteResult> {
  return deleteInChunks(ids, (chunkIds) =>
    session.client
      .from("notebooks")
      .delete()
      .eq("user_id", session.userId)
      .in("id", chunkIds)
      .select("id"),
  );
}

function purgeError(step: string, error: QueryError): Error {
  return new Error(`E2E purge could not ${step}: ${error.message}`);
}

/** Pages through a table by id (keyset), so rows other runs add or delete meanwhile can't shift a page. */
async function selectAllPages<T extends { id: string }>(
  what: string,
  selectPage: (afterId: string | null) => QueryResult<T>,
): Promise<T[]> {
  const rows: T[] = [];
  let afterId: string | null = null;
  for (;;) {
    const { data, error } = await selectPage(afterId);
    if (error) throw purgeError(`list ${what}`, error);
    if (!data || data.length === 0) return rows;
    rows.push(...data);
    afterId = data[data.length - 1].id;
  }
}

export interface PurgeTableReport {
  /** Rows the E2E user owns. */
  scanned: number;
  /** Rows deleted. For notes, this includes the notes deleted along with their notebook. */
  purged: number;
  /** E2E rows left in place, because they or (for a notebook) a note in it were touched within the cutoff. */
  kept: number;
}

export interface PurgeReport {
  cutoff: string;
  notebooks: PurgeTableReport;
  notes: PurgeTableReport;
}

/**
 * Deletes the E2E user's E2E notebooks and notes that nothing has touched for
 * `STALE_AFTER_MS` (see `selectStale`). Unlike the API's notebook list, the scan pages
 * past PostgREST's 1,000-row cap. Throws on any query error.
 */
export async function purgeStaleE2EData(
  session: E2ESession,
  now: Date = new Date(),
): Promise<PurgeReport> {
  const { client, userId } = session;
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
  const cutoffIso = cutoff.toISOString();

  const notebooks = await selectAllPages<NotebookRow>("notebooks", (afterId) => {
    const query = client.from("notebooks").select("id, name, updated_at").eq("user_id", userId);
    return (afterId ? query.gt("id", afterId) : query).order("id").limit(PAGE_SIZE);
  });
  const notes = await selectAllPages<NoteRow>("notes", (afterId) => {
    const query = client
      .from("notes")
      .select("id, notebook_id, title, updated_at")
      .eq("user_id", userId);
    return (afterId ? query.gt("id", afterId) : query).order("id").limit(PAGE_SIZE);
  });

  const stale = selectStale({ notebooks, notes }, cutoff);

  // Each delete re-applies the cutoff, so a row another run touched after the scan stays.
  const purgedNotebookIds = new Set<string>();
  for (const ids of chunk(stale.notebookIds, DELETE_CHUNK_SIZE)) {
    // A note another run wrote since the scan keeps its notebook too.
    const { data: live, error: liveError } = await client
      .from("notes")
      .select("notebook_id")
      .eq("user_id", userId)
      .in("notebook_id", ids)
      .gte("updated_at", cutoffIso);
    if (liveError) throw purgeError("check the notes in stale notebooks", liveError);
    const liveNotebookIds = new Set((live ?? []).map((note) => note.notebook_id));
    const idle = ids.filter((id) => !liveNotebookIds.has(id));
    if (idle.length === 0) continue;

    const { data, error } = await client
      .from("notebooks")
      .delete()
      .eq("user_id", userId)
      .in("id", idle)
      .lt("updated_at", cutoffIso)
      .select("id");
    if (error) throw purgeError("delete stale notebooks", error);
    for (const row of data ?? []) purgedNotebookIds.add(row.id);
  }

  const purgedNoteIds = new Set(
    notes.filter((note) => purgedNotebookIds.has(note.notebook_id)).map((note) => note.id),
  );
  for (const ids of chunk(stale.noteIds, DELETE_CHUNK_SIZE)) {
    const { data, error } = await client
      .from("notes")
      .delete()
      .eq("user_id", userId)
      .in("id", ids)
      .lt("updated_at", cutoffIso)
      .select("id");
    if (error) throw purgeError("delete stale notes", error);
    for (const row of data ?? []) purgedNoteIds.add(row.id);
  }

  return {
    cutoff: cutoffIso,
    notebooks: {
      scanned: notebooks.length,
      purged: purgedNotebookIds.size,
      kept: stale.e2eNotebookIds.filter((id) => !purgedNotebookIds.has(id)).length,
    },
    notes: {
      scanned: notes.length,
      purged: purgedNoteIds.size,
      kept: stale.e2eNoteIds.filter((id) => !purgedNoteIds.has(id)).length,
    },
  };
}
