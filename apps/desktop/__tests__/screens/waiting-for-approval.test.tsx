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

  it("renders waiting message", () => {
    const { getByText } = render(<WaitingForApprovalScreen />);

    expect(getByText("Awaiting Approval")).toBeTruthy();
    expect(getByText(/pending admin approval/)).toBeTruthy();
  });

  it("shows check approval button and sign out button", () => {
    const { getByText } = render(<WaitingForApprovalScreen />);

    expect(getByText("Check approval status")).toBeTruthy();
    expect(getByText("Sign out")).toBeTruthy();
  });

  it("calls refreshApprovalStatus when check button is pressed", async () => {
    const { getByText } = render(<WaitingForApprovalScreen />);

    fireEvent.press(getByText("Check approval status"));

    await waitFor(() => {
      expect(mockRefreshApprovalStatus).toHaveBeenCalled();
    });
  });

  it("shows still pending message when not approved", async () => {
    mockRefreshApprovalStatus.mockResolvedValue(false);

    const { getByText } = render(<WaitingForApprovalScreen />);

    fireEvent.press(getByText("Check approval status"));

    await waitFor(() => {
      expect(getByText("Your account is still pending approval.")).toBeTruthy();
    });
  });

  it("shows error message when check fails", async () => {
    mockRefreshApprovalStatus.mockRejectedValue(new Error("Network error"));

    const { getByText } = render(<WaitingForApprovalScreen />);

    fireEvent.press(getByText("Check approval status"));

    await waitFor(() => {
      expect(getByText("Unable to check approval status. Please try again.")).toBeTruthy();
    });
  });

  it("does not show error when approved", async () => {
    mockRefreshApprovalStatus.mockResolvedValue(true);

    const { getByText, queryByText } = render(<WaitingForApprovalScreen />);

    fireEvent.press(getByText("Check approval status"));

    await waitFor(() => {
      expect(mockRefreshApprovalStatus).toHaveBeenCalled();
    });

    // No error message should be shown when approved
    expect(queryByText("Your account is still pending approval.")).toBeNull();
  });

  it("calls signOut when sign out button is pressed", async () => {
    const { getByText } = render(<WaitingForApprovalScreen />);

    fireEvent.press(getByText("Sign out"));

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalled();
    });
  });
});
