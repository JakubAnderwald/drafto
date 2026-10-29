import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const mockHandleAuthError = vi.fn<(res: Response) => boolean>(() => false);
vi.mock("@/lib/handle-auth-error", () => ({
  handleAuthError: (res: Response) => mockHandleAuthError(res),
}));

import {
  TRASH_LIST_ROW_CAP,
  useNotebookDeleteImpact,
  type NotebookDeleteImpact,
} from "@/hooks/use-notebook-delete-impact";

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function trashedNote(id: string, notebookId: string) {
  return {
    id,
    title: id,
    notebook_id: notebookId,
    trashed_at: "2026-10-01T00:00:00Z",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  };
}

function activeNote(id: string) {
  return { id, title: id, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
}

const mockFetch = vi.fn<(url: string) => Promise<FakeResponse>>();

/** Answers the trash list and each notebook's active-notes list from the given data. */
function routeFetch(trashed: unknown[], activeByNotebook: Record<string, unknown[]> = {}) {
  mockFetch.mockImplementation((url: string) => {
    if (url === "/api/notes/trash") return Promise.resolve(jsonResponse(trashed));
    const match = /^\/api\/notebooks\/([^/]+)\/notes$/.exec(url);
    if (match) return Promise.resolve(jsonResponse(activeByNotebook[match[1]] ?? []));
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
}

/** What the confirm shows: whether it is still checking, and whether it warns. */
function shown({ checking, warnTrashedNotes }: NotebookDeleteImpact) {
  return { checking, warnTrashedNotes };
}

/** Holds every fetch open until the test resolves it, in the order the hook made them. */
function holdFetches() {
  const pending: Array<{ url: string; resolve: (res: FakeResponse) => void }> = [];
  mockFetch.mockImplementation(
    (url: string) =>
      new Promise<FakeResponse>((resolve) => {
        pending.push({ url, resolve });
      }),
  );
  return pending;
}

/** Lets resolved fetches run through the hook's promise chain. */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useNotebookDeleteImpact", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockHandleAuthError.mockReset();
    mockHandleAuthError.mockReturnValue(false);
    vi.stubGlobal("fetch", mockFetch);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("checks nothing while no delete confirm is open", () => {
    const { result } = renderHook(() => useNotebookDeleteImpact(null));

    expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("warns when the notebook holds trashed notes and no active ones", async () => {
    routeFetch([trashedNote("t-1", "nb-1")]);

    const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));

    await waitFor(() => {
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: true });
    });
    expect(mockFetch).toHaveBeenCalledWith("/api/notes/trash");
    expect(mockFetch).toHaveBeenCalledWith("/api/notebooks/nb-1/notes");
  });

  it("ignores trashed notes that belong to other notebooks", async () => {
    routeFetch([trashedNote("t-1", "nb-2"), trashedNote("t-2", "nb-3")]);

    const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));

    await waitFor(() => {
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
    });
  });

  it("does not warn for an empty notebook", async () => {
    routeFetch([]);

    const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));

    await waitFor(() => {
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
    });
  });

  it("does not warn when active notes exist, since the API refuses the delete", async () => {
    routeFetch([trashedNote("t-1", "nb-1")], { "nb-1": [activeNote("n-1")] });

    const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));

    await waitFor(() => {
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
    });
  });

  it("warns when the trash list hits the row cap, since it may be cut short", async () => {
    const otherNotebooks = Array.from({ length: TRASH_LIST_ROW_CAP }, (_, i) =>
      trashedNote(`t-${i}`, "nb-2"),
    );
    routeFetch(otherNotebooks);

    const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));

    await waitFor(() => {
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: true });
    });
  });

  it("warns when a fetch is rejected", async () => {
    mockFetch.mockImplementation((url: string) =>
      url === "/api/notes/trash"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(jsonResponse([])),
    );

    const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));

    await waitFor(() => {
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: true });
    });
    expect(console.error).toHaveBeenCalled();
  });

  it("warns when an endpoint answers with an error status", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url === "/api/notes/trash"
          ? jsonResponse([])
          : jsonResponse({ error: "Failed to fetch notes" }, 500),
      ),
    );

    const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));

    await waitFor(() => {
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: true });
    });
  });

  it("warns when an endpoint answers with something other than a list", async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(url === "/api/notes/trash" ? jsonResponse({}) : jsonResponse([])),
    );

    const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));

    await waitFor(() => {
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: true });
    });
  });

  it("keeps checking while the session-expired redirect to /login loads", async () => {
    mockHandleAuthError.mockReturnValue(true);
    mockFetch.mockResolvedValue(jsonResponse({ error: "Unauthorized" }, 401));

    const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));

    await waitFor(() => {
      expect(mockHandleAuthError).toHaveBeenCalledTimes(2);
    });
    expect(shown(result.current)).toEqual({ checking: true, warnTrashedNotes: false });
  });

  it("is checking until both fetches settle", async () => {
    let resolveActive: (res: FakeResponse) => void = () => {};
    mockFetch.mockImplementation((url: string) =>
      url === "/api/notes/trash"
        ? Promise.resolve(jsonResponse([trashedNote("t-1", "nb-1")]))
        : new Promise<FakeResponse>((resolve) => {
            resolveActive = resolve;
          }),
    );

    const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));

    expect(shown(result.current)).toEqual({ checking: true, warnTrashedNotes: false });
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
    // The trash list has answered, but the active-notes list hasn't.
    await flush();
    expect(shown(result.current)).toEqual({ checking: true, warnTrashedNotes: false });

    resolveActive(jsonResponse([]));

    await waitFor(() => {
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: true });
    });
  });

  it("ignores a late answer for the previous notebook once the current one has settled", async () => {
    const pending = holdFetches();

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useNotebookDeleteImpact(id),
      { initialProps: { id: "nb-1" as string | null } },
    );
    await waitFor(() => expect(pending).toHaveLength(2));

    // The confirm moves straight on to nb-2, whose check answers first: no warning.
    rerender({ id: "nb-2" });
    await waitFor(() => expect(pending).toHaveLength(4));
    expect(shown(result.current)).toEqual({ checking: true, warnTrashedNotes: false });
    pending[2].resolve(jsonResponse([trashedNote("t-1", "nb-1")]));
    pending[3].resolve(jsonResponse([]));
    await waitFor(() => {
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
    });

    // nb-1's check answers "warn" afterwards, and must not replace nb-2's answer.
    pending[0].resolve(jsonResponse([trashedNote("t-1", "nb-1")]));
    pending[1].resolve(jsonResponse([]));
    await flush();
    expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
  });

  it("ignores a late answer for the previous notebook while the current one is pending", async () => {
    const pending = holdFetches();

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useNotebookDeleteImpact(id),
      { initialProps: { id: "nb-1" as string | null } },
    );
    await waitFor(() => expect(pending).toHaveLength(2));

    rerender({ id: "nb-2" });
    await waitFor(() => expect(pending).toHaveLength(4));

    // nb-1's check answers "warn" after the confirm moved on to nb-2.
    pending[0].resolve(jsonResponse([trashedNote("t-1", "nb-1")]));
    pending[1].resolve(jsonResponse([]));
    await flush();
    expect(shown(result.current)).toEqual({ checking: true, warnTrashedNotes: false });

    // nb-2's own check answers "no warning".
    pending[2].resolve(jsonResponse([trashedNote("t-1", "nb-1")]));
    pending[3].resolve(jsonResponse([]));
    await waitFor(() => {
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
    });
  });

  it("checks again when the same notebook's confirm is reopened", async () => {
    routeFetch([]);

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useNotebookDeleteImpact(id),
      { initialProps: { id: "nb-1" as string | null } },
    );
    await waitFor(() => {
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
    });

    // A note was trashed in nb-1 while its confirm was closed.
    rerender({ id: null });
    expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
    routeFetch([trashedNote("t-1", "nb-1")]);
    rerender({ id: "nb-1" });

    expect(shown(result.current)).toEqual({ checking: true, warnTrashedNotes: false });
    await waitFor(() => {
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: true });
    });
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("checks again when the confirm returns to a notebook before the other one settled", async () => {
    const pending = holdFetches();

    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useNotebookDeleteImpact(id),
      { initialProps: { id: "nb-1" as string | null } },
    );
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[0].resolve(jsonResponse([]));
    pending[1].resolve(jsonResponse([]));
    await waitFor(() => {
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
    });

    // nb-2's confirm opens and, before its check answers, nb-1's opens again.
    rerender({ id: "nb-2" });
    rerender({ id: "nb-1" });

    expect(shown(result.current)).toEqual({ checking: true, warnTrashedNotes: false });
    await waitFor(() => expect(pending).toHaveLength(6));
    pending[4].resolve(jsonResponse([trashedNote("t-1", "nb-1")]));
    pending[5].resolve(jsonResponse([]));
    await waitFor(() => {
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: true });
    });
  });

  describe("checkBeforeDelete", () => {
    it("lets the delete go ahead when the notebook is still empty", async () => {
      routeFetch([]);
      const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));
      await waitFor(() => {
        expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
      });

      let proceed = false;
      await act(async () => {
        proceed = await result.current.checkBeforeDelete();
      });

      expect(proceed).toBe(true);
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("shows the warning instead when the notebook has gained trashed notes", async () => {
      routeFetch([], { "nb-1": [activeNote("n-1")] });
      const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));
      await waitFor(() => {
        expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
      });

      // Its only note was trashed while the confirm was open.
      routeFetch([trashedNote("n-1", "nb-1")]);
      let proceed = true;
      await act(async () => {
        proceed = await result.current.checkBeforeDelete();
      });

      expect(proceed).toBe(false);
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: true });

      // Confirming again, with the warning on show, goes ahead.
      await act(async () => {
        proceed = await result.current.checkBeforeDelete();
      });
      expect(proceed).toBe(true);
    });

    it("lets the delete go ahead when the warning is already on show", async () => {
      routeFetch([trashedNote("t-1", "nb-1")]);
      const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));
      await waitFor(() => {
        expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: true });
      });

      let proceed = false;
      await act(async () => {
        proceed = await result.current.checkBeforeDelete();
      });

      expect(proceed).toBe(true);
    });

    it("lets the delete go ahead when the notebook still holds active notes, for the API to refuse", async () => {
      routeFetch([trashedNote("t-1", "nb-1")], { "nb-1": [activeNote("n-1")] });
      const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));
      await waitFor(() => {
        expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
      });

      let proceed = false;
      await act(async () => {
        proceed = await result.current.checkBeforeDelete();
      });

      expect(proceed).toBe(true);
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
    });

    it("shows the warning instead when the check fails", async () => {
      routeFetch([]);
      const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));
      await waitFor(() => {
        expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
      });

      mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
      let proceed = true;
      await act(async () => {
        proceed = await result.current.checkBeforeDelete();
      });

      expect(proceed).toBe(false);
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: true });
    });

    it("holds the delete while the session-expired redirect to /login loads", async () => {
      routeFetch([]);
      const { result } = renderHook(() => useNotebookDeleteImpact("nb-1"));
      await waitFor(() => {
        expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
      });

      mockHandleAuthError.mockReturnValue(true);
      let proceed = true;
      await act(async () => {
        proceed = await result.current.checkBeforeDelete();
      });

      expect(proceed).toBe(false);
    });

    it("holds the delete when no confirm is open", async () => {
      const { result } = renderHook(() => useNotebookDeleteImpact(null));

      let proceed = true;
      await act(async () => {
        proceed = await result.current.checkBeforeDelete();
      });

      expect(proceed).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("leaves another notebook's answer alone when the confirm moved on meanwhile", async () => {
      routeFetch([]);
      const { result, rerender } = renderHook(
        ({ id }: { id: string | null }) => useNotebookDeleteImpact(id),
        { initialProps: { id: "nb-1" as string | null } },
      );
      await waitFor(() => {
        expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
      });

      // nb-1's confirm-time check is still running when the confirm moves to nb-2.
      const pending = holdFetches();
      let finished: Promise<boolean> = Promise.resolve(true);
      act(() => {
        finished = result.current.checkBeforeDelete();
      });
      await waitFor(() => expect(pending).toHaveLength(2));
      routeFetch([]);
      rerender({ id: "nb-2" });
      await waitFor(() => {
        expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
      });

      // nb-1's check now answers "warn".
      pending[0].resolve(jsonResponse([trashedNote("t-1", "nb-1")]));
      pending[1].resolve(jsonResponse([]));
      await act(async () => {
        expect(await finished).toBe(false);
      });
      expect(shown(result.current)).toEqual({ checking: false, warnTrashedNotes: false });
    });
  });
});
