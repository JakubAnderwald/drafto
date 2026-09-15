import React from "react";
import { describeAccountDeletionFailure } from "@drafto/shared";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import SettingsScreen from "../../app/(tabs)/settings";

const mockSignOut = jest.fn();
const mockDeleteAccount = jest.fn();
jest.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    session: {},
    isApproved: true,
    isLoading: false,
    signOut: mockSignOut,
    deleteAccount: mockDeleteAccount,
  }),
}));

// SyncStatus reads the database provider; it is covered by its own test.
jest.mock("@/components/sync-status", () => ({
  SyncStatus: () => null,
}));

const mockUseNetworkStatus = jest.fn();
jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => mockUseNetworkStatus(),
}));

const mockHapticsWarning = jest.fn();
jest.mock("@/hooks/use-haptics", () => ({
  useHaptics: () => ({
    light: jest.fn(),
    medium: jest.fn(),
    heavy: jest.fn(),
    success: jest.fn(),
    warning: mockHapticsWarning,
    error: jest.fn(),
    selection: jest.fn(),
  }),
}));

const OFFLINE_NOTE = "Deleting your account needs an internet connection.";

describe("SettingsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignOut.mockResolvedValue(undefined);
    mockDeleteAccount.mockResolvedValue({ status: "network" });
    mockUseNetworkStatus.mockReturnValue({ isConnected: true, isInternetReachable: true });
  });

  it("renders the Delete account row in the Account section", () => {
    const { getByTestId, getByText, queryByText } = render(<SettingsScreen />);

    expect(getByText("Account")).toBeTruthy();
    expect(getByTestId("delete-account-row")).toBeEnabled();
    expect(getByText("Delete account")).toBeTruthy();
    expect(queryByText(OFFLINE_NOTE)).toBeNull();
  });

  it("still signs out from the Sign Out button", () => {
    const { getByLabelText } = render(<SettingsScreen />);

    fireEvent.press(getByLabelText("Sign out"));

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it("disables the row and explains why while offline", () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: false, isInternetReachable: false });

    const { getByTestId, getByText, queryByText } = render(<SettingsScreen />);

    expect(getByTestId("delete-account-row")).toBeDisabled();
    expect(getByText(OFFLINE_NOTE)).toBeTruthy();

    fireEvent.press(getByTestId("delete-account-row"));
    expect(queryByText("Delete account?")).toBeNull();
  });

  it("disables the row when connected but the internet is known to be unreachable", () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: true, isInternetReachable: false });

    const { getByTestId, getByText } = render(<SettingsScreen />);

    expect(getByTestId("delete-account-row")).toBeDisabled();
    expect(getByText(OFFLINE_NOTE)).toBeTruthy();
  });

  it("keeps the row enabled while internet reachability is still unknown", () => {
    mockUseNetworkStatus.mockReturnValue({ isConnected: true, isInternetReachable: null });

    const { getByTestId, queryByText } = render(<SettingsScreen />);

    expect(getByTestId("delete-account-row")).toBeEnabled();
    expect(queryByText(OFFLINE_NOTE)).toBeNull();
  });

  it("opens the confirmation dialog when the row is pressed", () => {
    const { getByTestId, getByText, queryByText } = render(<SettingsScreen />);

    expect(queryByText("Delete account?")).toBeNull();

    fireEvent.press(getByTestId("delete-account-row"));

    expect(getByText("Delete account?")).toBeTruthy();
    expect(getByText("Type DELETE to confirm")).toBeTruthy();
    expect(mockHapticsWarning).toHaveBeenCalled();
  });

  it("closes the dialog on cancel without deleting anything", () => {
    const { getByTestId, queryByText } = render(<SettingsScreen />);

    fireEvent.press(getByTestId("delete-account-row"));
    fireEvent.press(getByTestId("delete-account-cancel"));

    expect(queryByText("Delete account?")).toBeNull();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(getByTestId("delete-account-row")).toBeTruthy();
  });

  it("calls deleteAccount from the auth provider once DELETE is confirmed", async () => {
    const { getByTestId, findByText } = render(<SettingsScreen />);

    fireEvent.press(getByTestId("delete-account-row"));
    fireEvent.changeText(getByTestId("delete-account-input"), "DELETE");
    fireEvent.press(getByTestId("delete-account-confirm"));

    await waitFor(() => {
      expect(mockDeleteAccount).toHaveBeenCalledTimes(1);
    });
    expect(await findByText(describeAccountDeletionFailure({ status: "network" }))).toBeTruthy();
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
