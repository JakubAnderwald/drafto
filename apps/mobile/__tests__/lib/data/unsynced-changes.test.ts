import { Q, type Database } from "@nozbe/watermelondb";

import { countUnsyncedChanges } from "@/lib/data/unsynced-changes";

interface FakeTable {
  /** Rows with `_status` created or updated. */
  changed?: number;
  /** Ids of rows marked deleted. */
  deleted?: string[];
  /** Synced attachment rows whose file has not uploaded. */
  unuploaded?: number;
}

const CHANGED_QUERY = [Q.where("_status", Q.oneOf(["created", "updated"]))];
const UNUPLOADED_QUERY = [
  Q.where("upload_status", Q.oneOf(["pending", "failed"])),
  Q.where("_status", "synced"),
];

/** A database stand-in that answers the counter's queries, per table, by their clauses. */
function fakeDatabase(tables: Record<string, FakeTable>) {
  const queries: Array<{ table: string; clauses: unknown[] }> = [];
  const get = jest.fn((table: string) => ({
    query: (...clauses: unknown[]) => {
      queries.push({ table, clauses });
      const isUploadQuery = JSON.stringify(clauses) === JSON.stringify(UNUPLOADED_QUERY);
      const count = isUploadQuery ? tables[table]?.unuploaded : tables[table]?.changed;
      return { fetchCount: () => Promise.resolve(count ?? 0) };
    },
  }));
  const getDeletedRecords = jest.fn((table: string) =>
    Promise.resolve(tables[table]?.deleted ?? []),
  );
  return {
    database: { get, adapter: { getDeletedRecords } } as unknown as Database,
    queries,
    getDeletedRecords,
  };
}

describe("countUnsyncedChanges", () => {
  it("is zero when everything is synced", async () => {
    const { database } = fakeDatabase({});

    await expect(countUnsyncedChanges(database)).resolves.toBe(0);
  });

  it("adds changed rows, pending deletions and un-uploaded attachment files", async () => {
    const { database, getDeletedRecords } = fakeDatabase({
      notebooks: { changed: 1 },
      notes: { changed: 2, deleted: ["note-gone"] },
      attachments: { changed: 0, deleted: ["a1", "a2"], unuploaded: 3 },
    });

    await expect(countUnsyncedChanges(database)).resolves.toBe(9);
    expect(getDeletedRecords.mock.calls.map(([table]) => table)).toEqual([
      "notebooks",
      "notes",
      "attachments",
    ]);
  });

  it("asks each table only for rows that sync has not pushed", async () => {
    const { database, queries } = fakeDatabase({});

    await countUnsyncedChanges(database);

    for (const table of ["notebooks", "notes", "attachments"]) {
      expect(queries).toContainEqual({ table, clauses: CHANGED_QUERY });
    }
  });

  it("counts an attachment whose row synced but whose file never uploaded", async () => {
    // Sign-out deletes local files; for such an attachment that is the only copy.
    const { database, queries } = fakeDatabase({ attachments: { unuploaded: 1 } });

    await expect(countUnsyncedChanges(database)).resolves.toBe(1);
    // Synced rows only, so a created row with a pending upload is not counted twice.
    expect(queries).toContainEqual({ table: "attachments", clauses: UNUPLOADED_QUERY });
  });

  it("counts a pending deletion on its own, which a plain query would hide", async () => {
    const { database } = fakeDatabase({ notes: { deleted: ["note-gone"] } });

    await expect(countUnsyncedChanges(database)).resolves.toBe(1);
  });
});
