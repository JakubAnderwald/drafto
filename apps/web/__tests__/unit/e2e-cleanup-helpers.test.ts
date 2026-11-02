/**
 * @vitest-environment node
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@drafto/shared";
import {
  DELETE_CHUNK_SIZE,
  deleteNotebooksById,
  deleteNotesById,
  purgeStaleE2EData,
} from "../../e2e/helpers/cleanup";
import {
  CreatedDataTracker,
  classifyCreateCall,
  createdIdsFrom,
  type TrackedRequest,
  type TrackedResponse,
} from "../../e2e/helpers/created-data-tracker";
import {
  PRODUCTION_PROJECT_REF,
  SIGN_IN_RETRY_MS,
  assertNotProduction,
  lazyE2ESession,
  signInAsE2EUser,
  signOutE2EUser,
  type E2ESession,
} from "../../e2e/helpers/e2e-supabase";
import {
  clearRunNotebooks,
  readRunNotebooks,
  recordRunNotebook,
  recordRunNotebooks,
} from "../../e2e/helpers/run-notebooks";

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: createClientMock }));

// ---------------------------------------------------------------------------
// An in-memory stand-in for the slice of supabase-js the cleanup uses
// ---------------------------------------------------------------------------

type Row = Record<string, string>;
type TableName = "notebooks" | "notes";
type FakeResult = { data: Row[] | null; error: { message: string } | null };

interface FakeCall {
  table: TableName;
  op: "select" | "delete";
  columns: string[];
  inSize?: number;
}

class FakeDb {
  readonly tables: Record<TableName, Row[]> = { notebooks: [], notes: [] };
  readonly calls: FakeCall[] = [];
  /** PostgREST's max_rows: no response holds more rows than this. */
  maxRows = 1000;
  failOn: (call: FakeCall) => string | null = () => null;
  afterCall: (call: FakeCall) => void = () => {};

  client(): SupabaseClient<Database> {
    const fake = { from: (table: TableName) => new FakeQuery(this, table) };
    return fake as unknown as SupabaseClient<Database>;
  }
}

class FakeQuery implements PromiseLike<FakeResult> {
  private op: "select" | "delete" = "select";
  private columns: string[] = [];
  private readonly filters: Array<(row: Row) => boolean> = [];
  private orderColumn?: string;
  private max = Infinity;
  private inSize?: number;

  constructor(
    private readonly db: FakeDb,
    private readonly table: TableName,
  ) {}

  select(columns: string): this {
    this.columns = columns.split(",").map((column) => column.trim());
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  eq(column: string, value: string): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: string[]): this {
    this.inSize = values.length;
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  gt(column: string, value: string): this {
    this.filters.push((row) => row[column] > value);
    return this;
  }
  gte(column: string, value: string): this {
    this.filters.push((row) => row[column] >= value);
    return this;
  }
  lt(column: string, value: string): this {
    this.filters.push((row) => row[column] < value);
    return this;
  }
  order(column: string): this {
    this.orderColumn = column;
    return this;
  }
  limit(count: number): this {
    this.max = count;
    return this;
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }

  private execute(): FakeResult {
    const call: FakeCall = {
      table: this.table,
      op: this.op,
      columns: this.columns,
      inSize: this.inSize,
    };
    this.db.calls.push(call);
    const failure = this.db.failOn(call);
    if (failure) return { data: null, error: { message: failure } };

    const table = this.db.tables[this.table];
    let rows = table.filter((row) => this.filters.every((matches) => matches(row)));
    if (this.op === "delete") {
      const ids = new Set(rows.map((row) => row.id));
      this.db.tables[this.table] = table.filter((row) => !ids.has(row.id));
      if (this.table === "notebooks") {
        this.db.tables.notes = this.db.tables.notes.filter((note) => !ids.has(note.notebook_id));
      }
    } else {
      const column = this.orderColumn;
      if (column) rows = [...rows].sort((a, b) => a[column].localeCompare(b[column]));
      rows = rows.slice(0, Math.min(this.max, this.db.maxRows));
    }
    const data = rows.map((row) => Object.fromEntries(this.columns.map((c) => [c, row[c]])));
    this.db.afterCall(call);
    return { data, error: null };
  }
}

const USER = "user-e2e";
const NOW = new Date("2026-10-20T12:00:00.000Z");
const OLD = new Date("2026-10-18T12:00:00.000Z").toISOString();
const RECENT = new Date("2026-10-20T11:00:00.000Z").toISOString();
const MS = "1760000000000";

function session(db: FakeDb): E2ESession {
  return { client: db.client(), userId: USER };
}

function id(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(5, "0")}`;
}

function addNotebook(db: FakeDb, notebookId: string, name: string, updatedAt: string, user = USER) {
  db.tables.notebooks.push({ id: notebookId, user_id: user, name, updated_at: updatedAt });
}

function addNote(
  db: FakeDb,
  noteId: string,
  notebookId: string,
  title: string,
  updatedAt: string,
  user = USER,
) {
  db.tables.notes.push({
    id: noteId,
    user_id: user,
    notebook_id: notebookId,
    title,
    updated_at: updatedAt,
  });
}

function ids(rows: Row[]): string[] {
  return rows.map((row) => row.id).sort();
}

// ---------------------------------------------------------------------------
// purgeStaleE2EData / deleteNotesById / deleteNotebooksById
// ---------------------------------------------------------------------------

describe("purgeStaleE2EData", () => {
  it("purges a backlog bigger than PostgREST's row cap, in chunks", async () => {
    const db = new FakeDb();
    for (let n = 0; n < 2500; n++) addNotebook(db, id("nb", n), `Target ${MS}`, OLD);

    const report = await purgeStaleE2EData(session(db), NOW);

    expect(db.tables.notebooks).toEqual([]);
    expect(report.notebooks).toEqual({ scanned: 2500, purged: 2500, kept: 0 });
    const deletes = db.calls.filter((call) => call.op === "delete");
    expect(deletes).toHaveLength(2500 / DELETE_CHUNK_SIZE);
    expect(Math.max(...deletes.map((call) => call.inSize ?? 0))).toBe(DELETE_CHUNK_SIZE);
  });

  it("deletes only stale E2E-named rows, and keeps live notebooks and other data", async () => {
    const db = new FakeDb();
    addNotebook(db, "seed", "Notes", OLD);
    addNotebook(db, "nb-stale", `Export NB ${MS}`, OLD);
    addNotebook(db, "nb-fresh", `Target ${MS}`, RECENT);
    addNotebook(db, "nb-live-note", `XPlat NB ${MS}`, OLD);
    addNotebook(db, "nb-other-user", `Target ${MS}`, OLD, "someone-else");
    addNote(db, "n-in-stale", "nb-stale", "Untitled", OLD);
    addNote(db, "n-live", "nb-live-note", "Untitled", RECENT);
    addNote(db, "n-stale-e2e", "seed", `E2E Test Note ${MS}`, OLD);
    addNote(db, "n-fresh-e2e", "seed", `Move Me ${MS}`, RECENT);
    addNote(db, "n-user", "seed", "Shopping list", OLD);

    const report = await purgeStaleE2EData(session(db), NOW);

    expect(ids(db.tables.notebooks)).toEqual(["nb-fresh", "nb-live-note", "nb-other-user", "seed"]);
    expect(ids(db.tables.notes)).toEqual(["n-fresh-e2e", "n-live", "n-user"]);
    expect(report).toEqual({
      cutoff: "2026-10-19T12:00:00.000Z",
      notebooks: { scanned: 4, purged: 1, kept: 2 },
      notes: { scanned: 5, purged: 2, kept: 1 },
    });
  });

  it("keeps a notebook that gets a new note between the scan and the delete", async () => {
    const db = new FakeDb();
    addNotebook(db, "nb", `Target ${MS}`, OLD);
    db.afterCall = (call) => {
      // Another run writes a note into the notebook right after the note scan.
      if (call.table === "notes" && call.op === "select" && call.columns.includes("title")) {
        db.afterCall = () => {};
        addNote(db, "n-new", "nb", "Untitled", RECENT);
      }
    };

    const report = await purgeStaleE2EData(session(db), NOW);

    expect(ids(db.tables.notebooks)).toEqual(["nb"]);
    expect(report.notebooks.purged).toBe(0);
  });

  it("fails loudly when a list query errors", async () => {
    const db = new FakeDb();
    db.failOn = (call) => (call.table === "notebooks" && call.op === "select" ? "boom" : null);

    await expect(purgeStaleE2EData(session(db), NOW)).rejects.toThrow(
      "E2E purge could not list notebooks: boom",
    );
  });

  it("fails loudly when the live-note check errors", async () => {
    const db = new FakeDb();
    addNotebook(db, "nb", `Target ${MS}`, OLD);
    // The check selects only `notebook_id`; the scan before it selects more columns.
    db.failOn = (call) =>
      call.table === "notes" && call.op === "select" && call.columns.join() === "notebook_id"
        ? "timeout"
        : null;

    await expect(purgeStaleE2EData(session(db), NOW)).rejects.toThrow(
      "E2E purge could not check the notes in stale notebooks: timeout",
    );
  });

  it("fails loudly when a delete errors", async () => {
    const db = new FakeDb();
    addNote(db, "n", "seed", `Trash Test ${MS}`, OLD);
    db.failOn = (call) => (call.op === "delete" ? "statement timeout" : null);

    await expect(purgeStaleE2EData(session(db), NOW)).rejects.toThrow(
      "E2E purge could not delete stale notes: statement timeout",
    );
  });

  it("fails loudly when a notebook delete errors", async () => {
    const db = new FakeDb();
    addNotebook(db, "nb", `Target ${MS}`, OLD);
    db.failOn = (call) => (call.op === "delete" ? "statement timeout" : null);

    await expect(purgeStaleE2EData(session(db), NOW)).rejects.toThrow(
      "E2E purge could not delete stale notebooks: statement timeout",
    );
  });
});

describe("deleteNotesById / deleteNotebooksById", () => {
  it("deletes the E2E user's rows by id, in chunks, counting only rows that existed", async () => {
    const db = new FakeDb();
    const noteIds = Array.from({ length: 250 }, (_, n) => id("n", n));
    for (const noteId of noteIds) addNote(db, noteId, "nb", "Untitled", RECENT);
    addNote(db, "n-other", "nb", "Untitled", RECENT, "someone-else");

    const result = await deleteNotesById(session(db), [
      ...noteIds,
      noteIds[0],
      "n-gone",
      "n-other",
    ]);

    expect(result).toEqual({ deleted: 250, failed: [], errors: [] });
    expect(ids(db.tables.notes)).toEqual(["n-other"]);
    expect(db.calls.map((call) => call.inSize)).toEqual([100, 100, 52]);
  });

  it("cascades a notebook delete to its notes", async () => {
    const db = new FakeDb();
    addNotebook(db, "nb", `Target ${MS}`, RECENT);
    addNotebook(db, "keep", "Notes", RECENT);
    addNote(db, "n", "nb", "Untitled", RECENT);

    const result = await deleteNotebooksById(session(db), ["nb", "nb-already-deleted"]);

    expect(result).toEqual({ deleted: 1, failed: [], errors: [] });
    expect(ids(db.tables.notebooks)).toEqual(["keep"]);
    expect(db.tables.notes).toEqual([]);
  });

  it("reports the ids of a chunk whose delete failed and carries on", async () => {
    const db = new FakeDb();
    const noteIds = Array.from({ length: 150 }, (_, n) => id("n", n));
    for (const noteId of noteIds) addNote(db, noteId, "nb", "Untitled", RECENT);
    let calls = 0;
    db.failOn = () => (calls++ === 0 ? "network down" : null);

    const result = await deleteNotesById(session(db), noteIds);

    expect(result.deleted).toBe(50);
    expect(result.failed).toEqual(noteIds.slice(0, 100));
    expect(result.errors).toEqual(["network down"]);
  });

  it("makes no request when there is nothing to delete", async () => {
    const db = new FakeDb();

    expect(await deleteNotebooksById(session(db), [])).toEqual({
      deleted: 0,
      failed: [],
      errors: [],
    });
    expect(db.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// created-data-tracker
// ---------------------------------------------------------------------------

const ORIGIN = "http://localhost:3000";

describe("classifyCreateCall", () => {
  it("recognises the app's create endpoints", () => {
    expect(classifyCreateCall("POST", `${ORIGIN}/api/notebooks`, '{"name":"x"}')).toBe("notebook");
    expect(classifyCreateCall("POST", `${ORIGIN}/api/notebooks?x=1`, null)).toBe("notebook");
    expect(classifyCreateCall("POST", `${ORIGIN}/api/notebooks/abc/notes`, null)).toBe("note");
    expect(classifyCreateCall("POST", `${ORIGIN}/api/import/evernote/note`, '{"title":"t"}')).toBe(
      "import-new-notebook",
    );
    expect(
      classifyCreateCall("POST", `${ORIGIN}/api/import/evernote/note`, '{"notebookId":"nb"}'),
    ).toBe("import-into-notebook");
  });

  it("treats an import call without a readable notebookId as creating the notebook", () => {
    const url = `${ORIGIN}/api/import/evernote/note`;
    expect(classifyCreateCall("POST", url, null)).toBe("import-new-notebook");
    expect(classifyCreateCall("POST", url, "not json")).toBe("import-new-notebook");
    expect(classifyCreateCall("POST", url, '{"notebookId":""}')).toBe("import-new-notebook");
    expect(classifyCreateCall("POST", url, "null")).toBe("import-new-notebook");
  });

  it("ignores reads, updates, other paths and unparseable URLs", () => {
    expect(classifyCreateCall("GET", `${ORIGIN}/api/notebooks`, null)).toBeNull();
    expect(classifyCreateCall("PATCH", `${ORIGIN}/api/notebooks/abc`, null)).toBeNull();
    expect(classifyCreateCall("POST", `${ORIGIN}/api/notebooks/abc`, null)).toBeNull();
    expect(classifyCreateCall("POST", `${ORIGIN}/api/notes/abc/attachments`, null)).toBeNull();
    expect(classifyCreateCall("POST", `${ORIGIN}/api/import/evernote/finalize`, null)).toBeNull();
    expect(classifyCreateCall("POST", "not a url", null)).toBeNull();
  });
});

describe("createdIdsFrom", () => {
  it("reads the ids each endpoint returns", () => {
    expect(createdIdsFrom("notebook", { id: "nb" })).toEqual({ notebookId: "nb" });
    expect(createdIdsFrom("note", { id: "n" })).toEqual({ noteId: "n" });
    expect(createdIdsFrom("import-new-notebook", { notebookId: "nb", noteId: "n" })).toEqual({
      notebookId: "nb",
      noteId: "n",
    });
    // A call into an existing notebook didn't create it.
    expect(createdIdsFrom("import-into-notebook", { notebookId: "nb", noteId: "n" })).toEqual({
      noteId: "n",
    });
  });

  it("returns nothing for a body without ids", () => {
    expect(createdIdsFrom("notebook", null)).toEqual({});
    expect(createdIdsFrom("notebook", "oops")).toEqual({});
    expect(createdIdsFrom("note", { id: 42 })).toEqual({ noteId: undefined });
  });
});

function fakeRequest(
  method: string,
  pathname: string,
  response: Promise<TrackedResponse | null>,
  postData: string | null = null,
): TrackedRequest {
  return {
    method: () => method,
    url: () => `${ORIGIN}${pathname}`,
    postData: () => postData,
    response: () => response,
  };
}

function fakeResponse(body: unknown, ok = true): TrackedResponse {
  return { ok: () => ok, json: () => Promise.resolve(body) };
}

describe("CreatedDataTracker", () => {
  it("collects the ids of the notebooks and notes a test creates", async () => {
    const tracker = new CreatedDataTracker();
    tracker.onRequest(
      fakeRequest("POST", "/api/notebooks", Promise.resolve(fakeResponse({ id: "nb" }))),
    );
    tracker.onRequest(
      fakeRequest("POST", "/api/notebooks/nb/notes", Promise.resolve(fakeResponse({ id: "n1" }))),
    );
    tracker.onRequest(
      fakeRequest(
        "POST",
        "/api/import/evernote/note",
        Promise.resolve(fakeResponse({ notebookId: "nb-import", noteId: "n2" })),
      ),
    );
    tracker.onRequest(fakeRequest("GET", "/api/notebooks", Promise.resolve(fakeResponse([]))));

    expect(await tracker.settle(1000)).toEqual({
      notebookIds: ["nb", "nb-import"],
      noteIds: ["n1", "n2"],
      unsettled: 0,
      errors: [],
    });
  });

  it("skips failed and unanswered calls, and reports unreadable responses", async () => {
    const tracker = new CreatedDataTracker();
    tracker.onRequest(
      fakeRequest("POST", "/api/notebooks", Promise.resolve(fakeResponse({ id: "nb" }, false))),
    );
    tracker.onRequest(fakeRequest("POST", "/api/notebooks", Promise.resolve(null)));
    tracker.onRequest(
      fakeRequest(
        "POST",
        "/api/notebooks",
        Promise.resolve({ ok: () => true, json: () => Promise.reject(new Error("body gone")) }),
      ),
    );
    tracker.onRequest(fakeRequest("POST", "/api/notebooks", Promise.reject("closed")));

    const created = await tracker.settle(1000);

    expect(created.notebookIds).toEqual([]);
    expect([...created.errors].sort()).toEqual([
      `POST ${ORIGIN}/api/notebooks: body gone`,
      `POST ${ORIGIN}/api/notebooks: closed`,
    ]);
  });

  it("waits for calls started while it settles, such as the rest of an import", async () => {
    const tracker = new CreatedDataTracker();
    const first = new Promise<TrackedResponse>((resolve) =>
      setTimeout(() => {
        // The import's next note goes out as the first one comes back.
        tracker.onRequest(
          fakeRequest(
            "POST",
            "/api/import/evernote/note",
            new Promise((resolveNext) =>
              setTimeout(() => resolveNext(fakeResponse({ notebookId: "nb", noteId: "n2" })), 10),
            ),
            '{"notebookId":"nb"}',
          ),
        );
        resolve(fakeResponse({ notebookId: "nb", noteId: "n1" }));
      }, 10),
    );
    tracker.onRequest(fakeRequest("POST", "/api/import/evernote/note", first));

    const created = await tracker.settle(1000);

    expect(created).toMatchObject({ notebookIds: ["nb"], noteIds: ["n1", "n2"], unsettled: 0 });
  });

  it("gives up on calls still unanswered at the timeout", async () => {
    const tracker = new CreatedDataTracker();
    tracker.onRequest(fakeRequest("POST", "/api/notebooks", new Promise(() => {})));

    const created = await tracker.settle(20);

    expect(created).toMatchObject({ notebookIds: [], unsettled: 1 });
  });

  it("returns at once when nothing was created", async () => {
    expect(await new CreatedDataTracker().settle(60_000)).toEqual({
      notebookIds: [],
      noteIds: [],
      unsettled: 0,
      errors: [],
    });
  });
});

// ---------------------------------------------------------------------------
// run-notebooks
// ---------------------------------------------------------------------------

describe("run notebook list", () => {
  const NB1 = "0b5c1a44-46a8-4f0e-9a51-1c2f3d4e5f60";
  const NB2 = "1c6d2b55-57b9-4a1f-8b62-2d3e4f5a6b71";
  const NB3 = "2d7e3c66-68ca-4b2a-9c73-3e4f5a6b7c82";
  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(path.join(os.tmpdir(), "e2e-run-notebooks-"));
  });
  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  function worker(workerIndex: number) {
    return { workerIndex, project: { outputDir } };
  }

  it("collects what every worker recorded, without duplicates", () => {
    recordRunNotebook(worker(0), NB1);
    recordRunNotebooks(worker(1), [NB2, NB1]);
    recordRunNotebooks(worker(0), [NB3]);

    expect(readRunNotebooks(outputDir).sort()).toEqual([NB1, NB2, NB3].sort());
    expect(readdirSync(path.join(outputDir, ".e2e-run-notebooks")).sort()).toEqual([
      "worker-0.txt",
      "worker-1.txt",
    ]);
  });

  it("ignores anything that isn't a notebook id", () => {
    recordRunNotebooks(worker(0), ["", "not-an-id", NB1]);
    writeFileSync(path.join(outputDir, ".e2e-run-notebooks", "worker-9.txt"), "garbage\n\n");

    expect(readRunNotebooks(outputDir)).toEqual([NB1]);
  });

  it("writes nothing for an empty list, and reads an empty run as no notebooks", () => {
    recordRunNotebooks(worker(0), []);

    expect(readdirSync(outputDir)).toEqual([]);
    expect(readRunNotebooks(outputDir)).toEqual([]);
  });

  it("clears the list", () => {
    recordRunNotebook(worker(0), NB1);
    clearRunNotebooks(outputDir);

    expect(readRunNotebooks(outputDir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// e2e-supabase
// ---------------------------------------------------------------------------

describe("E2E user client", () => {
  const DEV_URL = "https://huhzactreblzcogqkbsd.supabase.co";
  const signInWithPassword = vi.fn();
  const signOut = vi.fn();

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", DEV_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("E2E_TEST_EMAIL", "e2e@example.com");
    vi.stubEnv("E2E_TEST_PASSWORD", "secret");
    createClientMock.mockReset().mockReturnValue({ auth: { signInWithPassword, signOut } });
    signInWithPassword.mockReset();
    signOut.mockReset().mockResolvedValue({ error: null });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses the production project", () => {
    expect(() => assertNotProduction(`https://${PRODUCTION_PROJECT_REF}.supabase.co`)).toThrow(
      /refuses to run against the production Supabase project/,
    );
    expect(() => assertNotProduction(DEV_URL)).not.toThrow();
  });

  it("signs in as the E2E user with a session that isn't persisted", async () => {
    signInWithPassword.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });

    const result = await signInAsE2EUser();

    expect(result.userId).toBe("user-1");
    expect(createClientMock).toHaveBeenCalledWith(DEV_URL, "anon-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { "x-drafto-client": "web-e2e-cleanup" } },
    });
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "e2e@example.com",
      password: "secret",
    });
  });

  it("never builds a client for the production project", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `https://${PRODUCTION_PROJECT_REF}.supabase.co`);

    await expect(signInAsE2EUser()).rejects.toThrow(/production Supabase project/);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("names a missing variable", async () => {
    vi.stubEnv("E2E_TEST_PASSWORD", "");

    await expect(signInAsE2EUser()).rejects.toThrow("E2E_TEST_PASSWORD must be set");
  });

  it("reports a failed sign-in", async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: "Invalid login credentials" },
    });

    await expect(signInAsE2EUser()).rejects.toThrow(
      "E2E cleanup could not sign in: Invalid login credentials",
    );
  });

  it("reports a sign-in that returns no user", async () => {
    signInWithPassword.mockResolvedValue({ data: { user: null }, error: null });

    await expect(signInAsE2EUser()).rejects.toThrow("could not sign in: no user returned");
  });

  it("signs out only its own session", async () => {
    signInWithPassword.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });

    await signOutE2EUser(await signInAsE2EUser());

    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});

describe("lazyE2ESession", () => {
  function fakeSession(signOut = vi.fn().mockResolvedValue({ error: null })): E2ESession {
    const client = { auth: { signOut } } as unknown as SupabaseClient<Database>;
    return { client, userId: "user-1" };
  }

  it("signs in once, on first use, and reuses the session", async () => {
    const session = fakeSession();
    const signIn = vi.fn().mockResolvedValue(session);
    const lazy = lazyE2ESession(signIn);

    expect(signIn).not.toHaveBeenCalled();
    expect(await lazy.get()).toBe(session);
    expect(await lazy.get()).toBe(session);
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("retries a failed sign-in once the retry interval has passed, not before", async () => {
    let clock = 0;
    const session = fakeSession();
    const signIn = vi
      .fn()
      .mockRejectedValueOnce(new Error("429 rate limited"))
      .mockResolvedValue(session);
    const lazy = lazyE2ESession(signIn, SIGN_IN_RETRY_MS, () => clock);

    await expect(lazy.get()).rejects.toThrow("429 rate limited");
    clock = SIGN_IN_RETRY_MS - 1;
    await expect(lazy.get()).rejects.toThrow("429 rate limited");
    expect(signIn).toHaveBeenCalledTimes(1);

    clock = SIGN_IN_RETRY_MS;
    expect(await lazy.get()).toBe(session);
    expect(signIn).toHaveBeenCalledTimes(2);
  });

  it("signs out on release only after a successful sign-in, and never throws", async () => {
    const signOut = vi.fn().mockRejectedValue(new Error("network down"));
    const lazy = lazyE2ESession(vi.fn().mockResolvedValue(fakeSession(signOut)));

    await lazy.release();
    expect(signOut).not.toHaveBeenCalled();

    await lazy.get();
    await expect(lazy.release()).resolves.toBeUndefined();
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("releases nothing after a failed sign-in", async () => {
    const lazy = lazyE2ESession(vi.fn().mockRejectedValue(new Error("down")));

    await expect(lazy.get()).rejects.toThrow("down");
    await expect(lazy.release()).resolves.toBeUndefined();
  });
});
