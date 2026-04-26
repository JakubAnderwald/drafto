import React from "react";
import * as fs from "fs";
import * as path from "path";

import { render, fireEvent, waitFor } from "../../helpers/test-utils";
import { OAuthButtons } from "../../../src/components/auth/oauth-buttons";

const mockSignInWithOAuthBrowser = jest.fn();

jest.mock("@/lib/oauth", () => ({
  signInWithOAuthBrowser: (...args: unknown[]) => mockSignInWithOAuthBrowser(...args),
}));

describe("OAuthButtons", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignInWithOAuthBrowser.mockResolvedValue({ error: null });
  });

  it("renders Google and Apple sign-in buttons", () => {
    const { getByLabelText, getByText } = render(<OAuthButtons />);

    expect(getByLabelText("Sign in with Google")).toBeTruthy();
    expect(getByLabelText("Sign in with Apple")).toBeTruthy();
    expect(getByText("Google")).toBeTruthy();
    expect(getByText("Apple")).toBeTruthy();
  });

  it("renders an icon child inside each button (not just text)", () => {
    const { getByLabelText } = render(<OAuthButtons />);

    const googleButton = getByLabelText("Sign in with Google");
    const appleButton = getByLabelText("Sign in with Apple");

    expect(googleButton.props.children).toBeTruthy();
    expect(appleButton.props.children).toBeTruthy();
  });

  it("calls signInWithOAuthBrowser with 'google' when Google button is pressed", async () => {
    const { getByLabelText } = render(<OAuthButtons />);

    fireEvent.press(getByLabelText("Sign in with Google"));

    await waitFor(() => {
      expect(mockSignInWithOAuthBrowser).toHaveBeenCalledWith("google");
    });
  });

  it("calls signInWithOAuthBrowser with 'apple' when Apple button is pressed", async () => {
    const { getByLabelText } = render(<OAuthButtons />);

    fireEvent.press(getByLabelText("Sign in with Apple"));

    await waitFor(() => {
      expect(mockSignInWithOAuthBrowser).toHaveBeenCalledWith("apple");
    });
  });

  it("invokes onError when the OAuth flow returns an error", async () => {
    mockSignInWithOAuthBrowser.mockResolvedValue({ error: "OAuth failed" });
    const onError = jest.fn();

    const { getByLabelText } = render(<OAuthButtons onError={onError} />);
    fireEvent.press(getByLabelText("Sign in with Google"));

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith("OAuth failed");
    });
  });

  it("does not invoke onError on success", async () => {
    const onError = jest.fn();

    const { getByLabelText } = render(<OAuthButtons onError={onError} />);
    fireEvent.press(getByLabelText("Sign in with Apple"));

    await waitFor(() => {
      expect(mockSignInWithOAuthBrowser).toHaveBeenCalled();
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("disables both buttons while one OAuth flow is in progress", async () => {
    let resolveGoogle: (value: { error: string | null }) => void = () => {};
    mockSignInWithOAuthBrowser.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGoogle = resolve;
        }),
    );

    const { getByLabelText } = render(<OAuthButtons />);

    fireEvent.press(getByLabelText("Sign in with Google"));

    await waitFor(() => {
      expect(getByLabelText("Sign in with Google").props.accessibilityState?.disabled).toBe(true);
      expect(getByLabelText("Sign in with Apple").props.accessibilityState?.disabled).toBe(true);
    });

    resolveGoogle({ error: null });
  });

  describe("macOS rendering path", () => {
    // On react-native-macos, react-native-svg renders 0x0 — see PR #308.
    // We can't render Platform.OS === "macos" code paths from a Jest "node"
    // environment without breaking the React renderer's module identity, so
    // we statically assert the source imports the bundled PNG assets and that
    // the PNG files exist on disk.
    const componentPath = path.join(__dirname, "../../../src/components/auth/oauth-buttons.tsx");
    const iconsDir = path.join(__dirname, "../../../src/components/auth/icons");

    it("imports bundled PNG assets for the macOS Image fallback", () => {
      const source = fs.readFileSync(componentPath, "utf-8");

      expect(source).toMatch(/from ["']\.\/icons\/google\.png["']/);
      expect(source).toMatch(/from ["']\.\/icons\/apple\.png["']/);
    });

    it("ships PNG asset files at 1x, 2x, and 3x resolutions", () => {
      for (const provider of ["google", "apple"]) {
        for (const suffix of ["", "@2x", "@3x"]) {
          const file = path.join(iconsDir, `${provider}${suffix}.png`);
          expect(fs.existsSync(file)).toBe(true);
        }
      }
    });

    it("uses Platform.OS === 'macos' to switch to Image-based icons", () => {
      const source = fs.readFileSync(componentPath, "utf-8");

      expect(source).toMatch(/Platform\.OS === ["']macos["']/);
      expect(source).toMatch(/<Image\b/);
    });
  });
});
