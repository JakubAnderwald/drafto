import React from "react";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import WaitingForApprovalScreen from "../../app/(auth)/waiting-for-approval";

const mockRefreshApprovalStatus = jest.fn();
const mockSignOut = jest.fn();
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
  });

  it("says the account still isn't active when the check comes back inactive", async () => {
    // The route guard keeps this screen mounted during the check now, so the message survives.
    mockRefreshApprovalStatus.mockResolvedValue(false);
    const { getByText } = render(<WaitingForApprovalScreen />);

    fireEvent.press(getByText("Check again"));

    await waitFor(() => {
      expect(getByText("This account still isn't active.")).toBeTruthy();
    });
  });

  it("shows no message when the account turns out to be approved", async () => {
    mockRefreshApprovalStatus.mockResolvedValue(true);
    const { getByText, queryByText } = render(<WaitingForApprovalScreen />);

    fireEvent.press(getByText("Check again"));

    await waitFor(() => {
      expect(mockRefreshApprovalStatus).toHaveBeenCalledTimes(1);
    });
    expect(queryByText("This account still isn't active.")).toBeNull();
  });

  it("explains a check that failed outright", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockRefreshApprovalStatus.mockRejectedValue(new Error("Network request failed"));
    const { getByText } = render(<WaitingForApprovalScreen />);

    fireEvent.press(getByText("Check again"));

    await waitFor(() => {
      expect(getByText("Couldn't check the account. Please try again.")).toBeTruthy();
    });
  });
});
