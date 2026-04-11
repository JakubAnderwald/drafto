import { blockNoteToMarkdown, markdownToBlockNote, contentToBlocknote } from "@drafto/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";

interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export async function listNotebooks(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<ToolResult> {
  const { data, error } = await supabase
    .from("notebooks")
    .select("id, name, created_at, updated_at")
    .eq("user_id", userId)
    .order("name");

  if (error) return err(`Error: ${error.message}`);
  return ok(JSON.stringify(data, null, 2));
}

export async function listNotes(
  supabase: SupabaseClient<Database>,
  userId: string,
  notebookId: string,
): Promise<ToolResult> {
  const { data, error } = await supabase
    .from("notes")
    .select("id, title, created_at, updated_at")
    .eq("notebook_id", notebookId)
    .eq("user_id", userId)
    .eq("is_trashed", false)
    .order("updated_at", { ascending: false });

  if (error) return err(`Error: ${error.message}`);
  return ok(JSON.stringify(data, null, 2));
}

export async function readNote(
  supabase: SupabaseClient<Database>,
  userId: string,
  noteId: string,
): Promise<ToolResult> {
  const { data: note, error } = await supabase
    .from("notes")
    .select("id, title, content, notebook_id, is_trashed, created_at, updated_at")
    .eq("id", noteId)
    .eq("user_id", userId)
    .single();

  if (error || !note) return err("Error: Note not found");

  const { data: notebook } = await supabase
    .from("notebooks")
    .select("name")
    .eq("id", note.notebook_id)
    .single();

  const blocks = contentToBlocknote(note.content);
  const contentMarkdown = blockNoteToMarkdown(blocks);

  const header = [
    `# ${note.title}`,
    ``,
    `- **Notebook**: ${notebook?.name ?? "Unknown"}`,
    `- **Created**: ${note.created_at}`,
    `- **Updated**: ${note.updated_at}`,
    `- **Trashed**: ${note.is_trashed ? "Yes" : "No"}`,
    ``,
    `---`,
    ``,
  ].join("\n");

  return ok(header + contentMarkdown);
}

export async function searchNotes(
  supabase: SupabaseClient<Database>,
  userId: string,
  query: string,
): Promise<ToolResult> {
  const { data, error } = await supabase.rpc(
    "search_notes" as never,
    {
      search_query: query,
      requesting_user_id: userId,
    } as never,
  );

  if (error) return err(`Error: ${error.message}`);
  return ok(JSON.stringify(data, null, 2));
}

export async function createNotebook(
  supabase: SupabaseClient<Database>,
  userId: string,
  name: string,
): Promise<ToolResult> {
  const { data, error } = await supabase
    .from("notebooks")
    .insert({ user_id: userId, name: name.trim() })
    .select("id, name")
    .single();

  if (error) return err(`Error: ${error.message}`);
  return ok(JSON.stringify(data, null, 2));
}

export async function createNote(
  supabase: SupabaseClient<Database>,
  userId: string,
  notebookId: string,
  title: string,
  contentMarkdown?: string,
): Promise<ToolResult> {
  const { data: notebook, error: nbError } = await supabase
    .from("notebooks")
    .select("id")
    .eq("id", notebookId)
    .eq("user_id", userId)
    .single();

  if (nbError || !notebook) return err("Error: Notebook not found");

  const content = contentMarkdown
    ? (markdownToBlockNote(contentMarkdown) as unknown as Json)
    : null;

  const { data: note, error } = await supabase
    .from("notes")
    .insert({ notebook_id: notebookId, user_id: userId, title: title.trim(), content })
    .select("id, title")
    .single();

  if (error) return err(`Error: ${error.message}`);
  return ok(JSON.stringify(note, null, 2));
}

export async function updateNote(
  supabase: SupabaseClient<Database>,
  userId: string,
  noteId: string,
  title?: string,
  contentMarkdown?: string,
): Promise<ToolResult> {
  const update: Record<string, unknown> = {};
  if (title !== undefined) update.title = title.trim();
  if (contentMarkdown !== undefined)
    update.content = markdownToBlockNote(contentMarkdown) as unknown as Json;

  if (Object.keys(update).length === 0) return err("Error: No fields to update");

  const { data, error } = await supabase
    .from("notes")
    .update(update)
    .eq("id", noteId)
    .eq("user_id", userId)
    .select("id, title, updated_at")
    .single();

  if (error) return err(`Error: ${error.message}`);
  return ok(JSON.stringify(data, null, 2));
}

export async function moveNote(
  supabase: SupabaseClient<Database>,
  userId: string,
  noteId: string,
  notebookId: string,
): Promise<ToolResult> {
  const { data: notebook, error: nbError } = await supabase
    .from("notebooks")
    .select("id")
    .eq("id", notebookId)
    .eq("user_id", userId)
    .single();

  if (nbError || !notebook) return err("Error: Target notebook not found");

  const { data, error } = await supabase
    .from("notes")
    .update({ notebook_id: notebookId })
    .eq("id", noteId)
    .eq("user_id", userId)
    .select("id, title, notebook_id")
    .single();

  if (error) return err(`Error: ${error.message}`);
  return ok(JSON.stringify(data, null, 2));
}

export async function trashNote(
  supabase: SupabaseClient<Database>,
  userId: string,
  noteId: string,
): Promise<ToolResult> {
  const { data, error } = await supabase
    .from("notes")
    .update({ is_trashed: true, trashed_at: new Date().toISOString() })
    .eq("id", noteId)
    .eq("user_id", userId)
    .select("id, title")
    .single();

  if (error) return err(`Error: ${error.message}`);
  return ok(`Note "${data.title}" moved to trash.`);
}
