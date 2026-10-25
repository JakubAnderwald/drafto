/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense, type ComponentProps } from "react";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { NoteList } from "@/components/notes/note-list";
import { RelativeTime } from "@/components/notes/relative-time";

// The note list's server render (#715). This file runs in Node, where `window` is
// undefined, as in Next.js's server render of a client component. Under jsdom the
// old code took its browser-only seeding path and these tests would pass for the
// wrong reason.

const NOW = new Date("2026-10-17T12:00:00.000Z");

const serverNotes = [
  { id: "note-1", title: "Server Note One", updated_at: "2026-10-17T11:55:00.000Z" },
  { id: "note-2", title: "Server Note Two", updated_at: "2026-10-16T12:00:00.000Z" },
];

const mockFetch = vi.fn<typeof fetch>();

function renderNoteList(props: Partial<ComponentProps<typeof NoteList>> = {}): string {
  return renderToString(
    <Suspense fallback={<div data-testid="list-skeleton">Loading notes</div>}>
      <NoteList
        notebookId="nb-ssr"
        selectedNoteId={null}
        onSelectNote={() => {}}
        onCreateNote={() => {}}
        refreshTrigger={0}
        {...props}
      />
    </Suspense>,
  );
}

describe("NoteList server render", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    // Settles, so a regression shows up as a failed assertion, not a stream that
    // never finishes.
    mockFetch.mockImplementation(async () => Response.json([]));
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    mockFetch.mockReset();
  });

  it("is a real server environment", () => {
    expect(typeof window).toBe("undefined");
  });

  it("renders the server-provided notes without calling fetch", () => {
    const html = renderNoteList({ initialNotes: serverNotes });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(html).toContain("Server Note One");
    expect(html).toContain("Server Note Two");
    expect(html).not.toContain("list-skeleton");
  });

  it("server-renders each row's timestamp", () => {
    const html = renderNoteList({ initialNotes: serverNotes });

    expect(html).toMatch(/<time [^>]*datetime="2026-10-17T11:55:00.000Z"[^>]*>5m ago<\/time>/i);
    expect(html).toMatch(/<time [^>]*datetime="2026-10-16T12:00:00.000Z"[^>]*>1d ago<\/time>/i);
  });

  it("renders the empty state when the server found no notes", () => {
    // Its own notebook, so no list another test cached for "nb-ssr" can stand in
    // for the server notes.
    const html = renderNoteList({ notebookId: "nb-ssr-empty", initialNotes: [] });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(html).toContain("No notes yet");
    expect(html).not.toContain("list-skeleton");
  });

  it("shares nothing between requests for the same notebook", () => {
    const first = renderNoteList({ initialNotes: serverNotes });
    const second = renderNoteList({
      initialNotes: [
        { id: "note-3", title: "Another Request", updated_at: "2026-10-17T11:00:00.000Z" },
      ],
    });

    expect(first).toContain("Server Note One");
    expect(second).toContain("Another Request");
    expect(second).not.toContain("Server Note One");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls back to a client render instead of fetching when there are no server notes", async () => {
    const withoutNotes = await renderCollectingErrors();
    const afterRefresh = await renderCollectingErrors({
      initialNotes: serverNotes,
      refreshTrigger: 1,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    for (const { html, errors } of [withoutNotes, afterRefresh]) {
      expect(html).toContain("list-skeleton");
      expect(html).not.toContain("Server Note One");
      // Reported to the server's error handler, not swallowed.
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain("NoteList fetched notes during a server render");
    }
  });

  it("raises a fresh error on every request instead of replaying a cached one", async () => {
    const first = await renderCollectingErrors({ notebookId: "nb-ssr-repeat" });
    const second = await renderCollectingErrors({ notebookId: "nb-ssr-repeat" });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(first.errors).toHaveLength(1);
    expect(second.errors).toHaveLength(1);
    // A rejected promise cached by the first request would give the second
    // request the same error object.
    expect(second.errors[0]).not.toBe(first.errors[0]);
    expect(second.html).toContain("list-skeleton");
  });
});

// The streaming renderer, unlike `renderToString`, reports errors caught by a
// Suspense boundary through `onError`, the hook Next.js logs server errors from.
async function renderCollectingErrors(
  props: Partial<ComponentProps<typeof NoteList>> = {},
): Promise<{ html: string; errors: unknown[] }> {
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(
    <Suspense fallback={<div data-testid="list-skeleton">Loading notes</div>}>
      <NoteList
        notebookId="nb-ssr"
        selectedNoteId={null}
        onSelectNote={() => {}}
        onCreateNote={() => {}}
        {...props}
      />
    </Suspense>,
    { onError: (error) => void errors.push(error) },
  );
  await stream.allReady;
  return { html: await new Response(stream).text(), errors };
}

describe("RelativeTime server render", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a <time> element with the timestamp and the server's relative text", () => {
    const html = renderToString(<RelativeTime value="2026-10-17T09:00:00.000Z" />);

    expect(html).toMatch(/^<time [^>]*datetime="2026-10-17T09:00:00.000Z"[^>]*>3h ago<\/time>$/i);
  });
});
