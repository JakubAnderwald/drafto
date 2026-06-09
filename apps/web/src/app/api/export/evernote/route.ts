import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { getAuthenticatedUserFast, errorResponse } from "@/lib/api/utils";
import {
  BUCKET_NAME,
  blocksToEnml,
  buildEnex,
  type BlockNoteBlock,
  type ExportedNote,
  type ExportedResource,
  type MediaIndex,
  type EnmlMediaEntry,
} from "@drafto/shared";
import {
  EXPORT_MAX_NOTES,
  EXPORT_MAX_TOTAL_BYTES,
  type ExportEvernoteRequest,
  type ExportNotebookListResponse,
  type ExportNotebookSummary,
} from "@/lib/api/export-types";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type Supabase = SupabaseClient<Database>;

interface NoteRow {
  id: string;
  notebook_id: string;
  title: string;
  content: unknown;
  created_at: string;
  updated_at: string;
}

interface AttachmentRow {
  id: string;
  note_id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  mime_type: string;
}

interface NotebookRow {
  id: string;
  name: string;
}

const SAFE_FILENAME_RE = /[^A-Za-z0-9._-]+/g;

export async function GET(request: NextRequest): Promise<Response> {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;
  const { supabase, user } = auth;

  // Fetch all the user's notebooks plus a note count for each. RLS already
  // restricts to the caller's rows, but we still filter explicitly as defence-in-depth.
  const { data: notebooks, error: nbError } = await supabase
    .from("notebooks")
    .select("id, name")
    .eq("user_id", user.id)
    .order("name", { ascending: true });

  if (nbError) {
    return errorResponse("Failed to load notebooks", 500);
  }

  // Count notes per notebook in a single query rather than N+1 head counts —
  // sequential per-notebook counts were enough to stall the export dialog
  // (and its E2E tests) when a user had many notebooks.
  const { data: noteRows, error: countError } = await supabase
    .from("notes")
    .select("notebook_id")
    .eq("user_id", user.id)
    .eq("is_trashed", false);

  if (countError) {
    return errorResponse("Failed to load note counts", 500);
  }

  const noteCounts = new Map<string, number>();
  for (const row of noteRows ?? []) {
    const id = (row as { notebook_id: string | null }).notebook_id;
    if (!id) continue;
    noteCounts.set(id, (noteCounts.get(id) ?? 0) + 1);
  }

  const summaries: ExportNotebookSummary[] = (notebooks ?? []).map((nb) => ({
    id: nb.id,
    name: nb.name,
    noteCount: noteCounts.get(nb.id) ?? 0,
  }));

  const body: ExportNotebookListResponse = { notebooks: summaries };
  return NextResponse.json(body, { status: 200 });
}

export async function POST(request: NextRequest): Promise<Response> {
  const { data: auth, error: authError } = await getAuthenticatedUserFast(request);
  if (authError) return authError;
  const { supabase, user } = auth;

  let body: ExportEvernoteRequest;
  try {
    body = (await request.json()) as ExportEvernoteRequest;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const notebookIds = Array.isArray(body.notebookIds)
    ? body.notebookIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (notebookIds.length === 0) {
    return errorResponse("No notebooks selected", 400);
  }

  // Verify ownership of the selected notebooks. RLS would block reads from
  // foreign rows, but a missing/foreign id should surface as a clear 404 rather
  // than a silently empty export.
  const { data: notebooksRaw, error: nbError } = await supabase
    .from("notebooks")
    .select("id, name")
    .eq("user_id", user.id)
    .in("id", notebookIds);

  if (nbError) {
    return errorResponse("Failed to load notebooks", 500);
  }

  const notebooks: NotebookRow[] = notebooksRaw ?? [];
  if (notebooks.length === 0) {
    return errorResponse("No notebooks found", 404);
  }

  const ownedIds = notebooks.map((n) => n.id);
  const notebookNameById = new Map(notebooks.map((n) => [n.id, n.name]));

  const { data: notesRaw, error: notesError } = await supabase
    .from("notes")
    .select("id, notebook_id, title, content, created_at, updated_at")
    .eq("user_id", user.id)
    .eq("is_trashed", false)
    .in("notebook_id", ownedIds)
    .order("updated_at", { ascending: false });

  if (notesError) {
    return errorResponse("Failed to load notes", 500);
  }

  const notes: NoteRow[] = notesRaw ?? [];
  if (notes.length === 0) {
    return errorResponse("Selected notebooks contain no notes", 404);
  }

  if (notes.length > EXPORT_MAX_NOTES) {
    return errorResponse(
      `Export is limited to ${EXPORT_MAX_NOTES} notes per request; please select fewer notebooks.`,
      413,
    );
  }

  const noteIds = notes.map((n) => n.id);
  const { data: attachmentsRaw, error: attError } = await supabase
    .from("attachments")
    .select("id, note_id, file_name, file_path, file_size, mime_type")
    .eq("user_id", user.id)
    .in("note_id", noteIds);

  if (attError) {
    return errorResponse("Failed to load attachments", 500);
  }

  const attachments: AttachmentRow[] = attachmentsRaw ?? [];

  const totalAttachmentBytes = attachments.reduce((sum, a) => sum + (a.file_size ?? 0), 0);
  if (totalAttachmentBytes > EXPORT_MAX_TOTAL_BYTES) {
    const mb = Math.round(EXPORT_MAX_TOTAL_BYTES / (1024 * 1024));
    return errorResponse(
      `Selected attachments exceed the ${mb} MB export limit; please deselect heavier notebooks.`,
      413,
    );
  }

  const attachmentsByNote = new Map<string, AttachmentRow[]>();
  for (const attachment of attachments) {
    const list = attachmentsByNote.get(attachment.note_id) ?? [];
    list.push(attachment);
    attachmentsByNote.set(attachment.note_id, list);
  }

  const exportedNotes: ExportedNote[] = [];
  for (const note of notes) {
    const noteAttachments = attachmentsByNote.get(note.id) ?? [];
    const resources: ExportedResource[] = [];
    const mediaIndex: MediaIndex = new Map();

    for (const attachment of noteAttachments) {
      const resource = await loadAttachmentResource(supabase, attachment);
      if (!resource) continue;
      resources.push(resource);

      const entry: EnmlMediaEntry = { hash: resource.hash, mime: resource.mime };
      registerAttachmentUrls(mediaIndex, attachment, entry);
    }

    const blocks = parseNoteContent(note.content);
    const enmlContent = blocksToEnml(blocks, mediaIndex);

    exportedNotes.push({
      title: note.title,
      enmlContent,
      created: note.created_at,
      updated: note.updated_at,
      notebook: notebookNameById.get(note.notebook_id),
      resources,
    });
  }

  const xml = buildEnex({ notes: exportedNotes });
  const fileName = pickFileName(notebooks);

  return new NextResponse(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/enex+xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}

async function loadAttachmentResource(
  supabase: Supabase,
  attachment: AttachmentRow,
): Promise<ExportedResource | null> {
  const { data, error } = await supabase.storage.from(BUCKET_NAME).download(attachment.file_path);
  if (error || !data) return null;

  const buffer = Buffer.from(await data.arrayBuffer());
  const hash = createHash("md5").update(buffer).digest("hex");

  return {
    hash,
    mime: attachment.mime_type || "application/octet-stream",
    dataBase64: buffer.toString("base64"),
    fileName: attachment.file_name || "attachment",
    sourceUrl: `attachment://${attachment.file_path}`,
  };
}

function registerAttachmentUrls(
  mediaIndex: MediaIndex,
  attachment: AttachmentRow,
  entry: EnmlMediaEntry,
): void {
  // BlockNote blocks reference attachments through `attachment://<filePath>`
  // (canonical) or — for older content — through a signed URL whose path was
  // already migrated. We index by canonical URL plus file path; the converter
  // looks up `props.url` verbatim.
  mediaIndex.set(`attachment://${attachment.file_path}`, entry);
  mediaIndex.set(attachment.file_path, entry);
}

function parseNoteContent(content: unknown): BlockNoteBlock[] {
  if (!Array.isArray(content)) return [];
  // Note rows store BlockNote blocks as JSON; pass through, normalising only
  // shapes the converter actually consumes.
  return content.filter((b): b is BlockNoteBlock => isBlockLike(b));
}

function isBlockLike(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && type.length > 0;
}

function pickFileName(notebooks: NotebookRow[]): string {
  if (notebooks.length === 1) {
    const safe = notebooks[0].name.replace(SAFE_FILENAME_RE, "-").replace(/^-+|-+$/g, "");
    return `${safe || "drafto-export"}.enex`;
  }
  const today = new Date().toISOString().slice(0, 10);
  return `drafto-export-${today}.enex`;
}
