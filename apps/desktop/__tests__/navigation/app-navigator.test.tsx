import React from "react";
import { Text, Linking } from "react-native";

import { render, fireEvent } from "../helpers/test-utils";
import { RootNavigator } from "../../src/navigation/app-navigator";

const mockUseAuth = jest.fn();
jest.mock("@/providers/auth-provider", () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock("@/lib/oauth", () => ({
  handleOAuthCallback: jest.fn(),
}));

// Screens are stubbed so this suite exercises the routing decision only — the
// real MainScreen drags in WatermelonDB and the editor bridge.
jest.mock("@/screens/main", () => ({
  MainScreen: () => {
    const { Text: RNText } = require("react-native");
    return <RNText>MAIN</RNText>;
  },
}));
jest.mock("@/screens/login", () => ({
  LoginScreen: ({ onNavigateToForgotPassword }: { onNavigateToForgotPassword?: () => void }) => {
    const { Text: RNText } = require("react-native");
    return <RNText onPress={onNavigateToForgotPassword}>LOGIN</RNText>;
  },
}));
jest.mock("@/screens/signup", () => ({
  SignupScreen: () => {
    const { Text: RNText } = require("react-native");
    return <RNText>SIGNUP</RNText>;
  },
}));
jest.mock("@/screens/forgot-password", () => ({
  ForgotPasswordScreen: () => {
    const { Text: RNText } = require("react-native");
    return <RNText>FORGOT</RNText>;
  },
}));
jest.mock("@/screens/reset-password", () => ({
  ResetPasswordScreen: () => {
    const { Text: RNText } = require("react-native");
    return <RNText>RESET</RNText>;
  },
}));
jest.mock("@/screens/waiting-for-approval", () => ({
  WaitingForApprovalScreen: () => {
    const { Text: RNText } = require("react-native");
    return <RNText>WAITING</RNText>;
  },
}));

const APPROVED_USER = { id: "user-123" };

function authState(overrides: Record<string, unknown> = {}) {
  return {
    user: null,
    session: null,
    isApproved: false,
    isLoading: false,
    isCheckingApproval: false,
    isRecovering: false,
    recoveryError: null,
    endRecovery: jest.fn(),
    signOut: jest.fn(),
    refreshApprovalStatus: jest.fn(),
    ...overrides,
  };
}

describe("RootNavigator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .spyOn(Linking, "addEventListener")
      .mockReturnValue({ remove: jest.fn() } as unknown as ReturnType<
        typeof Linking.addEventListener
      >);
    jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null);
    mockUseAuth.mockReturnValue(authState());
  });

  it("shows the login screen when signed out", () => {
    const { getByText } = render(<RootNavigator />);

    expect(getByText("LOGIN")).toBeTruthy();
  });

  it("routes to the forgot-password screen from the login screen", () => {
    const { getByText } = render(<RootNavigator />);

    fireEvent.press(getByText("LOGIN"));

    expect(getByText("FORGOT")).toBeTruthy();
  });

  it("shows the main app for an approved user", () => {
    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: true }));

    const { getByText } = render(<RootNavigator />);

    expect(getByText("MAIN")).toBeTruthy();
  });

  it("shows the waiting screen for an unapproved user", () => {
    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: false }));

    const { getByText } = render(<RootNavigator />);

    expect(getByText("WAITING")).toBeTruthy();
  });

  it("holds an approved user on the reset screen while recovering", () => {
    // The regression this branch exists to prevent: a recovery link produces a
    // real, approved session, so without the check the user lands in the app and
    // the reset screen is unreachable.
    mockUseAuth.mockReturnValue(
      authState({ user: APPROVED_USER, isApproved: true, isRecovering: true }),
    );

    const { getByText, queryByText } = render(<RootNavigator />);

    expect(getByText("RESET")).toBeTruthy();
    expect(queryByText("MAIN")).toBeNull();
  });

  it("shows the reset screen ahead of the approval gate", () => {
    mockUseAuth.mockReturnValue(
      authState({ user: APPROVED_USER, isApproved: false, isRecovering: true }),
    );

    const { getByText, queryByText } = render(<RootNavigator />);

    expect(getByText("RESET")).toBeTruthy();
    expect(queryByText("WAITING")).toBeNull();
  });

  it("shows the reset screen before the session has landed", () => {
    mockUseAuth.mockReturnValue(authState({ user: null, isRecovering: true }));

    const { getByText, queryByText } = render(<RootNavigator />);

    expect(getByText("RESET")).toBeTruthy();
    expect(queryByText("LOGIN")).toBeNull();
  });

  it("waits rather than routing while auth state is still loading", () => {
    mockUseAuth.mockReturnValue(authState({ isLoading: true }));

    const { queryByText } = render(<RootNavigator />);

    expect(queryByText("LOGIN")).toBeNull();
    expect(queryByText("RESET")).toBeNull();
  });

  it("registers a deep-link listener for the OAuth callback", () => {
    render(
      <>
        <RootNavigator />
        <Text>probe</Text>
      </>,
    );

    expect(Linking.addEventListener).toHaveBeenCalledWith("url", expect.any(Function));
  });
});
