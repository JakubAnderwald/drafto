import { Model } from "@nozbe/watermelondb";
import { field, date, readonly, relation } from "@nozbe/watermelondb/decorators";

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

  @relation("notes", "note_id") note!: unknown;
}
