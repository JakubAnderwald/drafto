import React from "react";

import { render, fireEvent, act } from "../helpers/test-utils";
import { LAST_SYNCED_TICK_MS, SyncStatus } from "../../src/components/sync-status";

const mockSync = jest.fn().mockResolvedValue(undefined);
let mockDatabaseContext = {
  sync: mockSync,
  isSyncing: false,
  lastSyncedAt: null as Date | null,
  lastSyncError: null as string | null,
  pendingChangesCount: 0,
  hasPendingChanges: false,
};

jest.mock("@/providers/database-provider", () => ({
  useDatabase: () => mockDatabaseContext,
}));

let mockIsConnected = true;
jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => ({
    isConnected: mockIsConnected,
    isInternetReachable: mockIsConnected,
  }),
}));

describe("SyncStatus", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsConnected = true;
    mockDatabaseContext = {
      sync: mockSync,
      isSyncing: false,
      lastSyncedAt: null,
      lastSyncError: null,
      pendingChangesCount: 0,
      hasPendingChanges: false,
    };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("shows 'Sync failed' when the last sync failed, even with changes pending", () => {
    mockDatabaseContext.lastSyncError = "Push attachments (create) failed";
    mockDatabaseContext.hasPendingChanges = true;
    mockDatabaseContext.pendingChangesCount = 3;

    const { getByText, queryByText } = render(<SyncStatus />);

    expect(getByText("Sync failed")).toBeTruthy();
    expect(queryByText("3 pending")).toBeNull();
  });

  it("prefers 'Offline' and 'Syncing...' over a sync failure", () => {
    mockDatabaseContext.lastSyncError = "Network request failed";
    mockIsConnected = false;
    const offline = render(<SyncStatus />);
    expect(offline.getByText("Offline")).toBeTruthy();
    offline.unmount();

    mockIsConnected = true;
    mockDatabaseContext.isSyncing = true;
    const syncing = render(<SyncStatus />);
    expect(syncing.getByText("Syncing...")).toBeTruthy();
  });

  it("keeps the last-synced time ticking while it stays on screen", () => {
    jest.useFakeTimers();
    mockDatabaseContext.lastSyncedAt = new Date(Date.now() - 3_000);

    const { getByText } = render(<SyncStatus />);
    expect(getByText("Just now")).toBeTruthy();

    act(() => {
      jest.advanceTimersByTime(LAST_SYNCED_TICK_MS);
    });
    expect(getByText("13s ago")).toBeTruthy();
  });

  it("shows 'Synced' when online with no pending changes", () => {
    const { getByText } = render(<SyncStatus />);
    expect(getByText("Synced")).toBeTruthy();
  });

  it("shows 'Offline' when disconnected", () => {
    mockIsConnected = false;

    const { getByText } = render(<SyncStatus />);
    expect(getByText("Offline")).toBeTruthy();
  });

  it("shows 'Syncing...' when sync is in progress", () => {
    mockDatabaseContext.isSyncing = true;

    const { getByText } = render(<SyncStatus />);
    expect(getByText("Syncing...")).toBeTruthy();
  });

  it("shows pending changes count", () => {
    mockDatabaseContext.hasPendingChanges = true;
    mockDatabaseContext.pendingChangesCount = 5;

    const { getByText } = render(<SyncStatus />);
    expect(getByText("5 pending")).toBeTruthy();
  });

  it("shows 'Never' for last synced when null", () => {
    const { getByText } = render(<SyncStatus />);
    expect(getByText("Never")).toBeTruthy();
  });

  it("shows 'Just now' for recent sync", () => {
    const now = new Date();
    mockDatabaseContext.lastSyncedAt = new Date(now.getTime() - 3000);

    const { getByText } = render(<SyncStatus />);
    expect(getByText("Just now")).toBeTruthy();
  });

  it("triggers sync when pressed while online", () => {
    const { getByLabelText } = render(<SyncStatus />);

    fireEvent.press(getByLabelText("Sync status"));

    expect(mockSync).toHaveBeenCalled();
  });

  it("does not trigger sync when pressed while offline", () => {
    mockIsConnected = false;

    const { getByLabelText } = render(<SyncStatus />);

    fireEvent.press(getByLabelText("Sync status"));

    expect(mockSync).not.toHaveBeenCalled();
  });

  it("does not trigger sync when already syncing", () => {
    mockDatabaseContext.isSyncing = true;

    const { getByLabelText } = render(<SyncStatus />);

    fireEvent.press(getByLabelText("Sync status"));

    expect(mockSync).not.toHaveBeenCalled();
  });
});
