import { Model, Query } from "@nozbe/watermelondb";
import { field, date, readonly, children } from "@nozbe/watermelondb/decorators";

import type { Note } from "./note";

export class Notebook extends Model {
  static table = "notebooks";

  static associations = {
    notes: { type: "has_many" as const, foreignKey: "notebook_id" },
  };

  @field("remote_id") remoteId!: string;
  @field("user_id") userId!: string;
  @field("name") name!: string;
  @readonly @date("created_at") createdAt!: Date;
  @date("updated_at") updatedAt!: Date;

  @children("notes") notes!: Query<Note>;
}
