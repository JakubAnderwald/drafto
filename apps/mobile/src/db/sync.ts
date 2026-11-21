import { AppState } from "react-native";
import { synchronize } from "@nozbe/watermelondb/sync";

import type { Database as WMDatabase } from "@nozbe/watermelondb";
import type { SyncPullResult, SyncPushResult } from "@nozbe/watermelondb/sync";

import { contentUsageFromError, isContentQuotaError, isVisibleRemoteChange } from "@drafto/shared";
import type { Database, StorageUsage } from "@drafto/shared";

import { flushActivityDays, invalidateActivityDays, markAppOpened } from "@/db/activity-days";
import { clientTag, supabase } from "@/lib/supabase";

type NotebookRow = Database["public"]["Tables"]["notebooks"]["Row"];
type NoteRow = Database["public"]["Tables"]["notes"]["Row"];
type AttachmentRow = Database["public"]["Tables"]["attachments"]["Row"];

type SyncRecord = Record<string, unknown>;

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
  table: "notebooks" | "notes" | "attachments",
  timestampCol: string,
  lastPulledAt: number | null | undefined,
  mapFn: (row: T) => SyncRecord,
): Promise<SyncRecord[]> {
  let query = supabase.from(table).select("*");
  // A first sync applies no cursor; the unpaged query is still capped at the
  // API's max_rows. WatermelonDB passes `lastPulledAt: null`, not `undefined`
  // as its type suggests, when this database has never pulled.
  if (lastPulledAt != null) {
    query = query.gt(timestampCol, toISO(lastPulledAt));
  }
  const { data, error } = await query;
  if (error) throw new Error(`Pull ${table} failed: ${error.message}`);
  return (data as T[]).map(mapFn);
}

/**
 * Every pulled record goes to WatermelonDB as `updated`, on a first sync too,
 * and runSync passes `sendCreatedAsUpdated: true` to synchronize(). An
 * incremental pull can't tell a row created on another device from one this
 * device already has, so WatermelonDB creates any `updated` record missing
 * locally; the flag stops it logging "[Sync] Server wants client to update
 * record …, but it doesn't exist locally" for each one. While the flag is on,
 * WatermelonDB logs an error whenever a pull sends `created` records, so
 * `created` stays empty.
 */
function splitChanges(records: SyncRecord[]): SyncTableChanges {
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

async function pullChanges({
  lastPulledAt,
}: {
  lastPulledAt?: number | null;
}): Promise<SyncPullResult> {
  const [notebooks, notes, attachments, serverTimestamp] = await Promise.all([
    fetchTable<NotebookRow>("notebooks", "updated_at", lastPulledAt, mapNotebookRow),
    fetchTable<NoteRow>("notes", "updated_at", lastPulledAt, mapNoteRow),
    fetchTable<AttachmentRow>("attachments", "created_at", lastPulledAt, mapAttachmentRow),
    getServerTimestamp(),
  ]);

  return {
    changes: {
      notebooks: splitChanges(notebooks),
      notes: splitChanges(notes),
      attachments: splitChanges(attachments),
    },
    timestamp: serverTimestamp,
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
      const { error } = await supabase
        .from("notebooks")
        .update({
          name: r.name as string,
          updated_at: new Date().toISOString(),
        })
        .eq("id", r.remote_id as string);
      if (error) throw new Error(`Push notebook update failed: ${error.message}`);
    }
  }

  if (changes.deleted.length > 0) {
    const { error } = await supabase.from("notebooks").delete().in("id", changes.deleted);
    if (error) throw new Error(`Push notebooks (delete) failed: ${error.message}`);
  }
}

/**
 * Notes the server refused for the content quota (ADR 0090) during one push. They
 * go back to WatermelonDB as `experimentalRejectedIds`, so they stay unsynced on
 * this device (the user's text is never lost) and go out again on a later sync.
 */
export interface ContentQuotaRefusals {
  /** Local ids of the refused notes. */
  noteIds: string[];
  /** Server ids of refused new notes: their attachments can't be pushed yet. */
  createdNoteIds: Set<string>;
  /** The usage the latest refusal reported, when it carried one. */
  usage: StorageUsage | null;
}

function noRefusals(): ContentQuotaRefusals {
  return { noteIds: [], createdNoteIds: new Set(), usage: null };
}

function recordRefusal(refusals: ContentQuotaRefusals, localId: string, error: unknown): void {
  refusals.noteIds.push(localId);
  refusals.usage = contentUsageFromError(error) ?? refusals.usage;
}

async function pushNoteChanges(changes: SyncTableChanges, refusals: ContentQuotaRefusals) {
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
    if (error) {
      if (!isContentQuotaError(error)) {
        throw new Error(`Push notes (create) failed: ${error.message}`);
      }
      // One refused note fails the whole batch, so push them one at a time:
      // every note that still fits syncs, and only the refused ones wait.
      for (const [index, row] of rows.entries()) {
        const { error: rowError } = await supabase.from("notes").upsert(row);
        if (!rowError) continue;
        if (!isContentQuotaError(rowError)) {
          throw new Error(`Push notes (create) failed: ${rowError.message}`);
        }
        recordRefusal(refusals, changes.created[index].id as string, rowError);
        refusals.createdNoteIds.add(row.id);
      }
    }
  }

  if (changes.updated.length > 0) {
    for (const r of changes.updated) {
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
        .eq("id", r.remote_id as string);
      if (error) {
        // A refused edit stays unsynced; the other notes still go out.
        if (isContentQuotaError(error)) {
          recordRefusal(refusals, r.id as string, error);
          continue;
        }
        throw new Error(`Push note update failed: ${error.message}`);
      }
    }
  }

  if (changes.deleted.length > 0) {
    const { error } = await supabase.from("notes").delete().in("id", changes.deleted);
    if (error) throw new Error(`Push notes (delete) failed: ${error.message}`);
  }
}

/**
 * Pushes attachment changes and returns the local ids of the attachments it held
 * back: those of a new note the content quota refused, whose row the server
 * doesn't have yet. They stay unsynced and go out with their note.
 */
async function pushAttachmentChanges(
  changes: SyncTableChanges,
  refusedNoteIds: Set<string>,
): Promise<string[]> {
  const heldBack: string[] = [];
  if (changes.created.length > 0) {
    // Only push attachments that have been uploaded (not pending)
    const uploadedRows = changes.created
      .filter((r) => r.upload_status === "uploaded")
      .filter((r) => {
        if (!refusedNoteIds.has(r.note_id as string)) return true;
        heldBack.push(r.id as string);
        return false;
      })
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
      // ON CONFLICT DO NOTHING: uploadSingleAttachment() usually inserted this
      // row already, and public.attachments has no UPDATE policy (attachments
      // are immutable), so a plain upsert's ON CONFLICT DO UPDATE is rejected
      // by RLS. That failure aborted every later sync after the notes had been
      // pushed, so nothing was ever marked synced.
      const { error } = await supabase
        .from("attachments")
        .upsert(uploadedRows, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw new Error(`Push attachments (create) failed: ${error.message}`);
    }
  }

  // Attachments are immutable — no updates needed

  if (changes.deleted.length > 0) {
    const { error } = await supabase.from("attachments").delete().in("id", changes.deleted);
    if (error) throw new Error(`Push attachments (delete) failed: ${error.message}`);
  }
  return heldBack;
}

type PushChanges = (params: {
  changes: Record<string, SyncTableChanges>;
}) => Promise<SyncPushResult | undefined>;

/** A pushChanges that records this push's content quota refusals in <refusals>. */
function createPushChanges(refusals: ContentQuotaRefusals): PushChanges {
  return async ({ changes }) => {
    const notebookChanges = changes["notebooks"] as SyncTableChanges;
    const noteChanges = changes["notes"] as SyncTableChanges;
    const attachmentChanges = changes["attachments"] as SyncTableChanges;

    // Push in order: notebooks first (notes depend on them), then notes, then attachments
    await pushNotebookChanges(notebookChanges);
    await pushNoteChanges(noteChanges, refusals);
    const heldBack = await pushAttachmentChanges(attachmentChanges, refusals.createdNoteIds);

    if (refusals.noteIds.length === 0 && heldBack.length === 0) return undefined;
    // WatermelonDB leaves these unsynced instead of marking them synced.
    return { experimentalRejectedIds: { notes: refusals.noteIds, attachments: heldBack } };
  };
}

export class SyncNetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Network error during sync");
    this.name = "SyncNetworkError";
    this.cause = cause;
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
  /**
   * Pulled records that changed something the user can see on this device
   * (see `isVisibleRemoteChange`). Not a conflict count: WatermelonDB calls the
   * resolver for every pulled record that differs locally, including the echo
   * of this device's own push.
   */
  remoteChangeCount: number;
  /**
   * Notes this push left unsynced because the server refused them for the
   * content quota (ADR 0090). They go out again on a later sync.
   */
  contentQuotaRefused: number;
  /** The usage the server reported with a refusal, when it carried one. */
  contentUsage: StorageUsage | null;
}

async function runSync(db: WMDatabase): Promise<SyncResult> {
  let remoteChangeCount = 0;
  const refusals = noRefusals();

  try {
    await synchronize({
      database: db,
      pullChanges,
      pushChanges: createPushChanges(refusals),
      migrationsEnabledAtVersion: 1,
      // Pulls send every record as `updated`; see splitChanges.
      sendCreatedAsUpdated: true,
      conflictResolver: (table, local, _remote, resolved) => {
        // Keep WatermelonDB's resolution (remote values, except for columns
        // this device changed since its last push), and count it only when it
        // changes what the user sees, so the echo of our own push stays quiet.
        if (isVisibleRemoteChange(table, local, resolved)) remoteChangeCount += 1;
        return resolved;
      },
    });
  } catch (error) {
    if (isNetworkError(error)) {
      throw new SyncNetworkError(error);
    }
    throw error;
  }

  return {
    remoteChangeCount,
    contentQuotaRefused: refusals.noteIds.length,
    contentUsage: refusals.usage,
  };
}

/**
 * The activity ping (ADR-0088, docs/features/offline-sync.md): sent only after
 * a sync got through, with every day queued since the last one. Both calls
 * never reject; the catch is a backstop so a ping can never change the sync's
 * result. A failed ping keeps its days for the next sync. Waits for it at most
 * ACTIVITY_PING_MAX_WAIT_MS.
 *
 * <stillCurrent> is asked again once today's mark has settled: sign-out can
 * call resetSyncState while the mark is still waiting, and the flush must not
 * then start, or it would send the signed-out user's queued days under
 * whichever session the client holds next.
 */
async function pingActivity(
  db: WMDatabase,
  opened: Promise<void>,
  stillCurrent: () => boolean,
): Promise<void> {
  const ping = opened
    .then(() => (stillCurrent() ? flushActivityDays(db, supabase, clientTag) : undefined))
    .catch((error: unknown) => console.warn("[Sync] Activity ping failed:", error));
  await settleWithin(ping, ACTIVITY_PING_MAX_WAIT_MS);
}

/**
 * How long a sync waits for its activity ping before returning. A ping that
 * hasn't answered by then carries on in the background, and its days stay
 * queued until the server answers, so a stalled request can't keep the caller
 * that started the sync waiting.
 */
export const ACTIVITY_PING_MAX_WAIT_MS = 10_000;

/** Resolves once <task> settles or <ms> have passed, whichever comes first. */
async function settleWithin(task: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
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
  // The activity ping is part of the sync: a mark or flush still running for
  // this session must not write into the next user's queue either.
  invalidateActivityDays();
}

/**
 * Whether the user has Drafto in front. Only a sync started then counts as
 * opening the app (ADR-0088), as does the app coming to the front, which
 * `DatabaseProvider` marks itself. Reconnect and retry syncs also run while the app
 * sits in the background, and on macOS the app keeps running after its window
 * is closed, so counting those would mark days nobody opened Drafto.
 */
function isAppInFront(): boolean {
  return AppState.currentState === "active";
}

export async function syncDatabase(db: WMDatabase): Promise<SyncResult> {
  // A sync started while the app is in front, offline ones included, counts as
  // opening the app today (ADR-0088). A background sync marks nothing, but its
  // ping below still sends the days already queued. Started before the latch
  // check and not awaited here, so coalescing and resetSyncState work as
  // before; the ping below awaits it.
  const opened = isAppInFront() ? markAppOpened(db) : Promise.resolve();
  if (inFlightSync) {
    return inFlightSync;
  }
  const generation = syncGeneration;
  const pending = runSync(db);
  inFlightSync = pending;
  let result: SyncResult;
  try {
    result = await pending;
  } finally {
    // Only clear the latch if it still points at THIS run and no reset (or
    // newer sync) superseded us — otherwise we'd null out a live sync.
    if (syncGeneration === generation && inFlightSync === pending) {
      inFlightSync = null;
    }
  }
  // The latch is already free while the ping is out. A caller arriving now
  // (sign-out's final sync, a follow-up pass for a local edit) runs its own
  // synchronize() and pushes what changed since this push, instead of joining
  // a sync whose push has already finished. A sync that resetSyncState
  // superseded sends no ping: its session has ended.
  const stillCurrent = () => syncGeneration === generation;
  if (stillCurrent()) await pingActivity(db, opened, stillCurrent);
  return result;
}
