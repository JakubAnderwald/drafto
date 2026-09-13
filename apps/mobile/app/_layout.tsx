import { useEffect } from "react";
import { ActivityIndicator, LogBox, View, StyleSheet } from "react-native";
import { Stack, useSegments, useRouter } from "expo-router";

LogBox.ignoreAllLogs();
import { StatusBar } from "expo-status-bar";

import { AuthProvider, useAuth } from "@/providers/auth-provider";
import { DatabaseProvider } from "@/providers/database-provider";
import { configureGoogleSignIn } from "@/lib/oauth";
import { ThemeProvider, useTheme } from "@/providers/theme-provider";
import { OfflineBanner } from "@/components/offline-banner";
import { ToastProvider } from "@/components/toast";
import { colors } from "@/theme/tokens";
import { markStartupBegin, markStartupEnd } from "@/lib/performance";

markStartupBegin();
configureGoogleSignIn();

/**
 * Screens an unauthenticated visitor may sit on without being bounced to login.
 *
 * `reset-password` is public because a recovery link cold-starts the app
 * straight onto it: Expo Router renders the screen before the deep-link handler
 * has established the session, and bouncing during that window would throw the
 * link away. With no session and no recovery in flight the screen shows its own
 * expired-link message.
 */
const PUBLIC_AUTH_SCREENS = new Set(["login", "signup", "forgot-password", "reset-password"]);

const RESET_PASSWORD_SCREEN = "reset-password";

export function RouteGuard({ children }: { children: React.ReactNode }) {
  const { user, isApproved, isLoading, isCheckingApproval, isRecovering } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading || isCheckingApproval) return;

    const segmentArray = segments as string[];
    const inAuthGroup = segmentArray[0] === "(auth)";
    const isPublicAuthScreen = inAuthGroup && PUBLIC_AUTH_SCREENS.has(segmentArray[1]);

    // A recovery session is a real session, so this has to win over both the
    // approval gate and the signed-in redirect below — otherwise the reset
    // screen is unreachable and the user lands in the app with a password they
    // never chose.
    if (isRecovering) {
      if (segmentArray[1] !== RESET_PASSWORD_SCREEN) {
        router.replace("/(auth)/reset-password");
      }
      return;
    }

    if (!user) {
      if (!isPublicAuthScreen) {
        router.replace("/(auth)/login");
      }
    } else if (!isApproved) {
      if (segmentArray[1] !== "waiting-for-approval") {
        router.replace("/(auth)/waiting-for-approval");
      }
    } else {
      if (inAuthGroup) {
        router.replace("/(tabs)");
      }
    }
  }, [user, isApproved, isLoading, isCheckingApproval, isRecovering, segments, router]);

  useEffect(() => {
    if (!isLoading && !isCheckingApproval) {
      markStartupEnd();
    }
  }, [isLoading, isCheckingApproval]);

  if (isLoading || isCheckingApproval) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary[600]} />
      </View>
    );
  }

  return <>{children}</>;
}

function ThemedStack() {
  const { semantic, isDark } = useTheme();

  return (
    <>
      <View style={[styles.rootContainer, { backgroundColor: semantic.bg }]}>
        <OfflineBanner />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: semantic.bg },
            headerTintColor: semantic.fg,
            contentStyle: { backgroundColor: semantic.bg },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="(auth)/login" options={{ title: "Log In" }} />
          <Stack.Screen name="(auth)/signup" options={{ title: "Sign Up" }} />
          <Stack.Screen name="(auth)/forgot-password" options={{ title: "Forgot Password" }} />
          <Stack.Screen
            name="(auth)/reset-password"
            options={{ title: "Reset Password", headerBackVisible: false }}
          />
          <Stack.Screen
            name="(auth)/waiting-for-approval"
            options={{
              title: "Awaiting Approval",
              headerBackVisible: false,
            }}
          />
          <Stack.Screen name="notebooks/[id]" options={{ title: "Notes" }} />
          <Stack.Screen name="notes/[id]" options={{ title: "Editor" }} />
          <Stack.Screen name="search" options={{ title: "Search", presentation: "modal" }} />
        </Stack>
      </View>
      <StatusBar style={isDark ? "light" : "dark"} />
    </>
  );
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ToastProvider>
          <DatabaseProvider>
            <RouteGuard>
              <ThemedStack />
            </RouteGuard>
          </DatabaseProvider>
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  rootContainer: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
