import React from "react";
import { Alert, FlatList, type AlertButton } from "react-native";
import * as SecureStore from "expo-secure-store";

import { render, fireEvent, waitFor, act } from "../helpers/test-utils";
import { swipeActionLabels, triggerSwipeAction } from "../helpers/swipe-actions";
import TrashScreen from "../../app/(tabs)/trash";

const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

const mockSync = jest.fn().mockResolvedValue(undefined);
let mockIsSyncing = false;
const mockDatabaseWrite = jest.fn();
const mockDatabaseGet = jest.fn();

jest.mock("@/providers/database-provider", () => ({
  useDatabase: () => ({
    database: { write: mockDatabaseWrite, get: mockDatabaseGet },
    sync: mockSync,
    isSyncing: mockIsSyncing,
    hasPendingChanges: false,
    pendingChangesCount: 0,
    lastSyncedAt: null,
  }),
}));

const mockNotes: Array<{ id: string; title: string; trashedAt: Date | null }> = [];
let mockLoading = false;

jest.mock("@/hooks/use-trashed-notes", () => ({
  useTrashedNotes: () => ({ notes: mockNotes, loading: mockLoading }),
}));

function lastAlertButtons(spy: jest.SpyInstance): AlertButton[] {
  return spy.mock.calls.at(-1)?.[2] as AlertButton[];
}

function pressAlertButton(spy: jest.SpyInstance, text: string) {
  const button = lastAlertButtons(spy).find((candidate) => candidate.text === text);
  if (!button) throw new Error(`No "${text}" button in the last alert`);
  return button.onPress?.();
}

describe("TrashScreen", () => {
  let alertSpy: jest.SpyInstance;
  let noteUpdate: jest.Mock;
  let noteMarkAsDeleted: jest.Mock;
  let attachmentMarkAsDeleted: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNotes.length = 0;
    mockLoading = false;
    mockIsSyncing = false;
    mockSync.mockResolvedValue(undefined);
    mockSecureStore.getItemAsync.mockResolvedValue(null);
    alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});

    noteUpdate = jest.fn(async (fn: (record: Record<string, unknown>) => void) => {
      const record: Record<string, unknown> = { isTrashed: true, trashedAt: new Date() };
      fn(record);
      return record;
    });
    noteMarkAsDeleted = jest.fn();
    attachmentMarkAsDeleted = jest.fn();
    mockDatabaseWrite.mockImplementation(async (fn: () => Promise<void>) => fn());
    mockDatabaseGet.mockImplementation((table: string) => {
      if (table === "notes") {
        return {
          find: jest
            .fn()
            .mockResolvedValue({ update: noteUpdate, markAsDeleted: noteMarkAsDeleted }),
        };
      }
      if (table === "attachments") {
        return {
          query: () => ({
            fetch: jest.fn().mockResolvedValue([{ markAsDeleted: attachmentMarkAsDeleted }]),
          }),
        };
      }
      return {};
    });
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  it("shows the empty state, without a hint", async () => {
    const { getByText, queryByTestId } = render(<TrashScreen />);

    await act(async () => {});

    expect(getByText("Trash is empty")).toBeTruthy();
    expect(queryByTestId("swipe-hint")).toBeNull();
  });

  it("lists trashed notes", () => {
    mockNotes.push({ id: "n1", title: "Old idea", trashedAt: new Date("2026-01-02") });

    const { getByText } = render(<TrashScreen />);

    expect(getByText("Old idea")).toBeTruthy();
    expect(getByText(/^Trashed /)).toBeTruthy();
  });

  it("does not show the refresh spinner for a background sync", () => {
    mockIsSyncing = true;
    mockNotes.push({ id: "note-1", title: "Old draft", trashedAt: new Date() });

    const { UNSAFE_getByType } = render(<TrashScreen />);

    expect(UNSAFE_getByType(FlatList).props.refreshControl.props.refreshing).toBe(false);
  });

  it("shows the refresh spinner after a pull until the sync finishes", async () => {
    let finishSync!: () => void;
    mockSync.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSync = resolve;
      }),
    );
    mockNotes.push({ id: "note-1", title: "Old draft", trashedAt: new Date() });
    const { UNSAFE_getByType } = render(<TrashScreen />);
    const refreshControl = () => UNSAFE_getByType(FlatList).props.refreshControl;

    act(() => {
      refreshControl().props.onRefresh();
    });
    expect(refreshControl().props.refreshing).toBe(true);

    await act(async () => {
      finishSync();
    });
    expect(refreshControl().props.refreshing).toBe(false);
  });

  describe("swipe hint (PrimeTestLab 10668 S-03)", () => {
    beforeEach(() => {
      mockNotes.push({ id: "n1", title: "Old idea", trashedAt: new Date() });
    });

    it("tells a first-time user how to restore and delete", async () => {
      const { findByTestId, getByText } = render(<TrashScreen />);

      expect(await findByTestId("swipe-hint")).toBeTruthy();
      expect(getByText(/Swipe right on a note to restore it/)).toBeTruthy();
      expect(mockSecureStore.getItemAsync).toHaveBeenCalledWith("drafto_swipe_hint_seen_trash");
    });

    it("hides the hint for good once dismissed", async () => {
      const { findByTestId, queryByTestId } = render(<TrashScreen />);

      fireEvent.press(await findByTestId("swipe-hint-dismiss"));

      expect(queryByTestId("swipe-hint")).toBeNull();
      expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith(
        "drafto_swipe_hint_seen_trash",
        "1",
      );
    });

    it("stays hidden once dismissed on this device", async () => {
      mockSecureStore.getItemAsync.mockResolvedValue("1");
      const { queryByTestId } = render(<TrashScreen />);

      await act(async () => {});

      expect(queryByTestId("swipe-hint")).toBeNull();
    });
  });

  describe("tap menu", () => {
    beforeEach(() => {
      mockNotes.push({ id: "n1", title: "Old idea", trashedAt: new Date() });
    });

    it("opens Restore / Delete permanently / Cancel on a tap", () => {
      const { getByText } = render(<TrashScreen />);

      fireEvent.press(getByText("Old idea"));

      expect(alertSpy).toHaveBeenCalledWith("Old idea", undefined, expect.any(Array), {
        cancelable: true,
      });
      expect(lastAlertButtons(alertSpy).map((button) => [button.text, button.style])).toEqual([
        ["Restore", undefined],
        ["Delete permanently", "destructive"],
        ["Cancel", "cancel"],
      ]);
    });

    it("titles an untitled note's menu", () => {
      mockNotes[0].title = "";
      const { getByText } = render(<TrashScreen />);

      fireEvent.press(getByText(/^Trashed /));

      expect(alertSpy.mock.calls[0][0]).toBe("Untitled");
    });

    it("restores straight from the menu, with no second question", async () => {
      const { getByText } = render(<TrashScreen />);
      fireEvent.press(getByText("Old idea"));

      await act(async () => {
        await pressAlertButton(alertSpy, "Restore");
      });

      expect(alertSpy).toHaveBeenCalledTimes(1);
      expect(noteUpdate).toHaveBeenCalledTimes(1);
      expect(await noteUpdate.mock.results[0].value).toEqual({
        isTrashed: false,
        trashedAt: null,
      });
      expect(mockSync).toHaveBeenCalled();
    });

    it("still asks before deleting forever", async () => {
      const { getByText } = render(<TrashScreen />);
      fireEvent.press(getByText("Old idea"));

      await act(async () => {
        await pressAlertButton(alertSpy, "Delete permanently");
      });

      expect(alertSpy).toHaveBeenLastCalledWith(
        "Delete Permanently",
        expect.stringContaining("cannot be undone"),
        expect.any(Array),
      );
      expect(noteMarkAsDeleted).not.toHaveBeenCalled();

      await act(async () => {
        await pressAlertButton(alertSpy, "Delete");
      });

      expect(attachmentMarkAsDeleted).toHaveBeenCalled();
      expect(noteMarkAsDeleted).toHaveBeenCalled();
      expect(mockSync).toHaveBeenCalled();
    });

    it("reports a failed restore", async () => {
      mockDatabaseGet.mockImplementation(() => ({
        find: jest.fn().mockRejectedValue(new Error("gone")),
      }));
      const { getByText } = render(<TrashScreen />);
      fireEvent.press(getByText("Old idea"));

      await act(async () => {
        await pressAlertButton(alertSpy, "Restore");
      });

      expect(alertSpy).toHaveBeenLastCalledWith("Error", "gone");
    });
  });

  describe("screen-reader actions", () => {
    beforeEach(() => {
      mockNotes.push({ id: "n1", title: "Old idea", trashedAt: new Date() });
    });

    it("offers Restore note and Delete note permanently", () => {
      const { getByText } = render(<TrashScreen />);

      expect(swipeActionLabels(getByText("Old idea"))).toEqual([
        "Restore note",
        "Delete note permanently",
      ]);
    });

    it("restores through the usual confirm", async () => {
      const { getByText } = render(<TrashScreen />);

      triggerSwipeAction(getByText("Old idea"), "Restore note");

      expect(alertSpy).toHaveBeenLastCalledWith(
        "Restore Note",
        'Restore "Old idea" from trash?',
        expect.any(Array),
      );
      await act(async () => {
        await pressAlertButton(alertSpy, "Restore");
      });
      await waitFor(() => expect(noteUpdate).toHaveBeenCalledTimes(1));
    });

    it("deletes through the usual confirm", () => {
      const { getByText } = render(<TrashScreen />);

      triggerSwipeAction(getByText("Old idea"), "Delete note permanently");

      expect(alertSpy).toHaveBeenLastCalledWith(
        "Delete Permanently",
        expect.stringContaining("Old idea"),
        expect.any(Array),
      );
    });
  });
});
