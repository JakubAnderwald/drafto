import React from "react";
import { Alert, type AlertButton } from "react-native";
import { describeAccountDeletionFailure } from "@drafto/shared";

import { render, fireEvent, waitFor, act } from "../helpers/test-utils";
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

const mockSync = jest.fn();
jest.mock("@/providers/database-provider", () => ({
  useDatabase: () => ({ database: {}, sync: mockSync }),
}));

const mockCountUnsyncedChanges = jest.fn();
jest.mock("@/lib/data/unsynced-changes", () => ({
  countUnsyncedChanges: (...args: unknown[]) => mockCountUnsyncedChanges(...args),
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
    mockSync.mockResolvedValue({ uploaded: 0, failed: 0 });
    mockCountUnsyncedChanges.mockResolvedValue(0);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders the Delete account row in the Account section", () => {
    const { getByTestId, getByText, queryByText } = render(<SettingsScreen />);

    expect(getByText("Account")).toBeTruthy();
    expect(getByTestId("delete-account-row")).toBeEnabled();
    expect(getByText("Delete account")).toBeTruthy();
    expect(queryByText(OFFLINE_NOTE)).toBeNull();
  });

  it("signs out straight away when nothing is waiting to sync", async () => {
    const alert = jest.spyOn(Alert, "alert");
    const { getByLabelText } = render(<SettingsScreen />);

    fireEvent.press(getByLabelText("Sign out"));

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1);
    });
    // Nothing to push, so the provider's own last flush is skipped too.
    expect(mockSignOut).toHaveBeenCalledWith({ skipFinalSync: true });
    expect(mockSync).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  describe("sign-out with unsynced changes", () => {
    /** The buttons of the confirmation the screen raised. */
    function alertButtons(alert: jest.SpyInstance): AlertButton[] {
      return (alert.mock.calls[0][2] ?? []) as AlertButton[];
    }

    it("syncs first and signs out without asking once everything is synced", async () => {
      mockCountUnsyncedChanges.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
      const alert = jest.spyOn(Alert, "alert");
      const { getByLabelText } = render(<SettingsScreen />);

      fireEvent.press(getByLabelText("Sign out"));

      await waitFor(() => {
        expect(mockSignOut).toHaveBeenCalledTimes(1);
      });
      expect(mockSync).toHaveBeenCalledTimes(1);
      expect(alert).not.toHaveBeenCalled();
    });

    it("warns how many changes would be lost and keeps the account on Cancel", async () => {
      // The App Review recording (2:59) signed out with 3 pending changes and lost them silently.
      mockCountUnsyncedChanges.mockResolvedValue(3);
      const alert = jest.spyOn(Alert, "alert");
      const { getByLabelText } = render(<SettingsScreen />);

      fireEvent.press(getByLabelText("Sign out"));

      await waitFor(() => {
        expect(alert).toHaveBeenCalledTimes(1);
      });
      expect(mockSync).toHaveBeenCalledTimes(1);
      expect(alert.mock.calls[0][1]).toBe("3 changes haven't synced and will be lost.");
      const buttons = alertButtons(alert);
      expect(buttons.map((button) => button.text)).toEqual(["Cancel", "Sign out anyway"]);
      expect(buttons[1].style).toBe("destructive");

      await act(async () => {
        buttons[0].onPress?.();
      });

      expect(mockSignOut).not.toHaveBeenCalled();
      // The button comes back for another try.
      expect(getByLabelText("Sign out")).toBeEnabled();
    });

    it("signs out on Sign out anyway", async () => {
      mockCountUnsyncedChanges.mockResolvedValue(1);
      const alert = jest.spyOn(Alert, "alert");
      const { getByLabelText } = render(<SettingsScreen />);

      fireEvent.press(getByLabelText("Sign out"));

      await waitFor(() => {
        expect(alert).toHaveBeenCalledTimes(1);
      });
      expect(alert.mock.calls[0][1]).toBe("1 change hasn't synced and will be lost.");

      await act(async () => {
        alertButtons(alert)[1].onPress?.();
      });

      // The sync has just failed, so the provider does not try again for another 10 s.
      expect(mockSignOut).toHaveBeenCalledWith({ skipFinalSync: true });
    });

    it("shows progress and ignores further presses while it works", async () => {
      let finishSync: () => void = () => {};
      mockSync.mockReturnValue(
        new Promise<void>((resolve) => {
          finishSync = resolve;
        }),
      );
      mockCountUnsyncedChanges.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
      const { getByLabelText, getByTestId, queryByText } = render(<SettingsScreen />);

      fireEvent.press(getByLabelText("Sign out"));

      await waitFor(() => {
        expect(mockSync).toHaveBeenCalledTimes(1);
      });
      expect(getByLabelText("Sign out")).toBeDisabled();
      // A deletion cannot start while the device is being signed out and wiped, and the
      // offline note does not claim a connection problem.
      expect(getByTestId("delete-account-row")).toBeDisabled();
      expect(queryByText(OFFLINE_NOTE)).toBeNull();
      fireEvent.press(getByLabelText("Sign out"));

      await act(async () => {
        finishSync();
      });

      await waitFor(() => {
        expect(mockSignOut).toHaveBeenCalledTimes(1);
      });
      expect(mockSync).toHaveBeenCalledTimes(1);
    });

    it("still signs out, unwarned as before, when the pending count cannot be read", async () => {
      jest.spyOn(console, "error").mockImplementation(() => {});
      mockCountUnsyncedChanges.mockRejectedValue(new Error("SQLite busy"));
      const alert = jest.spyOn(Alert, "alert");
      const { getByLabelText } = render(<SettingsScreen />);

      fireEvent.press(getByLabelText("Sign out"));

      await waitFor(() => {
        expect(mockSignOut).toHaveBeenCalledTimes(1);
      });
      // With the provider's own last flush, as before.
      expect(mockSignOut).toHaveBeenCalledWith();
      expect(alert).not.toHaveBeenCalled();
    });
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
