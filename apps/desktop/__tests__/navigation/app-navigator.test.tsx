import React from "react";
import { Text, Linking } from "react-native";

import { render, fireEvent } from "../helpers/test-utils";
import { RootNavigator } from "@/navigation/app-navigator";

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
  LoginScreen: ({
    onNavigateToForgotPassword,
    onNavigateToSignup,
  }: {
    onNavigateToForgotPassword?: () => void;
    onNavigateToSignup?: () => void;
  }) => {
    const { Text: RNText } = require("react-native");
    return (
      <>
        <RNText onPress={onNavigateToForgotPassword}>LOGIN</RNText>
        <RNText onPress={onNavigateToSignup}>TO-SIGNUP</RNText>
      </>
    );
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
// Counts mounts, so a test can tell "still the same screen" from "unmounted and remounted".
const mockWaitingMounts = jest.fn();
jest.mock("@/screens/waiting-for-approval", () => ({
  WaitingForApprovalScreen: () => {
    const { useEffect } = require("react");
    const { Text: RNText } = require("react-native");
    useEffect(() => {
      mockWaitingMounts();
    }, []);
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

  it("lands on login after signing out from a session reached via forgot-password", () => {
    // The reporter's regression: the auth route is state on a component that
    // never unmounts, so after a reset round-trip a sign-out re-rendered the
    // forgot-password screen instead of login.
    const { getByText, queryByText, rerender } = render(<RootNavigator />);

    fireEvent.press(getByText("LOGIN"));
    expect(getByText("FORGOT")).toBeTruthy();

    // The recovery link lands, the password is reset, and the session goes live.
    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: true }));
    rerender(<RootNavigator />);
    expect(getByText("MAIN")).toBeTruthy();

    mockUseAuth.mockReturnValue(authState());
    rerender(<RootNavigator />);

    expect(getByText("LOGIN")).toBeTruthy();
    expect(queryByText("FORGOT")).toBeNull();
  });

  it("lands on login after signing out from a session reached via signup", () => {
    const { getByText, queryByText, rerender } = render(<RootNavigator />);

    fireEvent.press(getByText("TO-SIGNUP"));
    expect(getByText("SIGNUP")).toBeTruthy();

    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: true }));
    rerender(<RootNavigator />);
    expect(getByText("MAIN")).toBeTruthy();

    mockUseAuth.mockReturnValue(authState());
    rerender(<RootNavigator />);

    expect(getByText("LOGIN")).toBeTruthy();
    expect(queryByText("SIGNUP")).toBeNull();
  });

  it("keeps a signed-out user on the forgot-password screen they opened", () => {
    // The rewind must only fire on a session — it must not yank a signed-out
    // user off the screen they are actively using.
    const { getByText, queryByText, rerender } = render(<RootNavigator />);

    fireEvent.press(getByText("LOGIN"));
    rerender(<RootNavigator />);

    expect(getByText("FORGOT")).toBeTruthy();
    expect(queryByText("LOGIN")).toBeNull();
  });

  it("waits rather than routing while auth state is still loading", () => {
    mockUseAuth.mockReturnValue(authState({ isLoading: true }));

    const { queryByText } = render(<RootNavigator />);

    expect(queryByText("LOGIN")).toBeNull();
    expect(queryByText("RESET")).toBeNull();
  });

  it("shows its spinner only for the first auth read", () => {
    mockUseAuth.mockReturnValue(authState({ isLoading: true }));
    const { getByTestId, rerender, queryByTestId } = render(<RootNavigator />);

    expect(getByTestId("navigator-loading")).toBeTruthy();

    mockUseAuth.mockReturnValue(
      authState({ user: APPROVED_USER, isApproved: true, isCheckingApproval: true }),
    );
    rerender(<RootNavigator />);

    expect(queryByTestId("navigator-loading")).toBeNull();
  });

  it("keeps the waiting screen mounted through a manual approval check (#676)", () => {
    // A spinner swap unmounted the screen, so its "still pending approval" message was lost.
    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: false }));
    const { getByText, queryByTestId, rerender } = render(<RootNavigator />);
    expect(mockWaitingMounts).toHaveBeenCalledTimes(1);

    mockUseAuth.mockReturnValue(
      authState({ user: APPROVED_USER, isApproved: false, isCheckingApproval: true }),
    );
    rerender(<RootNavigator />);
    expect(getByText("WAITING")).toBeTruthy();
    expect(queryByTestId("navigator-loading")).toBeNull();

    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: false }));
    rerender(<RootNavigator />);

    expect(getByText("WAITING")).toBeTruthy();
    expect(mockWaitingMounts).toHaveBeenCalledTimes(1);
  });

  it("opens the app once a manual check finds the account approved", () => {
    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: false }));
    const { getByText, rerender } = render(<RootNavigator />);

    mockUseAuth.mockReturnValue(
      authState({ user: APPROVED_USER, isApproved: false, isCheckingApproval: true }),
    );
    rerender(<RootNavigator />);
    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: true }));
    rerender(<RootNavigator />);

    expect(getByText("MAIN")).toBeTruthy();
  });

  it("keeps the app on screen through an approval re-check", () => {
    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: true }));
    const { getByText, rerender } = render(<RootNavigator />);

    mockUseAuth.mockReturnValue(
      authState({ user: APPROVED_USER, isApproved: true, isCheckingApproval: true }),
    );
    rerender(<RootNavigator />);

    expect(getByText("MAIN")).toBeTruthy();
  });

  it("holds the login screen during a sign-in's approval check, with no waiting-screen flash", () => {
    const { getByText, queryByText, rerender } = render(<RootNavigator />);
    expect(getByText("LOGIN")).toBeTruthy();

    // isApproved is still the signed-out default while the check runs.
    mockUseAuth.mockReturnValue(
      authState({ user: APPROVED_USER, isApproved: false, isCheckingApproval: true }),
    );
    rerender(<RootNavigator />);
    expect(getByText("LOGIN")).toBeTruthy();
    expect(queryByText("WAITING")).toBeNull();

    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: true }));
    rerender(<RootNavigator />);
    expect(getByText("MAIN")).toBeTruthy();
    expect(mockWaitingMounts).not.toHaveBeenCalled();
  });

  it("keeps Sign Up on screen while a sign-up session's approval check runs", () => {
    // Confirmation off: sign-up itself signs the user in. Rewinding the auth route on the bare
    // sign-in would flash the login form during the check.
    const { getByText, queryByText, rerender } = render(<RootNavigator />);
    fireEvent.press(getByText("TO-SIGNUP"));

    mockUseAuth.mockReturnValue(
      authState({ user: APPROVED_USER, isApproved: false, isCheckingApproval: true }),
    );
    rerender(<RootNavigator />);
    expect(getByText("SIGNUP")).toBeTruthy();
    expect(queryByText("LOGIN")).toBeNull();

    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: false }));
    rerender(<RootNavigator />);
    expect(getByText("WAITING")).toBeTruthy();

    // ...and the auth route is still rewound for the next sign-out.
    mockUseAuth.mockReturnValue(authState());
    rerender(<RootNavigator />);
    expect(getByText("LOGIN")).toBeTruthy();
  });

  it("never holds a signed-out user in the app behind a check still in flight", () => {
    mockUseAuth.mockReturnValue(authState({ user: APPROVED_USER, isApproved: true }));
    const { getByText, queryByText, rerender } = render(<RootNavigator />);

    mockUseAuth.mockReturnValue(authState({ user: null, isCheckingApproval: true }));
    rerender(<RootNavigator />);

    expect(getByText("LOGIN")).toBeTruthy();
    expect(queryByText("MAIN")).toBeNull();
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
