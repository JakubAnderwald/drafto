import React from "react";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import { WaitingForApprovalScreen } from "../../src/screens/waiting-for-approval";

const mockSignOut = jest.fn().mockResolvedValue(undefined);
const mockRefreshApprovalStatus = jest.fn().mockResolvedValue(false);

jest.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({
    signOut: mockSignOut,
    refreshApprovalStatus: mockRefreshApprovalStatus,
  }),
}));

describe("WaitingForApprovalScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignOut.mockResolvedValue(undefined);
    mockRefreshApprovalStatus.mockResolvedValue(false);
  });

  it("says the account isn't active and points to support", () => {
    const { getByText } = render(<WaitingForApprovalScreen />);

    expect(getByText("Account not active")).toBeTruthy();
    expect(
      getByText(
        /This account isn.t active, so it can.t reach its notes. If you think this is a mistake, contact support@drafto\.eu\./,
      ),
    ).toBeTruthy();
  });

  it("shows the check-again and sign-out buttons", () => {
    const { getByText } = render(<WaitingForApprovalScreen />);

    expect(getByText("Check again")).toBeTruthy();
    expect(getByText("Sign out")).toBeTruthy();
  });

  it("calls refreshApprovalStatus when check button is pressed", async () => {
    const { getByText } = render(<WaitingForApprovalScreen />);

    fireEvent.press(getByText("Check again"));

    await waitFor(() => {
      expect(mockRefreshApprovalStatus).toHaveBeenCalled();
    });
  });

  it("says the account still isn't active when the check finds it inactive", async () => {
    mockRefreshApprovalStatus.mockResolvedValue(false);

    const { getByText } = render(<WaitingForApprovalScreen />);

    fireEvent.press(getByText("Check again"));

    await waitFor(() => {
      expect(getByText("This account still isn't active.")).toBeTruthy();
    });
  });

  it("shows error message when check fails", async () => {
    mockRefreshApprovalStatus.mockRejectedValue(new Error("Network error"));

    const { getByText } = render(<WaitingForApprovalScreen />);

    fireEvent.press(getByText("Check again"));

    await waitFor(() => {
      expect(getByText("Couldn't check the account. Please try again.")).toBeTruthy();
    });
  });

  it("does not show error when approved", async () => {
    mockRefreshApprovalStatus.mockResolvedValue(true);

    const { getByText, queryByText } = render(<WaitingForApprovalScreen />);

    fireEvent.press(getByText("Check again"));

    await waitFor(() => {
      expect(mockRefreshApprovalStatus).toHaveBeenCalled();
    });

    // No error message should be shown when approved
    expect(queryByText("This account still isn't active.")).toBeNull();
  });

  it("calls signOut when sign out button is pressed", async () => {
    const { getByText } = render(<WaitingForApprovalScreen />);

    fireEvent.press(getByText("Sign out"));

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalled();
    });
  });
});
