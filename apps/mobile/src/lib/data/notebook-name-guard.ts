import type { Database } from "@nozbe/watermelondb";
import { duplicateNotebookNameMessage, findDuplicateNotebook } from "@drafto/shared";

import type { Notebook } from "@/db";

/** Thrown from inside a writer when a notebook name is taken; its message is the shared copy. */
export class DuplicateNotebookNameError extends Error {
  constructor(existingName: string) {
    super(duplicateNotebookNameMessage(existingName));
    this.name = "DuplicateNotebookNameError";
  }
}

/**
 * Checks a notebook name against the notebooks stored right now (PrimeTestLab 11035 M-01,
 * ADR-0097). Call it inside the same `database.write` as the create or rename: WatermelonDB
 * runs writers one at a time, sync's included, so no other notebook can land between this
 * read and the write. The screen's own list check stays as the instant answer; this one
 * also covers a list that is still loading, a double submit and a notebook sync pulled in
 * meanwhile. Pass the renamed notebook's id as `excludeId` on a rename.
 * Mirrors apps/desktop/src/lib/data/notebook-name-guard.ts.
 */
export async function assertNotebookNameFree(
  database: Database,
  name: string,
  excludeId?: string,
): Promise<void> {
  const current = await database.get<Notebook>("notebooks").query().fetch();
  const duplicate = findDuplicateNotebook(name, current, excludeId);
  if (duplicate) throw new DuplicateNotebookNameError(duplicate.name);
}
