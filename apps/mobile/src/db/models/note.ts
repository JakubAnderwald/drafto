import { Model } from "@nozbe/watermelondb";
import { field, date, readonly, children, relation } from "@nozbe/watermelondb/decorators";

export class Note extends Model {
  static table = "notes";

  static associations = {
    notebooks: { type: "belongs_to" as const, key: "notebook_id" },
    attachments: { type: "has_many" as const, foreignKey: "note_id" },
  };

  @field("remote_id") remoteId!: string;
  @field("notebook_id") notebookId!: string;
  @field("user_id") userId!: string;
  @field("title") title!: string;
  @field("content") content!: string | null;
  @field("is_trashed") isTrashed!: boolean;
  @date("trashed_at") trashedAt!: Date | null;
  @readonly @date("created_at") createdAt!: Date;
  @date("updated_at") updatedAt!: Date;

  @relation("notebooks", "notebook_id") notebook!: unknown;
  @children("attachments") attachments!: unknown;
}
