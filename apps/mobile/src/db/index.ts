import { Database } from "@nozbe/watermelondb";
import SQLiteAdapter from "@nozbe/watermelondb/adapters/sqlite";

import { schema } from "./schema";
import { Notebook } from "./models/notebook";
import { Note } from "./models/note";
import { Attachment } from "./models/attachment";

const adapter = new SQLiteAdapter({
  schema,
  jsi: true,
  onSetUpError: (error) => {
    console.error("WatermelonDB setup error:", error);
  },
});

export const database = new Database({
  adapter,
  modelClasses: [Notebook, Note, Attachment],
});

export { Notebook, Note, Attachment };
