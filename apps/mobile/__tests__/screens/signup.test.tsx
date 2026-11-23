import React from "react";
import { KeyboardAvoidingView, AccessibilityInfo, Platform } from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import { useRouter } from "expo-router";
import {
  EMAIL_REQUIRED_MESSAGE,
  INVALID_EMAIL_MESSAGE,
  PASSWORD_REQUIRED_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  SIGNUP_CONFIRMATION_SENT,
  SIGNUP_EMAIL_REDIRECT_URL,
  USER_ALREADY_EXISTS_MESSAGE,
} from "@drafto/shared";

import { render, fireEvent, waitFor } from "../helpers/test-utils";
import SignupScreen from "../../app/(auth)/signup";
import { OfflineBannerHeightContext } from "@/hooks/use-offline-banner-height";

const mockSignUp = jest.fn();
jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      signUp: (...args: unknown[]) => mockSignUp(...args),
    },
  },
}));

// OAuth is covered by its own suite; here it would only pull in the native sign-in modules.
jest.mock("@/components/auth/oauth-buttons", () => ({
  OAuthButtons: () => null,
}));

const NEW_USER = { id: "user-1", identities: [{ id: "identity-1" }] };

function fillAndSubmit({ getByPlaceholderText, getByText }: ReturnType<typeof render>) {
  fireEvent.changeText(getByPlaceholderText("you@example.com"), "  new@example.com ");
  fireEvent.changeText(getByPlaceholderText("Min. 6 characters"), "secret123");
  fireEvent.press(getByText("Sign up"));
}

describe("SignupScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSignUp.mockResolvedValue({ data: { user: NEW_USER, session: null }, error: null });
  });

  it("renders the sign-up form", () => {
    const { getByText, getByPlaceholderText } = render(<SignupScreen />);

    expect(getByText("Sign Up")).toBeTruthy();
    expect(getByPlaceholderText("you@example.com")).toBeTruthy();
    expect(getByPlaceholderText("Min. 6 characters")).toBeTruthy();
  });

  it("validates the form before calling Supabase", () => {
    const { getByText, getByPlaceholderText, getByTestId, queryByTestId } = render(
      <SignupScreen />,
    );

    fireEvent.press(getByText("Sign up"));
    expect(getByTestId("signup-email-input-error")).toHaveTextContent(EMAIL_REQUIRED_MESSAGE);
    expect(getByTestId("signup-password-input-error")).toHaveTextContent(PASSWORD_REQUIRED_MESSAGE);

    fireEvent.changeText(getByPlaceholderText("you@example.com"), "new@example.com");
    fireEvent.changeText(getByPlaceholderText("Min. 6 characters"), "12345");
    fireEvent.press(getByText("Sign up"));
    expect(queryByTestId("signup-email-input-error")).toBeNull();
    expect(getByTestId("signup-password-input-error")).toHaveTextContent(
      PASSWORD_TOO_SHORT_MESSAGE,
    );

    expect(mockSignUp).not.toHaveBeenCalled();
  });

  describe("email validation (PrimeTestLab 11035 M-02)", () => {
    it("PrimeTestLab 11035 M-02: refuses a malformed email without calling Supabase, under the field", () => {
      const { getByText, getByPlaceholderText, getByTestId, queryByTestId } = render(
        <SignupScreen />,
      );

      fireEvent.changeText(getByPlaceholderText("you@example.com"), "planner.com");
      fireEvent.changeText(getByPlaceholderText("Min. 6 characters"), "secret123");
      fireEvent.press(getByText("Sign up"));

      expect(mockSignUp).not.toHaveBeenCalled();
      expect(getByTestId("signup-email-input-error")).toHaveTextContent(INVALID_EMAIL_MESSAGE);
      expect(queryByTestId("signup-password-input-error")).toBeNull();
      // No top banner: the error belongs to the field.
      expect(queryByTestId("signup-error")).toBeNull();
    });

    it("PrimeTestLab 11035 M-02: shows the email and password errors together on the first tap", () => {
      const { getByText, getByPlaceholderText, getByTestId } = render(<SignupScreen />);

      fireEvent.changeText(getByPlaceholderText("you@example.com"), "planner.com");
      fireEvent.changeText(getByPlaceholderText("Min. 6 characters"), "abc");
      fireEvent.press(getByText("Sign up"));

      expect(getByTestId("signup-email-input-error")).toHaveTextContent(INVALID_EMAIL_MESSAGE);
      expect(getByTestId("signup-password-input-error")).toHaveTextContent(
        PASSWORD_TOO_SHORT_MESSAGE,
      );
      expect(mockSignUp).not.toHaveBeenCalled();
    });

    it("PrimeTestLab 11035 M-02: announces the inline error and carries it on the field", () => {
      const { getByText, getByPlaceholderText, getByTestId } = render(<SignupScreen />);

      fireEvent.changeText(getByPlaceholderText("you@example.com"), "planner.com");
      fireEvent.press(getByText("Sign up"));

      const error = getByTestId("signup-email-input-error");
      expect(error.props.accessibilityRole).toBe("alert");
      expect(error.props.accessibilityLiveRegion).toBe("polite");
      expect(getByTestId("signup-email-input").props.accessibilityHint).toBe(INVALID_EMAIL_MESSAGE);
    });

    it("PrimeTestLab 11035 M-02: clears a field's error once the user edits that field", () => {
      const { getByText, getByPlaceholderText, getByTestId, queryByTestId } = render(
        <SignupScreen />,
      );

      fireEvent.changeText(getByPlaceholderText("you@example.com"), "planner.com");
      fireEvent.changeText(getByPlaceholderText("Min. 6 characters"), "abc");
      fireEvent.press(getByText("Sign up"));

      fireEvent.changeText(getByPlaceholderText("you@example.com"), "planner@example.com");
      expect(queryByTestId("signup-email-input-error")).toBeNull();
      // The other field keeps its error until it is edited too.
      expect(getByTestId("signup-password-input-error")).toBeTruthy();
    });

    it("PrimeTestLab 11035 M-02: puts Supabase's format error under the field, never the raw text", async () => {
      mockSignUp.mockResolvedValue({
        data: { user: null, session: null },
        error: {
          message: "Unable to validate email address: invalid format",
          code: "validation_failed",
          status: 400,
        },
      });

      const screen = render(<SignupScreen />);
      fillAndSubmit(screen);

      await waitFor(() => {
        expect(screen.getByTestId("signup-email-input-error")).toHaveTextContent(
          INVALID_EMAIL_MESSAGE,
        );
      });
      expect(screen.queryByText(/Unable to validate/)).toBeNull();
      expect(screen.queryByTestId("signup-error")).toBeNull();
    });

    it("PrimeTestLab 11035 M-02: keeps other server errors in the banner, in plain words", async () => {
      mockSignUp.mockResolvedValue({
        data: { user: null, session: null },
        error: { message: "User already registered", code: "user_already_exists" },
      });

      const screen = render(<SignupScreen />);
      fillAndSubmit(screen);

      await waitFor(() => {
        expect(screen.getByTestId("signup-error")).toHaveTextContent(USER_ALREADY_EXISTS_MESSAGE);
      });
    });
  });

  it("sends the confirmation link to the web login page", async () => {
    const screen = render(<SignupScreen />);

    fillAndSubmit(screen);

    await waitFor(() => {
      expect(mockSignUp).toHaveBeenCalledWith({
        email: "new@example.com",
        password: "secret123",
        options: { emailRedirectTo: SIGNUP_EMAIL_REDIRECT_URL },
      });
    });
  });

  it("shows the check-email state and stays put when sign-up returns no session", async () => {
    // The App Review recording (0:36-0:51): sign-up replaced to the waiting screen, the guard
    // found no session and bounced to login, so the user never learned an email was sent.
    const replace = jest.fn();
    const push = jest.fn();
    (useRouter as jest.Mock).mockReturnValue({ replace, push, back: jest.fn() });

    const screen = render(<SignupScreen />);
    const { getByText, getByTestId, queryByText } = screen;

    fillAndSubmit(screen);

    await waitFor(() => {
      expect(getByTestId("signup-check-email")).toBeTruthy();
    });
    expect(getByText("Check Your Email")).toBeTruthy();
    expect(getByText("new@example.com")).toBeTruthy();
    expect(getByText(SIGNUP_CONFIRMATION_SENT)).toBeTruthy();
    // The form is gone, so it cannot send a second email.
    expect(queryByText("Sign up")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("shows the same check-email state for an address that already has an account", async () => {
    // Supabase answers an existing address with an obfuscated user (no identities) and no
    // session, and sends nothing: the copy must not depend on which case it was.
    mockSignUp.mockResolvedValue({
      data: { user: { id: "obfuscated", identities: [] }, session: null },
      error: null,
    });

    const screen = render(<SignupScreen />);
    const { getByText, getByTestId } = screen;

    fillAndSubmit(screen);

    await waitFor(() => {
      expect(getByTestId("signup-check-email")).toBeTruthy();
    });
    expect(getByText(SIGNUP_CONFIRMATION_SENT)).toBeTruthy();
  });

  it("leaves routing to the auth state change when sign-up returns a session", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: NEW_USER, session: { access_token: "token", user: NEW_USER } },
      error: null,
    });

    const screen = render(<SignupScreen />);
    const { getByText, queryByTestId } = screen;

    fillAndSubmit(screen);

    await waitFor(() => {
      expect(mockSignUp).toHaveBeenCalled();
    });
    expect(queryByTestId("signup-check-email")).toBeNull();
  });

  it("shows the Supabase error and keeps the form", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Signups not allowed for this instance" },
    });

    const screen = render(<SignupScreen />);
    const { getByText, queryByTestId } = screen;

    fillAndSubmit(screen);

    await waitFor(() => {
      expect(getByText("Signups not allowed for this instance")).toBeTruthy();
    });
    expect(queryByTestId("signup-check-email")).toBeNull();
  });

  it("dismisses back to the login screen below instead of pushing another one", async () => {
    const screen = render(<SignupScreen />);
    const { getByText } = screen;

    expect(getByText("Log in").props.dismissTo).toBe(true);

    fillAndSubmit(screen);

    await waitFor(() => {
      expect(getByText("Back to login").props.dismissTo).toBe(true);
    });
  });

  it("tags the password as a new password and lets the user show it", () => {
    const { getByTestId } = render(<SignupScreen />);

    const field = () => getByTestId("signup-password-input");
    // "password" would hint the current password; a sign-up field takes a new one.
    expect(field().props.autoComplete).toBe("new-password");
    expect(field().props.textContentType).toBe("newPassword");
    expect(field().props.secureTextEntry).toBe(true);

    fireEvent.press(getByTestId("signup-password-input-toggle"));
    expect(field().props.secureTextEntry).toBe(false);
  });

  it("offsets its keyboard avoidance by the header above it and, offline, the banner below that", () => {
    // The jest.setup.js mock; the header that keeps the Back button.
    jest.mocked(useHeaderHeight).mockReturnValue(91);
    try {
      const online = render(<SignupScreen />);
      expect(online.UNSAFE_getByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(91);
      online.unmount();

      const { UNSAFE_getByType } = render(
        <OfflineBannerHeightContext.Provider value={28}>
          <SignupScreen />
        </OfflineBannerHeightContext.Provider>,
      );

      expect(UNSAFE_getByType(KeyboardAvoidingView).props.keyboardVerticalOffset).toBe(91 + 28);
    } finally {
      jest.mocked(useHeaderHeight).mockReturnValue(0);
    }
  });
});

describe("SignupScreen — VoiceOver announcements (PrimeTestLab 11035 review)", () => {
  const originalOS = Platform.OS;
  let announce: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
    announce = jest
      .spyOn(AccessibilityInfo, "announceForAccessibilityWithOptions")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    announce.mockRestore();
    Object.defineProperty(Platform, "OS", { value: originalOS, configurable: true });
  });

  /** How many times VoiceOver was asked to speak `message`. */
  const announced = (message: string) =>
    announce.mock.calls.filter(([spoken]) => spoken === message).length;

  it("PrimeTestLab 11035 review: announces the error banner on each failed submit", async () => {
    mockSignUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "User already registered", code: "user_already_exists" },
    });
    const screen = render(<SignupScreen />);

    fillAndSubmit(screen);
    await waitFor(() => {
      expect(screen.getByTestId("signup-error")).toHaveTextContent(USER_ALREADY_EXISTS_MESSAGE);
    });
    expect(announced(USER_ALREADY_EXISTS_MESSAGE)).toBe(1);

    fireEvent.press(screen.getByText("Sign up"));
    await waitFor(() => {
      expect(announced(USER_ALREADY_EXISTS_MESSAGE)).toBe(2);
    });
  });
});
