import React from "react";
import { FlatList } from "react-native";

import { render, act } from "../helpers/test-utils";
import TrashScreen from "../../app/(tabs)/trash";

const mockSync = jest.fn();
let mockIsSyncing = false;

jest.mock("@/providers/database-provider", () => ({
  useDatabase: () => ({
    database: { write: jest.fn(), get: jest.fn() },
    sync: mockSync,
    isSyncing: mockIsSyncing,
  }),
}));

const mockNotes: Array<{ id: string; title: string; trashedAt: Date | null }> = [];
let mockLoading = false;

jest.mock("@/hooks/use-trashed-notes", () => ({
  useTrashedNotes: () => ({ notes: mockNotes, loading: mockLoading }),
}));

describe("TrashScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSyncing = false;
    mockLoading = false;
    mockNotes.length = 0;
    mockSync.mockResolvedValue(undefined);
  });

  it("shows the empty state when nothing is trashed", () => {
    const { getByText } = render(<TrashScreen />);

    expect(getByText("Trash is empty")).toBeTruthy();
  });

  it("lists trashed notes", () => {
    mockNotes.push({ id: "note-1", title: "Old draft", trashedAt: new Date() });

    const { getByText } = render(<TrashScreen />);

    expect(getByText("Old draft")).toBeTruthy();
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
});
