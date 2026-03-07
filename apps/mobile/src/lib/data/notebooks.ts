import type { NotebookRow } from "@drafto/shared";

import { supabase } from "../supabase";

export async function getNotebooks(): Promise<NotebookRow[]> {
  const { data, error } = await supabase
    .from("notebooks")
    .select("*")
    .order("updated_at", { ascending: false })
    .returns<NotebookRow[]>();

  if (error) throw error;
  return data;
}

export async function createNotebook(userId: string, name: string): Promise<NotebookRow> {
  const { data, error } = await supabase
    .from("notebooks")
    .insert({ user_id: userId, name })
    .select()
    .single()
    .returns<NotebookRow>();

  if (error) throw error;
  return data;
}

export async function updateNotebook(id: string, name: string): Promise<NotebookRow> {
  const { data, error } = await supabase
    .from("notebooks")
    .update({ name })
    .eq("id", id)
    .select()
    .single()
    .returns<NotebookRow>();

  if (error) throw error;
  return data;
}

export async function deleteNotebook(id: string): Promise<void> {
  const { error } = await supabase.from("notebooks").delete().eq("id", id);

  if (error) throw error;
}
