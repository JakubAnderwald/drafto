import { appSchema, tableSchema } from "@nozbe/watermelondb";

export const notebooksTable = tableSchema({
  name: "notebooks",
  columns: [
    { name: "remote_id", type: "string" },
    { name: "user_id", type: "string" },
    { name: "name", type: "string" },
    { name: "created_at", type: "number" },
    { name: "updated_at", type: "number" },
  ],
});

export const notesTable = tableSchema({
  name: "notes",
  columns: [
    { name: "remote_id", type: "string" },
    { name: "notebook_id", type: "string", isIndexed: true },
    { name: "user_id", type: "string" },
    { name: "title", type: "string" },
    { name: "content", type: "string", isOptional: true },
    { name: "is_trashed", type: "boolean" },
    { name: "trashed_at", type: "number", isOptional: true },
    { name: "created_at", type: "number" },
    { name: "updated_at", type: "number" },
  ],
});

export const attachmentsTable = tableSchema({
  name: "attachments",
  columns: [
    { name: "remote_id", type: "string" },
    { name: "note_id", type: "string", isIndexed: true },
    { name: "user_id", type: "string" },
    { name: "file_name", type: "string" },
    { name: "file_path", type: "string" },
    { name: "file_size", type: "number" },
    { name: "mime_type", type: "string" },
    { name: "created_at", type: "number" },
    { name: "local_uri", type: "string", isOptional: true },
    { name: "upload_status", type: "string" },
    { name: "upload_error", type: "string", isOptional: true },
  ],
});

export const schema = appSchema({
  version: 3,
  tables: [notebooksTable, notesTable, attachmentsTable],
});
