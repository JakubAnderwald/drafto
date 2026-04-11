import type { Database } from "./database";

export type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"];
export type NotebookRow = Database["public"]["Tables"]["notebooks"]["Row"];
export type NoteRow = Database["public"]["Tables"]["notes"]["Row"];
export type AttachmentRow = Database["public"]["Tables"]["attachments"]["Row"];
export type ApiKeyRow = Database["public"]["Tables"]["api_keys"]["Row"];

export type NotebookInsert = Database["public"]["Tables"]["notebooks"]["Insert"];
export type NoteInsert = Database["public"]["Tables"]["notes"]["Insert"];
export type AttachmentInsert = Database["public"]["Tables"]["attachments"]["Insert"];

export type NotebookUpdate = Database["public"]["Tables"]["notebooks"]["Update"];
export type NoteUpdate = Database["public"]["Tables"]["notes"]["Update"];
