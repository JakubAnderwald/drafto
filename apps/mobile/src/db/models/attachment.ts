import { Model, Relation } from "@nozbe/watermelondb";
import { field, date, readonly, relation } from "@nozbe/watermelondb/decorators";

import type { Note } from "./note";

// "quota_exceeded" is terminal: the server refused the upload for the user's storage
// quota (issue #794). It is a plain string column, so no schema migration; the upload
// queue only retries "pending" / "failed", and sync pushes only "uploaded".
export type UploadStatus = "pending" | "uploaded" | "failed" | "quota_exceeded";

export class Attachment extends Model {
  static table = "attachments";

  static associations = {
    notes: { type: "belongs_to" as const, key: "note_id" },
  };

  @field("remote_id") remoteId!: string;
  @field("note_id") noteId!: string;
  @field("user_id") userId!: string;
  @field("file_name") fileName!: string;
  @field("file_path") filePath!: string;
  @field("file_size") fileSize!: number;
  @field("mime_type") mimeType!: string;
  @readonly @date("created_at") createdAt!: Date;
  @field("local_uri") localUri!: string | null;
  @field("upload_status") uploadStatus!: UploadStatus;
  @field("upload_error") uploadError!: string | null;

  @relation("notes", "note_id") note!: Relation<Note>;

  get isPendingUpload(): boolean {
    return this.uploadStatus === "pending";
  }

  get hasFailed(): boolean {
    return this.uploadStatus === "failed";
  }

  get isStorageFull(): boolean {
    return this.uploadStatus === "quota_exceeded";
  }
}
