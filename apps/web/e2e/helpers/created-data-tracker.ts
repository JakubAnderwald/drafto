/** The parts of a Playwright `Request` the tracker reads. */
export interface TrackedRequest {
  method(): string;
  url(): string;
  postData(): string | null;
  response(): Promise<TrackedResponse | null>;
}

/** The parts of a Playwright `Response` the tracker reads. */
export interface TrackedResponse {
  ok(): boolean;
  json(): Promise<unknown>;
}

/**
 * The app's create endpoints:
 * - `notebook`: `POST /api/notebooks`
 * - `note`: `POST /api/notebooks/:id/notes`
 * - `import-new-notebook` / `import-into-notebook`: `POST /api/import/evernote/note`, which
 *   creates the import's notebook only on a call without a `notebookId`
 */
export type CreateCall = "notebook" | "note" | "import-new-notebook" | "import-into-notebook";

export interface CreatedIds {
  notebookId?: string;
  noteId?: string;
}

const NOTEBOOK_NOTES_PATH = /^\/api\/notebooks\/[^/]+\/notes$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasNotebookId(postData: string | null): boolean {
  if (!postData) return false;
  try {
    const body: unknown = JSON.parse(postData);
    return isRecord(body) && stringOrUndefined(body.notebookId) !== undefined;
  } catch {
    return false;
  }
}

export function classifyCreateCall(
  method: string,
  url: string,
  postData: string | null,
): CreateCall | null {
  if (method !== "POST") return null;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  if (pathname === "/api/notebooks") return "notebook";
  if (NOTEBOOK_NOTES_PATH.test(pathname)) return "note";
  if (pathname === "/api/import/evernote/note") {
    return hasNotebookId(postData) ? "import-into-notebook" : "import-new-notebook";
  }
  return null;
}

export function createdIdsFrom(call: CreateCall, body: unknown): CreatedIds {
  if (!isRecord(body)) return {};
  switch (call) {
    case "notebook":
      return { notebookId: stringOrUndefined(body.id) };
    case "note":
      return { noteId: stringOrUndefined(body.id) };
    case "import-new-notebook":
      return {
        notebookId: stringOrUndefined(body.notebookId),
        noteId: stringOrUndefined(body.noteId),
      };
    case "import-into-notebook":
      return { noteId: stringOrUndefined(body.noteId) };
  }
}

export interface CreatedData {
  notebookIds: string[];
  noteIds: string[];
  /** Create calls still without a response when `settle` gave up waiting. */
  unsettled: number;
  /** Create calls whose response couldn't be read. Whatever they created is left to the purge. */
  errors: string[];
}

/**
 * Collects the ids of the notebooks and notes a browser context creates through the
 * app's API. Attach `onRequest` to the context's `request` event; read the ids with
 * `settle` once the test is done.
 */
export class CreatedDataTracker {
  private readonly notebookIds = new Set<string>();
  private readonly noteIds = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  private readonly errors: string[] = [];

  readonly onRequest = (request: TrackedRequest): void => {
    const call = classifyCreateCall(request.method(), request.url(), request.postData());
    if (!call) return;
    const capture: Promise<void> = this.capture(call, request)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.errors.push(`${request.method()} ${request.url()}: ${message}`);
      })
      .finally(() => this.pending.delete(capture));
    this.pending.add(capture);
  };

  private async capture(call: CreateCall, request: TrackedRequest): Promise<void> {
    const response = await request.response();
    if (!response?.ok()) return;
    const { notebookId, noteId } = createdIdsFrom(call, await response.json());
    if (notebookId) this.notebookIds.add(notebookId);
    if (noteId) this.noteIds.add(noteId);
  }

  /**
   * Waits up to `timeoutMs` for create calls still in flight, including any started
   * while waiting (an import keeps creating notes after the test's last assertion).
   */
  async settle(timeoutMs: number): Promise<CreatedData> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size > 0 && Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadline - Date.now());
      });
      await Promise.race([Promise.allSettled([...this.pending]), timeout]);
      clearTimeout(timer);
    }
    return {
      notebookIds: [...this.notebookIds],
      noteIds: [...this.noteIds],
      unsettled: this.pending.size,
      errors: [...this.errors],
    };
  }
}
