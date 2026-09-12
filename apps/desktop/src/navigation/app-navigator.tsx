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

  // The auth stack's route is local state on a component that never unmounts, so
  // it outlives the session: without this, signing out drops the user back on
  // whichever auth screen they last used — Forgot Password, say — instead of the
  // login screen. Rewinding on the sign-in edge covers every way a session can
  // end, including an involuntary one (revoked refresh token), and can never yank
  // a signed-out user off a screen they chose. It does not cover the recovery
  // link that never yields a session — that exit still runs through the
  // `onNavigateToLogin` handed to ResetPasswordScreen below, which must stay.
  const isSignedIn = Boolean(user);

  useEffect(() => {
    if (isSignedIn) {
      setAuthRoute("Login");
    }
  }, [isSignedIn]);

  if (isLoading || isCheckingApproval) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: semantic.bg }]}>
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

  if (user && isApproved) {
    return <MainScreen />;
  }

  // Authenticated but not approved — always show waiting screen
  if (user && !isApproved) {
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
