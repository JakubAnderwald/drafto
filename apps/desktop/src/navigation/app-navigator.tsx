import { useState, useEffect } from "react";
import { ActivityIndicator, View, StyleSheet, Linking } from "react-native";

import { useAuth } from "@/providers/auth-provider";
import { handleOAuthCallback } from "@/lib/oauth";
import { colors } from "@/theme/tokens";
import { useTheme } from "@/providers/theme-provider";
import { LoginScreen } from "@/screens/login";
import { SignupScreen } from "@/screens/signup";
import { ForgotPasswordScreen } from "@/screens/forgot-password";
import { ResetPasswordScreen } from "@/screens/reset-password";
import { WaitingForApprovalScreen } from "@/screens/waiting-for-approval";
import { MainScreen } from "@/screens/main";

type AuthRoute = "Login" | "Signup" | "ForgotPassword";

/** Which side of the auth gate is on screen: the auth flow, the approval wait, or the app. */
type Gate = "auth" | "waiting" | "main";

function resolveGate(isSignedIn: boolean, isApproved: boolean): Gate {
  if (!isSignedIn) return "auth";
  return isApproved ? "main" : "waiting";
}

export function RootNavigator() {
  const { user, isApproved, isLoading, isCheckingApproval, isRecovering } = useAuth();
  const { semantic } = useTheme();
  const [authRoute, setAuthRoute] = useState<AuthRoute>("Login");

  useEffect(() => {
    // Handle OAuth callback deep links (eu.drafto.desktop://auth/callback)
    const subscription = Linking.addEventListener("url", ({ url }) => {
      handleOAuthCallback(url);
    });

    // Check if the app was opened via a deep link. Recovery callbacks share this
    // scheme but are consumed by AuthProvider's own listener — handleOAuthCallback
    // ignores them so the single-use code is not spent twice.
    Linking.getInitialURL()
      .then((url) => {
        if (url) handleOAuthCallback(url);
      })
      .catch((error) => {
        console.error("Failed to read the initial deep link:", error);
      });

    return () => subscription.remove();
  }, []);

  const isSignedIn = Boolean(user);

  // An approval check in flight holds the screen that was last decided instead of swapping it
  // for a spinner. A spinner unmounted the waiting screen on "Check approval status", losing
  // its "still pending" message (#676), and would blank the open editor on any re-check. On
  // sign-in the login screen stays up for the check, so neither an approved user sees the
  // waiting screen flash nor an unapproved one the app. Signing out is never held: a check
  // still in flight must not keep a signed-out user in the app. Updating state during render
  // is React's pattern for deriving from a previous render.
  const currentGate = resolveGate(isSignedIn, isApproved);
  const holdGate = isCheckingApproval && isSignedIn;
  const [settledGate, setSettledGate] = useState<Gate>(currentGate);
  if (!holdGate && settledGate !== currentGate) {
    setSettledGate(currentGate);
  }
  const gate = holdGate ? settledGate : currentGate;

  // The auth stack's route is local state on a component that never unmounts, so
  // it outlives the session: without this, signing out drops the user back on
  // whichever auth screen they last used — Forgot Password, say — instead of the
  // login screen. Rewinding once the gate leaves the auth flow covers every way a
  // session can end, including an involuntary one (revoked refresh token), and can
  // never yank a signed-out user off a screen they chose. It waits for the gate,
  // not the bare sign-in: during the approval check that follows a sign-in the auth
  // screen stays up, and rewinding then would swap Sign Up for Log In mid-check. It
  // does not cover the recovery link that never yields a session — that exit still
  // runs through the `onNavigateToLogin` handed to ResetPasswordScreen below, which
  // must stay.
  const hasLeftAuth = gate !== "auth";

  useEffect(() => {
    if (hasLeftAuth) {
      setAuthRoute("Login");
    }
  }, [hasLeftAuth]);

  // Only the first auth read blanks the window. isLoading stays true through the launch-time
  // approval check, so nothing is shown on a stale approval at start-up.
  if (isLoading) {
    return (
      <View
        style={[styles.loadingContainer, { backgroundColor: semantic.bg }]}
        testID="navigator-loading"
      >
        <ActivityIndicator size="large" color={colors.primary[600]} />
      </View>
    );
  }

  // A password-recovery session is a real session, so this has to win over both
  // the approval gate and the main-app branch below — otherwise the reset screen
  // is unreachable and the user lands in the app with a password they never
  // chose. It also precedes the `user` checks because the flag is set the moment
  // the link is recognised, before the code exchange resolves.
  if (isRecovering) {
    return <ResetPasswordScreen onNavigateToLogin={() => setAuthRoute("Login")} />;
  }

  if (gate === "main") {
    return <MainScreen />;
  }

  // Authenticated but not approved — always show waiting screen
  if (gate === "waiting") {
    return <WaitingForApprovalScreen />;
  }

  // Not authenticated — show login/signup flow
  switch (authRoute) {
    case "Signup":
      return <SignupScreen onNavigateToLogin={() => setAuthRoute("Login")} />;
    case "ForgotPassword":
      return <ForgotPasswordScreen onNavigateToLogin={() => setAuthRoute("Login")} />;
    case "Login":
    default:
      return (
        <LoginScreen
          onNavigateToSignup={() => setAuthRoute("Signup")}
          onNavigateToForgotPassword={() => setAuthRoute("ForgotPassword")}
        />
      );
  }
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
