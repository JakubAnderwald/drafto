import { useState } from "react";
import { ActivityIndicator, View, StyleSheet } from "react-native";

import { useAuth } from "@/providers/auth-provider";
import { colors } from "@/theme/tokens";
import { useTheme } from "@/providers/theme-provider";
import { LoginScreen } from "@/screens/login";
import { SignupScreen } from "@/screens/signup";
import { WaitingForApprovalScreen } from "@/screens/waiting-for-approval";
import { MainScreen } from "@/screens/main";

type AuthRoute = "Login" | "Signup" | "WaitingForApproval";

export function RootNavigator() {
  const { user, isApproved, isLoading, isCheckingApproval } = useAuth();
  const { semantic } = useTheme();
  const [authRoute, setAuthRoute] = useState<AuthRoute>("Login");

  if (isLoading || isCheckingApproval) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: semantic.bg }]}>
        <ActivityIndicator size="large" color={colors.primary[600]} />
      </View>
    );
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
    case "Login":
    default:
      return <LoginScreen onNavigateToSignup={() => setAuthRoute("Signup")} />;
  }
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
