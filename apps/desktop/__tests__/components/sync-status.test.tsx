import React from "react";

import { render, fireEvent } from "../helpers/test-utils";
import { SyncStatus } from "../../src/components/sync-status";

const mockSync = jest.fn().mockResolvedValue(undefined);
let mockDatabaseContext = {
  sync: mockSync,
  isSyncing: false,
  lastSyncedAt: null as Date | null,
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
      pendingChangesCount: 0,
      hasPendingChanges: false,
    };
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
