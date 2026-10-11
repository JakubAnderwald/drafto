import React from "react";

const mockSignInWithGoogle = jest.fn();
const mockSignInWithApple = jest.fn();

jest.mock("@/lib/oauth", () => ({
  signInWithGoogle: () => mockSignInWithGoogle(),
  signInWithApple: () => mockSignInWithApple(),
}));

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import { OAuthButtons } from "@/components/auth/oauth-buttons";
import {
  clearAuthCallbackError,
  getAuthCallbackError,
  reportAuthCallbackError,
} from "@/lib/auth-callback-errors";

describe("OAuthButtons", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignInWithGoogle.mockResolvedValue({ error: null });
    mockSignInWithApple.mockResolvedValue({ error: null });
  });

  afterEach(() => clearAuthCallbackError());

  it.each([
    ["Google", mockSignInWithGoogle],
    ["Apple", mockSignInWithApple],
  ])("drops a held Apple callback error when a %s sign-in starts", async (label, signIn) => {
    reportAuthCallbackError("Apple Sign-In failed. Please try again.");
    const { getByText } = render(<OAuthButtons />);

    fireEvent.press(getByText(label));

    expect(getAuthCallbackError()).toBeNull();
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
  });

  it("passes a sign-in error to the screen", async () => {
    mockSignInWithApple.mockResolvedValue({ error: "Apple Sign-In failed. Please try again." });
    const onError = jest.fn();
    const { getByText } = render(<OAuthButtons onError={onError} />);

    fireEvent.press(getByText("Apple"));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("Apple Sign-In failed. Please try again."),
    );
  });
});
