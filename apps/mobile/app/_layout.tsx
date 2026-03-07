import { useEffect } from "react";
import { ActivityIndicator, View, StyleSheet } from "react-native";
import { Stack, useSegments, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { AuthProvider, useAuth } from "@/providers/auth-provider";
import { DatabaseProvider } from "@/providers/database-provider";
import { ThemeProvider, useTheme } from "@/providers/theme-provider";
import { OfflineBanner } from "@/components/offline-banner";
import { ToastProvider } from "@/components/toast";
import { colors } from "@/theme/tokens";

const PUBLIC_AUTH_SCREENS = new Set(["login", "signup"]);

function RouteGuard({ children }: { children: React.ReactNode }) {
  const { user, isApproved, isLoading, isCheckingApproval } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading || isCheckingApproval) return;

    const segmentArray = segments as string[];
    const inAuthGroup = segmentArray[0] === "(auth)";
    const isPublicAuthScreen = inAuthGroup && PUBLIC_AUTH_SCREENS.has(segmentArray[1]);

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
  }, [user, isApproved, isLoading, isCheckingApproval, segments, router]);

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
          <Stack.Screen
            name="(auth)/waiting-for-approval"
            options={{
              title: "Awaiting Approval",
              headerBackVisible: false,
            }}
          />
          <Stack.Screen name="notebooks/[id]" options={{ title: "Notes" }} />
          <Stack.Screen name="notes/[id]" options={{ title: "Editor" }} />
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
