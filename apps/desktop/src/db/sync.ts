import { synchronize } from "@nozbe/watermelondb/sync";

import type { Database as WMDatabase } from "@nozbe/watermelondb";
import type { SyncPullResult } from "@nozbe/watermelondb/sync";

import type { Database } from "@drafto/shared";

import { supabase } from "@/lib/supabase";

type NotebookRow = Database["public"]["Tables"]["notebooks"]["Row"];
type NoteRow = Database["public"]["Tables"]["notes"]["Row"];
type AttachmentRow = Database["public"]["Tables"]["attachments"]["Row"];

type SyncRecord = Record<string, unknown>;

type SyncTable = "notebooks" | "notes" | "attachments";

type SyncTableChanges = {
  created: SyncRecord[];
  updated: SyncRecord[];
  deleted: string[];
};

function toTimestamp(iso: string): number {
  return new Date(iso).getTime();
}

function toISO(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function mapNotebookRow(row: NotebookRow): SyncRecord {
  return {
    id: row.id,
    remote_id: row.id,
    user_id: row.user_id,
    name: row.name,
    created_at: toTimestamp(row.created_at),
    updated_at: toTimestamp(row.updated_at),
  };
}

function mapNoteRow(row: NoteRow): SyncRecord {
  return {
    id: row.id,
    remote_id: row.id,
    notebook_id: row.notebook_id,
    user_id: row.user_id,
    title: row.title,
    content: row.content ? JSON.stringify(row.content) : null,
    is_trashed: row.is_trashed,
    trashed_at: row.trashed_at ? toTimestamp(row.trashed_at) : null,
    created_at: toTimestamp(row.created_at),
    updated_at: toTimestamp(row.updated_at),
  };
}

function mapAttachmentRow(row: AttachmentRow): SyncRecord {
  return {
    id: row.id,
    remote_id: row.id,
    note_id: row.note_id,
    user_id: row.user_id,
    file_name: row.file_name,
    file_path: row.file_path,
    file_size: row.file_size,
    mime_type: row.mime_type,
    created_at: toTimestamp(row.created_at),
    local_uri: null,
    upload_status: "uploaded",
  };
}

async function fetchTable<T>(
  table: SyncTable,
  timestampCol: string,
  lastPulledAt: number | undefined,
  mapFn: (row: T) => SyncRecord,
): Promise<SyncRecord[]> {
  let query = supabase.from(table).select("*");
  if (lastPulledAt !== undefined) {
    query = query.gt(timestampCol, toISO(lastPulledAt));
  }
  const { data, error } = await query;
  if (error) throw new Error(`Pull ${table} failed: ${error.message}`);
  return (data as T[]).map(mapFn);
}

function splitChanges(records: SyncRecord[], isFirstSync: boolean): SyncTableChanges {
  if (isFirstSync) {
    return { created: records, updated: [], deleted: [] };
  }
  // On incremental sync, all returned records are treated as updated.
  // WatermelonDB handles the case where an "updated" record doesn't
  // exist locally — it creates it automatically.
  return { created: [], updated: records, deleted: [] };
}

async function getServerTimestamp(): Promise<number> {
  // Use Supabase server time to avoid clock skew between client and server.
  // Client Date.now() can be ahead of the server, causing sync to miss records
  // whose updated_at is between server-now and client-now.
  const { data, error } = await supabase.rpc("get_server_time");
  if (!error && data) {
    return new Date(data as string).getTime();
  }
  // Fallback: use client time with a safety margin to reduce clock skew risk
  return Date.now() - 5000;
}

async function fetchAllIds(table: SyncTable): Promise<string[]> {
  const { data, error } = await supabase.from(table).select("id");
  if (error) throw new Error(`Fetch ${table} IDs failed: ${error.message}`);
  return (data as { id: string }[]).map((r) => r.id);
}

/**
 * Refuses to pull without an authenticated session. RLS answers an anon select
 * with zero rows and no error, so an unauthenticated pull looks like "the
 * server is empty" and `lastPulledAt` would advance past rows this device never
 * received. (Live deletion detection would also read it as "everything was
 * deleted"; see detectServerDeletions for why that is inert today and guarded
 * anyway.) Only the session is checked, not approval — DatabaseProvider gates
 * on `isApproved`. A `getSession()` error (e.g. a token refresh while offline)
 * keeps its original message so `isNetworkError` still classifies it and the
 * provider retries as before.
 */
async function assertAuthenticatedSession(): Promise<void> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(`Sync aborted: session check failed: ${error.message}`);
  if (!data.session) throw new Error("Sync aborted: no authenticated session");
}

type LocalSyncState = { id: string; remoteId?: string | null; _status?: string };

/**
 * Returns the local IDs of synced records whose remote row is missing from
 * `serverIds`, i.e. rows deleted on the server since the last pull. Unsynced
 * local records (created/updated offline) won't exist on the server yet and
 * must not be flagged as deleted before the push phase runs.
 *
 * Fail-safe: an empty server ID set while synced local records exist is
 * treated as suspicious rather than as "everything was deleted". RLS returns
 * zero rows with no error when the session is missing or the account is not
 * approved, so acting on it would wipe the table locally. Detection is skipped
 * for that table instead; a table legitimately emptied on another device stays
 * stale here until it has rows again (tombstones would fix that server-side).
 *
 * Note: WatermelonDB models expose their sync state as `syncStatus`
 * (`_raw._status`), not `_status`, so this check — kept as it was in the loops
 * it replaced — matches no real model record and detection is inert in the
 * app today. Reading `syncStatus` instead would switch it on; that needs
 * `fetchAllIds` to page past the Supabase API's `max_rows` limit (1000 in
 * `supabase/config.toml` and by default on hosted projects) first, or a user
 * with more rows than that would see the overflow flagged as deleted.
 */
function detectServerDeletions(
  localRecords: readonly LocalSyncState[],
  serverIds: readonly string[],
  table: SyncTable,
): string[] {
  const synced = localRecords.filter((r) => r._status === "synced");
  if (synced.length === 0) return [];
  if (serverIds.length === 0) {
    console.warn(
      `[Sync] Server returned no ${table} IDs but ${synced.length} synced local record(s) exist — skipping deletion detection for ${table}`,
    );
    return [];
  }
  const serverIdSet = new Set(serverIds);
  return synced.filter((r) => !serverIdSet.has(r.remoteId || r.id)).map((r) => r.id);
}

function createPullChanges(database: WMDatabase) {
  return async ({ lastPulledAt }: { lastPulledAt?: number }): Promise<SyncPullResult> => {
    const isFirstSync = lastPulledAt === undefined;

    // Throwing here makes synchronize() abort before applying anything, so
    // lastPulledAt does not advance on a pull RLS would have answered with nothing.
    await assertAuthenticatedSession();

    const [notebooks, notes, attachments, serverTimestamp] = await Promise.all([
      fetchTable<NotebookRow>("notebooks", "updated_at", lastPulledAt, mapNotebookRow),
      fetchTable<NoteRow>("notes", "updated_at", lastPulledAt, mapNoteRow),
      fetchTable<AttachmentRow>("attachments", "created_at", lastPulledAt, mapAttachmentRow),
      getServerTimestamp(),
    ]);

    const notebookChanges = splitChanges(notebooks, isFirstSync);
    const noteChanges = splitChanges(notes, isFirstSync);
    const attachmentChanges = splitChanges(attachments, isFirstSync);

    // Detect server-side deletions on incremental syncs by comparing local IDs
    // against all IDs currently on the server.
    if (!isFirstSync) {
      const [serverNotebookIds, serverNoteIds, serverAttachmentIds] = await Promise.all([
        fetchAllIds("notebooks"),
        fetchAllIds("notes"),
        fetchAllIds("attachments"),
      ]);

      const localNotebooks = await database.get("notebooks").query().fetch();
      const localNotes = await database.get("notes").query().fetch();
      const localAttachments = await database.get("attachments").query().fetch();

      notebookChanges.deleted.push(
        ...detectServerDeletions(
          localNotebooks as unknown as LocalSyncState[],
          serverNotebookIds,
          "notebooks",
        ),
      );
      noteChanges.deleted.push(
        ...detectServerDeletions(localNotes as unknown as LocalSyncState[], serverNoteIds, "notes"),
      );
      attachmentChanges.deleted.push(
        ...detectServerDeletions(
          localAttachments as unknown as LocalSyncState[],
          serverAttachmentIds,
          "attachments",
        ),
      );
    }

    return {
      changes: {
        notebooks: notebookChanges,
        notes: noteChanges,
        attachments: attachmentChanges,
      },
      timestamp: serverTimestamp,
    };
  };
}

async function pushNotebookChanges(changes: SyncTableChanges) {
  if (changes.created.length > 0) {
    const rows = changes.created.map((r) => ({
      id: r.remote_id as string,
      user_id: r.user_id as string,
      name: r.name as string,
    }));
    const { error } = await supabase.from("notebooks").upsert(rows);
    if (error) throw new Error(`Push notebooks (create) failed: ${error.message}`);
  }

  if (changes.updated.length > 0) {
    for (const r of changes.updated) {
      const nbId = r.remote_id as string | undefined;
      if (!nbId) {
        console.warn(`[Sync] Skipping notebook update with no remote_id: ${r.id}`);
        continue;
      }
      const { error } = await supabase
        .from("notebooks")
        .update({
          name: r.name as string,
          updated_at: new Date().toISOString(),
        })
        .eq("id", nbId);
      if (error) throw new Error(`Push notebook update failed: ${error.message}`);
    }
  }

  if (changes.deleted.length > 0) {
    const { error } = await supabase.from("notebooks").delete().in("id", changes.deleted);
    if (error) throw new Error(`Push notebooks (delete) failed: ${error.message}`);
  }
}

async function pushNoteChanges(changes: SyncTableChanges) {
  if (changes.created.length > 0) {
    const rows = changes.created.map((r) => ({
      id: r.remote_id as string,
      notebook_id: r.notebook_id as string,
      user_id: r.user_id as string,
      title: r.title as string,
      content: r.content ? JSON.parse(r.content as string) : null,
      is_trashed: (r.is_trashed as boolean) ?? false,
      trashed_at: r.trashed_at ? toISO(r.trashed_at as number) : null,
    }));
    const { error } = await supabase.from("notes").upsert(rows);
    if (error) throw new Error(`Push notes (create) failed: ${error.message}`);
  }

  if (changes.updated.length > 0) {
    for (const r of changes.updated) {
      const noteId = r.remote_id as string | undefined;
      if (!noteId) {
        console.warn(`[Sync] Skipping note update with no remote_id: ${r.id}`);
        continue;
      }
      const { error } = await supabase
        .from("notes")
        .update({
          notebook_id: r.notebook_id as string,
          title: r.title as string,
          content: r.content ? JSON.parse(r.content as string) : null,
          is_trashed: (r.is_trashed as boolean) ?? false,
          trashed_at: r.trashed_at ? toISO(r.trashed_at as number) : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", noteId);
      if (error) throw new Error(`Push note update failed: ${error.message}`);
    }
  }

  if (changes.deleted.length > 0) {
    const { error } = await supabase.from("notes").delete().in("id", changes.deleted);
    if (error) throw new Error(`Push notes (delete) failed: ${error.message}`);
  }
}

async function pushAttachmentChanges(changes: SyncTableChanges) {
  if (changes.created.length > 0) {
    // Only push attachments that have been uploaded (not pending)
    const uploadedRows = changes.created
      .filter((r) => r.upload_status === "uploaded")
      .map((r) => ({
        id: r.remote_id as string,
        note_id: r.note_id as string,
        user_id: r.user_id as string,
        file_name: r.file_name as string,
        file_path: r.file_path as string,
        file_size: r.file_size as number,
        mime_type: r.mime_type as string,
      }));
    if (uploadedRows.length > 0) {
      const { error } = await supabase.from("attachments").upsert(uploadedRows);
      if (error) throw new Error(`Push attachments (create) failed: ${error.message}`);
    }
  }

  // Attachments are immutable — no updates needed

  if (changes.deleted.length > 0) {
    const { error } = await supabase.from("attachments").delete().in("id", changes.deleted);
    if (error) throw new Error(`Push attachments (delete) failed: ${error.message}`);
  }
}

async function pushChanges({ changes }: { changes: Record<string, SyncTableChanges> }) {
  const notebookChanges = changes["notebooks"] as SyncTableChanges;
  const noteChanges = changes["notes"] as SyncTableChanges;
  const attachmentChanges = changes["attachments"] as SyncTableChanges;

  // Push in order: notebooks first (notes depend on them), then notes, then attachments
  await pushNotebookChanges(notebookChanges);
  await pushNoteChanges(noteChanges);
  await pushAttachmentChanges(attachmentChanges);
}

export class SyncNetworkError extends Error {
  readonly syncCause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Network error during sync");
    this.name = "SyncNetworkError";
    this.syncCause = cause;
  }
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("network request failed") ||
    msg.includes("network error") ||
    msg.includes("failed to fetch") ||
    msg.includes("no internet") ||
    msg.includes("internet connection") ||
    msg.includes("network offline") ||
    msg.includes("request timeout") ||
    msg.includes("connection timeout") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("etimedout")
  );
}

export interface SyncResult {
  conflictCount: number;
}

async function runSync(db: WMDatabase): Promise<SyncResult> {
  let conflictCount = 0;

  try {
    await synchronize({
      database: db,
      pullChanges: createPullChanges(db),
      pushChanges,
      migrationsEnabledAtVersion: 1,
      conflictResolver: (_table, _local, remote, resolved) => {
        // Server-wins: use the resolved record (which already prefers remote)
        // but count the conflict so we can notify the user
        conflictCount += 1;
        return resolved;
      },
    });
  } catch (error) {
    if (isNetworkError(error)) {
      throw new SyncNetworkError(error);
    }
    throw error;
  }

  return { conflictCount };
}

// Module-level in-flight coalesce. WatermelonDB forbids concurrent
// synchronize() calls, and sign-out's best-effort final sync can run alongside
// the DatabaseProvider's own sync. When a sync is already running, additional
// callers await the same promise instead of starting a second synchronize().
// This changes no pull/push/conflict behaviour — it only serialises re-entrant
// callers.
let inFlightSync: Promise<SyncResult> | null = null;
// Bumped whenever the in-flight sync is invalidated (sign-out). A sync captures
// the generation it started under; only a settling sync of the current
// generation is allowed to clear the latch — so a stale sync can't null out a
// newer session's sync. See resetSyncState.
let syncGeneration = 0;

/**
 * Invalidate any in-flight sync so the NEXT `syncDatabase()` starts its own
 * `synchronize()` instead of awaiting a prior session's. Sign-out calls this
 * after destroying the Supabase session: a final sync that timed out but is
 * still running must not be handed to the next signed-in user, whose initial
 * sync would otherwise await the previous user's `runSync()` and write that
 * user's pulled records into the freshly-reset local database. The stale sync
 * is left to settle in the background; the generation guard below stops its
 * cleanup from clobbering the next session's latch.
 */
export function resetSyncState(): void {
  syncGeneration += 1;
  inFlightSync = null;
}

export async function syncDatabase(db: WMDatabase): Promise<SyncResult> {
  if (inFlightSync) {
    return inFlightSync;
  }
  const generation = syncGeneration;
  const pending = runSync(db);
  inFlightSync = pending;
  try {
    return await pending;
  } finally {
    // Only clear the latch if it still points at THIS run and no reset (or
    // newer sync) superseded us — otherwise we'd null out a live sync.
    if (syncGeneration === generation && inFlightSync === pending) {
      inFlightSync = null;
    }
  }
}
