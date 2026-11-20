import { renderHook, act, waitFor } from "@testing-library/react-native";
import type { EditorPageLocation } from "@drafto/shared";

import { useEditorPage } from "@/hooks/use-editor-page";
import type { EditorPageWebViewProps } from "@/hooks/use-editor-page";

const mockUsesFile = jest.fn<boolean, []>();
const mockEnsure = jest.fn<Promise<EditorPageLocation | null>, []>();
jest.mock("@/lib/editor-page", () => ({
  usesEditorPageFile: () => mockUsesFile(),
  ensureEditorPage: () => mockEnsure(),
}));

const LOCATION: EditorPageLocation = {
  uri: "file:///docs/attachment-cache/.editor/editor-1.html",
  readAccessUrl: "file:///docs/attachment-cache/",
};

type ErrorEvent = Parameters<NonNullable<EditorPageWebViewProps["onError"]>>[0];

function errorEvent(): ErrorEvent & { preventDefault: jest.Mock } {
  return {
    preventDefault: jest.fn(),
    nativeEvent: { description: "The file couldn't be opened." },
  } as unknown as ErrorEvent & { preventDefault: jest.Mock };
}

beforeEach(() => {
  mockUsesFile.mockReset().mockReturnValue(true);
  mockEnsure.mockReset().mockResolvedValue(LOCATION);
});

describe("useEditorPage", () => {
  it("waits for the page file, then loads it with read access to the cache", async () => {
    const { result } = renderHook(() => useEditorPage());
    expect(result.current.ready).toBe(false);

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.webViewProps).toEqual({
      source: { uri: LOCATION.uri },
      allowingReadAccessToURL: LOCATION.readAccessUrl,
      onLoad: expect.any(Function),
      onError: expect.any(Function),
    });
  });

  it("loads the page inline when the file can't be written", async () => {
    mockEnsure.mockResolvedValue(null);
    const { result } = renderHook(() => useEditorPage());
    await waitFor(() => expect(result.current.ready).toBe(true));
    // No `source` key at all, so TenTap keeps its own html + baseUrl source.
    expect(result.current.webViewProps).toEqual({});
    expect("source" in result.current.webViewProps).toBe(false);
  });

  it("falls back to the inline page when the file fails to load", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const { result } = renderHook(() => useEditorPage());
    await waitFor(() => expect(result.current.ready).toBe(true));

    const event = errorEvent();
    act(() => result.current.webViewProps.onError?.(event));

    expect(event.preventDefault).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    // The read access stays, so only the source changes (one load, not two).
    expect(result.current.webViewProps).toEqual({
      allowingReadAccessToURL: LOCATION.readAccessUrl,
    });
    warn.mockRestore();
  });

  it("stops handling errors once the page has loaded", async () => {
    const { result } = renderHook(() => useEditorPage());
    await waitFor(() => expect(result.current.ready).toBe(true));
    const source = result.current.webViewProps.source;

    act(() => result.current.webViewProps.onLoad?.());

    expect(result.current.webViewProps).toEqual({
      source,
      allowingReadAccessToURL: LOCATION.readAccessUrl,
    });
  });

  it("ignores a page location that arrives after unmounting", async () => {
    let finish: (location: EditorPageLocation) => void = () => undefined;
    mockEnsure.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { result, unmount } = renderHook(() => useEditorPage());
    unmount();
    await act(async () => finish(LOCATION));
    expect(result.current.ready).toBe(false);
  });
});
