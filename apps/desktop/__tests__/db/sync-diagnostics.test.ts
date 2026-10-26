/**
 * Runs the real WatermelonDB synchronize() over an in-memory LokiJS database,
 * with only Supabase mocked. The other sync tests mock synchronize() and can
 * only imitate what it passes in (a first sync gets `lastPulledAt: null`) and
 * what it logs. Here WatermelonDB itself decides, and a pull must not make it
 * log a `[Sync]` diagnostic (#678).
 */
const mockSupabaseFrom = jest.fn();
const mockSupabaseRpc = jest.fn();
const mockGetSession = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
    rpc: (...args: unknown[]) => mockSupabaseRpc(...args),
    auth: { getSession: (...args: unknown[]) => mockGetSession(...args) },
  },
}));

import { Database } from "@nozbe/watermelondb";
import LokiJSAdapter from "@nozbe/watermelondb/adapters/lokijs";
import { synchronize } from "@nozbe/watermelondb/sync";

import { migrations } from "@/db/migrations";
import { Attachment } from "@/db/models/attachment";
import { Note } from "@/db/models/note";
import { Notebook } from "@/db/models/notebook";
import { schema } from "@/db/schema";
import { resetSyncState, syncDatabase } from "@/db/sync";

type SyncTable = "notebooks" | "notes" | "attachments";
type ServerRow = { id: string } & Record<string, unknown>;

const USER_ID = "user-1";
const FIRST_SERVER_TIME = "2025-06-10T00:00:00.000Z";
const LATER = "2025-06-11T09:00:00.000Z";
const SECOND_SERVER_TIME = "2025-06-12T00:00:00.000Z";

function notebookRow(id: string, name: string, at: string): ServerRow {
  return { id, user_id: USER_ID, name, created_at: at, updated_at: at };
}

function noteRow(id: string, title: string, at: string): ServerRow {
  return {
    id,
    notebook_id: "nb-1",
    user_id: USER_ID,
    title,
    content: { type: "doc", content: [{ type: "paragraph" }] },
    is_trashed: false,
    trashed_at: null,
    created_at: "2025-06-01T12:00:00.000Z",
    updated_at: at,
  };
}

function attachmentRow(id: string, at: string): ServerRow {
  return {
    id,
    note_id: "note-1",
    user_id: USER_ID,
    file_name: `${id}.png`,
    file_path: `${USER_ID}/note-1/${id}.png`,
    file_size: 100,
    mime_type: "image/png",
    created_at: at,
  };
}

let dbCount = 0;

function makeDatabase(): Database {
  dbCount += 1;
  const adapter = new LokiJSAdapter({
    schema,
    migrations,
    dbName: `sync-diagnostics-${dbCount}`,
    useWebWorker: false,
    // Jest has no IndexedDB, so the adapter falls back to an in-memory store.
    useIncrementalIndexedDB: true,
    // Loki's autosave timer would keep Jest from exiting.
    extraLokiOptions: { autosave: false },
  });
  return new Database({ adapter, modelClasses: [Notebook, Note, Attachment] });
}

let server: Record<SyncTable, ServerRow[]>;
let serverTime: string;
/** Every `select()` the sync made, as `<table>:<columns>`. */
let selects: string[];
/** Every cursor filter the pull applied, as `<table>.<column>`. */
let cursors: string[];

/** Answers Supabase reads from `server`, as PostgREST would. */
function mockServer() {
  mockSupabaseFrom.mockImplementation((table: SyncTable) => ({
    select: (columns: string) => {
      selects.push(`${table}:${columns}`);
      const rows = columns === "id" ? server[table].map(({ id }) => ({ id })) : server[table];
      const all = Promise.resolve({ data: rows, error: null });
      return Object.assign(all, {
        gt: (column: string, iso: string) => {
          cursors.push(`${table}.${column}`);
          const since = Date.parse(iso);
          const changed = rows.filter((row) => Date.parse(row[column] as string) > since);
          return Promise.resolve({ data: changed, error: null });
        },
      });
    },
  }));
  mockSupabaseRpc.mockImplementation(() => Promise.resolve({ data: serverTime, error: null }));
}

let errorSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

/** What WatermelonDB logged through `console.error` with a `[Sync]` prefix. */
function syncDiagnostics(): string[] {
  // WatermelonDB logs an Error object, not a string; String() keeps its message.
  return errorSpy.mock.calls
    .map((args: unknown[]) => args.map(String).join(" "))
    .filter((message: string) => message.includes("[Sync]"));
}

beforeEach(() => {
  jest.clearAllMocks();
  resetSyncState();
  server = {
    notebooks: [notebookRow("nb-1", "Work", "2025-06-02T14:30:00.000Z")],
    notes: [
      noteRow("note-1", "Groceries", "2025-06-02T14:30:00.000Z"),
      noteRow("note-2", "Ideas", "2025-06-03T08:00:00.000Z"),
    ],
    attachments: [attachmentRow("att-1", "2025-06-02T15:00:00.000Z")],
  };
  serverTime = FIRST_SERVER_TIME;
  selects = [];
  cursors = [];
  mockServer();
  mockGetSession.mockResolvedValue({ data: { session: { access_token: "token" } }, error: null });
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  // Loki logs its set-up steps through console.log.
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

describe("WatermelonDB sync diagnostics", () => {
  it("logs none on the first sync of a fresh database", async () => {
    const db = makeDatabase();

    const result = await syncDatabase(db);

    expect(syncDiagnostics()).toEqual([]);
    expect(await db.get<Notebook>("notebooks").find("nb-1")).toMatchObject({ name: "Work" });
    expect(await db.get<Note>("notes").query().fetchCount()).toBe(2);
    expect(await db.get<Attachment>("attachments").query().fetchCount()).toBe(1);
    expect(result.remoteChangeCount).toBe(0);
  });

  it("pulls every row without a cursor and skips deletion detection on a first sync", async () => {
    await syncDatabase(makeDatabase());

    expect(cursors).toEqual([]);
    expect(selects.sort()).toEqual(["attachments:*", "notebooks:*", "notes:*"]);
  });

  it("logs none on an incremental sync that pulls a note created on another device", async () => {
    const db = makeDatabase();
    await syncDatabase(db);

    // Another device adds a note and renames an existing one.
    server.notes = [
      { ...server.notes[0], title: "Shopping", updated_at: LATER },
      server.notes[1],
      noteRow("note-3", "From my phone", LATER),
    ];
    serverTime = SECOND_SERVER_TIME;
    selects = [];

    const result = await syncDatabase(db);

    expect(syncDiagnostics()).toEqual([]);
    expect(cursors).toEqual(["notebooks.updated_at", "notes.updated_at", "attachments.created_at"]);
    // An incremental sync runs deletion detection.
    expect(selects.filter((select) => select.endsWith(":id")).sort()).toEqual([
      "attachments:id",
      "notebooks:id",
      "notes:id",
    ]);
    const notes = db.get<Note>("notes");
    expect(await notes.find("note-3")).toMatchObject({ title: "From my phone" });
    expect(await notes.find("note-1")).toMatchObject({ title: "Shopping" });
    expect(await notes.query().fetchCount()).toBe(3);
    // The rename is the only change the user can see; a new note isn't one.
    expect(result.remoteChangeCount).toBe(1);
  });

  it("would catch the diagnostic: an `updated` record missing locally, without the flag", async () => {
    // Control for the tests above: the same kind of pull, but through a bare
    // synchronize() without `sendCreatedAsUpdated`, makes WatermelonDB log.
    const db = makeDatabase();
    const empty = { created: [], updated: [], deleted: [] };
    const raw = {
      id: "nb-9",
      remote_id: "nb-9",
      user_id: USER_ID,
      name: "Elsewhere",
      created_at: 1,
      updated_at: 1,
    };

    await synchronize({
      database: db,
      pullChanges: async () => ({
        changes: { notebooks: { ...empty, updated: [raw] }, notes: empty, attachments: empty },
        timestamp: 1,
      }),
    });

    expect(syncDiagnostics()).toEqual([
      expect.stringContaining(
        "[Sync] Server wants client to update record notebooks#nb-9, but it doesn't exist locally",
      ),
    ]);
  });
});
