import { synchronize } from "@nozbe/watermelondb/sync";

import type { Database as WMDatabase } from "@nozbe/watermelondb";
import type { SyncPullResult } from "@nozbe/watermelondb/sync";

import type { Database } from "@drafto/shared";

import { supabase } from "@/lib/supabase";

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

async function pullChanges({ lastPulledAt }: { lastPulledAt?: number }): Promise<SyncPullResult> {
  const isFirstSync = lastPulledAt === undefined;
  const serverTimestamp = Date.now();

  const [notebooks, notes, attachments] = await Promise.all([
    fetchTable<NotebookRow>("notebooks", "updated_at", lastPulledAt, mapNotebookRow),
    fetchTable<NoteRow>("notes", "updated_at", lastPulledAt, mapNoteRow),
    fetchTable<AttachmentRow>("attachments", "created_at", lastPulledAt, mapAttachmentRow),
  ]);

  return {
    changes: {
      notebooks: splitChanges(notebooks, isFirstSync),
      notes: splitChanges(notes, isFirstSync),
      attachments: splitChanges(attachments, isFirstSync),
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
  conflictCount: number;
}

export async function syncDatabase(db: WMDatabase): Promise<SyncResult> {
  let conflictCount = 0;

  try {
    await synchronize({
      database: db,
      pullChanges,
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
