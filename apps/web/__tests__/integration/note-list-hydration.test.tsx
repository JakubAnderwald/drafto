import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { act, Suspense, type ComponentProps, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { NoteList } from "@/components/notes/note-list";

// Hydrating the server-rendered note list (#715). The server renders at one time
// and the browser hydrates a few minutes later, so each row's relative timestamp
// differs between the two — the case a mismatch would surface on page load.

const SERVER_NOW = new Date("2026-10-17T12:00:00.000Z");
const CLIENT_NOW = new Date("2026-10-17T12:03:00.000Z");

const serverNotes = [
  // 30s old on the server ("just now"), 3.5 minutes old in the browser ("3m ago").
  { id: "note-1", title: "Hydrated Note", updated_at: "2026-10-17T11:59:30.000Z" },
];

const freshNotes = [
  { id: "note-2", title: "Fetched After Refresh", updated_at: "2026-10-17T12:02:00.000Z" },
];

const mockFetch = vi.fn<typeof fetch>();

function List(props: Partial<ComponentProps<typeof NoteList>>) {
  return (
    <Suspense fallback={<div data-testid="list-skeleton">Loading notes</div>}>
      <NoteList
        notebookId="nb-hydrate"
        selectedNoteId={null}
        onSelectNote={() => {}}
        onCreateNote={() => {}}
        refreshTrigger={0}
        initialNotes={serverNotes}
        {...props}
      />
    </Suspense>
  );
}

describe("NoteList hydration", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockFetch.mockResolvedValue(Response.json(freshNotes));
    vi.stubGlobal("fetch", mockFetch);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    mockFetch.mockReset();
  });

  // Server-renders `element` at SERVER_NOW, then hydrates it at CLIENT_NOW.
  // `beforeHydrate` runs in between, e.g. to switch the browser's locale.
  async function serverRenderThenHydrate(
    element: ReactElement,
    beforeHydrate: () => void = () => {},
  ) {
    const onRecoverableError = vi.fn();
    vi.setSystemTime(SERVER_NOW);
    container.innerHTML = renderToString(element);
    const serverTitle = container.querySelector("li p");
    const serverTime = container.querySelector("time");
    const serverTimeText = serverTime?.textContent;

    beforeHydrate();
    vi.setSystemTime(CLIENT_NOW);
    await act(async () => {
      root = hydrateRoot(container, element, { onRecoverableError });
    });

    return { onRecoverableError, serverTitle, serverTime, serverTimeText };
  }

  it("hydrates the server's list without an error or a fetch", async () => {
    const { onRecoverableError, serverTitle } = await serverRenderThenHydrate(<List />);

    expect(serverTitle?.textContent).toBe("Hydrated Note");
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId("list-skeleton")).not.toBeInTheDocument();
    // Hydration adopted the server's DOM instead of re-rendering the list.
    expect(screen.getByText("Hydrated Note")).toBe(serverTitle);
  });

  it("replaces the server's timestamp text with the browser's after hydration", async () => {
    const { onRecoverableError, serverTime, serverTimeText } = await serverRenderThenHydrate(
      <List />,
    );

    const time = container.querySelector("time");
    expect(serverTimeText).toBe("just now");
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(time?.textContent).toBe("3m ago");
    expect(time?.getAttribute("datetime")).toBe("2026-10-17T11:59:30.000Z");
    expect(time).not.toBe(serverTime);
  });

  it("replaces a server-locale date with the browser's for notes older than 30 days", async () => {
    const oldNote = { id: "note-old", title: "Old Note", updated_at: "2026-08-01T08:00:00.000Z" };
    const toLocaleDateString = vi
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockReturnValue("server-locale date");

    const { onRecoverableError, serverTimeText } = await serverRenderThenHydrate(
      <List initialNotes={[oldNote]} />,
      () => toLocaleDateString.mockReturnValue("browser-locale date"),
    );

    expect(serverTimeText).toBe("server-locale date");
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(container.querySelector("time")?.textContent).toBe("browser-locale date");
  });

  it("fetches once when the list is refreshed after hydration", async () => {
    const { onRecoverableError } = await serverRenderThenHydrate(<List />);
    expect(mockFetch).not.toHaveBeenCalled();

    await act(async () => {
      root?.render(<List refreshTrigger={1} />);
    });

    await waitFor(() => {
      expect(screen.getByText("Fetched After Refresh")).toBeInTheDocument();
    });
    expect(screen.queryByText("Hydrated Note")).not.toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledWith("/api/notebooks/nb-hydrate/notes");
    expect(onRecoverableError).not.toHaveBeenCalled();
  });
});
