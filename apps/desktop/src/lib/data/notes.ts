import type { Json, NoteRow } from "@drafto/shared";

import { supabase } from "@/lib/supabase";

export async function getNote(id: string): Promise<NoteRow> {
  const { data, error } = await supabase
    .from("notes")
    .select("*")
    .eq("id", id)
    .single()
    .returns<NoteRow>();

  if (error) throw error;
  return data;
}

export async function getNotes(notebookId: string): Promise<NoteRow[]> {
  const { data, error } = await supabase
    .from("notes")
    .select("*")
    .eq("notebook_id", notebookId)
    .eq("is_trashed", false)
    .order("updated_at", { ascending: false })
    .returns<NoteRow[]>();

  if (error) throw error;
  return data;
}

export async function createNote(
  userId: string,
  notebookId: string,
  title?: string,
): Promise<NoteRow> {
  const { data, error } = await supabase
    .from("notes")
    .insert({
      user_id: userId,
      notebook_id: notebookId,
      title: title ?? "Untitled",
    })
    .select()
    .single()
    .returns<NoteRow>();

  if (error) throw error;
  return data;
}

export async function updateNote(
  id: string,
  fields: { title?: string; content?: Json | null },
): Promise<NoteRow> {
  const { data, error } = await supabase
    .from("notes")
    .update(fields)
    .eq("id", id)
    .select()
    .single()
    .returns<NoteRow>();

  if (error) throw error;
  return data;
}

export async function trashNote(id: string): Promise<NoteRow> {
  const { data, error } = await supabase
    .from("notes")
    .update({ is_trashed: true, trashed_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single()
    .returns<NoteRow>();

  if (error) throw error;
  return data;
}

export async function restoreNote(id: string): Promise<NoteRow> {
  const { data, error } = await supabase
    .from("notes")
    .update({ is_trashed: false, trashed_at: null })
    .eq("id", id)
    .select()
    .single()
    .returns<NoteRow>();

  if (error) throw error;
  return data;
}

export async function getTrashedNotes(): Promise<NoteRow[]> {
  const { data, error } = await supabase
    .from("notes")
    .select("*")
    .eq("is_trashed", true)
    .order("trashed_at", { ascending: false })
    .returns<NoteRow[]>();

  if (error) throw error;
  return data;
}

export async function deleteNotePermanent(id: string): Promise<void> {
  const { error } = await supabase.from("notes").delete().eq("id", id);

  if (error) throw error;
}
