import { useEffect } from "react";
import { ActivityIndicator, LogBox, Platform, View, StyleSheet } from "react-native";
import { Stack, useSegments, useRouter } from "expo-router";

LogBox.ignoreAllLogs();
import { StatusBar } from "expo-status-bar";

import { AuthProvider, useAuth } from "@/providers/auth-provider";
import { DatabaseProvider } from "@/providers/database-provider";
import { configureGoogleSignIn } from "@/lib/oauth";
import { ThemeProvider, useTheme } from "@/providers/theme-provider";
import { OfflineBanner } from "@/components/offline-banner";
import { HeaderCloseButton } from "@/components/navigation/header-close-button";
import { ToastProvider } from "@/components/toast";
import { isOpenedFromSearch } from "@/lib/note-from-search";
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
  const { semantic } = useTheme();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    const segmentArray = segments as string[];
    const inAuthGroup = segmentArray[0] === "(auth)";
    const isPublicAuthScreen = inAuthGroup && PUBLIC_AUTH_SCREENS.has(segmentArray[1]);

    // A recovery session is a real session, so this has to win over both the
    // approval gate and the signed-in redirect below — otherwise the reset
    // screen is unreachable and the user lands in the app with a password they
    // never chose. It does not depend on approval, so it need not wait for a check.
    if (isRecovering) {
      if (segmentArray[1] !== RESET_PASSWORD_SCREEN) {
        router.replace("/(auth)/reset-password");
      }
      return;
    }

    // An approval check in flight only holds routing. The screens stay mounted, so a manual
    // "Check approval status" keeps its result message and an open editor survives a re-check.
    // A signed-out user is never held: a check still in flight must not keep them in the app.
    if (isCheckingApproval && user) return;

    if (!user) {
      if (!isPublicAuthScreen) {
        // dismissTo pops back to a login screen already in the stack (e.g. under the
        // waiting screen) instead of pushing a second one, which would show a back button.
        // With no login in the stack it replaces the current screen.
        router.dismissTo("/(auth)/login");
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

  // Only the first auth read blanks the app. isLoading stays true through the launch-time
  // approval check, so nothing routes on a stale approval at start-up.
  if (isLoading) {
    return (
      <View
        style={[styles.loadingContainer, { backgroundColor: semantic.bg }]}
        testID="route-guard-loading"
      >
        <ActivityIndicator size="large" color={colors.primary[600]} />
      </View>
    );
  }

  return <>{children}</>;
}

// An iOS sheet's first screen has no back button. Search is a sheet, and a note
// opened from it is presented as another sheet over it, so both get a close
// button there. Android shows them as ordinary screens with a back arrow.
const sheetCloseButton = (testID: string) =>
  Platform.OS === "ios" ? () => <HeaderCloseButton testID={testID} /> : undefined;

function searchScreenOptions() {
  return {
    title: "Search",
    presentation: "modal" as const,
    headerLeft: sheetCloseButton("search-close"),
  };
}

function noteScreenOptions({ route }: { route: { params?: object } }) {
  return {
    title: "",
    headerBackTitle: "Notes",
    headerLeft: isOpenedFromSearch(route.params) ? sheetCloseButton("note-sheet-close") : undefined,
  };
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
          {/* The title is never shown as a header (headerShown: false), but iOS uses it as the
              back-button label on screens pushed from the tabs; without it that reads "(tabs)". */}
          <Stack.Screen name="(tabs)" options={{ headerShown: false, title: "Notebooks" }} />
          {/* Auth screens carry their own body headings, so a header title would repeat them.
              Login, reset and waiting have no header at all; sign-up and forgot-password keep an
              empty one for the back button. The titles stay: iOS uses them as the back label.
              Login replaces the app on sign-out, and "pop" makes that read as going back. */}
          <Stack.Screen
            name="(auth)/login"
            options={{ title: "Log In", headerShown: false, animationTypeForReplace: "pop" }}
          />
          <Stack.Screen name="(auth)/signup" options={{ title: "Sign Up", headerTitle: "" }} />
          <Stack.Screen
            name="(auth)/forgot-password"
            options={{ title: "Forgot Password", headerTitle: "" }}
          />
          <Stack.Screen
            name="(auth)/reset-password"
            options={{ title: "Reset Password", headerShown: false, gestureEnabled: false }}
          />
          <Stack.Screen
            name="(auth)/waiting-for-approval"
            options={{ title: "Awaiting Approval", headerShown: false, gestureEnabled: false }}
          />
          {/* The notebook screen titles itself with the notebook's name once it loads. */}
          <Stack.Screen name="notebooks/[id]" options={{ title: "" }} />
          {/* The editor's title field is the title, so the header shows only the back
              button. Its label stays "Notes" rather than the notebook's name. */}
          <Stack.Screen name="notes/[id]" options={noteScreenOptions} />
          <Stack.Screen name="search" options={searchScreenOptions} />
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
