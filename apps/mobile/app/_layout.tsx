import { useEffect } from "react";
import { ActivityIndicator, View, StyleSheet } from "react-native";
import { Stack, useSegments, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { AuthProvider, useAuth } from "@/providers/auth-provider";

function RouteGuard({ children }: { children: React.ReactNode }) {
  const { user, isApproved, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    const segmentArray = segments as string[];
    const inAuthGroup = segmentArray[0] === "(auth)";

    if (!user) {
      // Not authenticated -> go to login (unless already in auth group)
      if (!inAuthGroup) {
        router.replace("/(auth)/login");
      }
    } else if (!isApproved) {
      // Authenticated but not approved -> go to waiting screen
      if (segmentArray[1] !== "waiting-for-approval") {
        router.replace("/(auth)/waiting-for-approval");
      }
    } else {
      // Authenticated and approved -> go to main app
      if (inAuthGroup) {
        router.replace("/(tabs)");
      }
    }
  }, [user, isApproved, isLoading, segments, router]);

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#4f46e5" />
      </View>
    );
  }

  return <>{children}</>;
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <RouteGuard>
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="(auth)/login" options={{ title: "Log In" }} />
          <Stack.Screen name="(auth)/signup" options={{ title: "Sign Up" }} />
          <Stack.Screen
            name="(auth)/waiting-for-approval"
            options={{ title: "Awaiting Approval", headerBackVisible: false }}
          />
          <Stack.Screen name="notebooks/[id]" options={{ title: "Notes" }} />
          <Stack.Screen name="notes/[id]" options={{ title: "Editor" }} />
        </Stack>
      </RouteGuard>
      <StatusBar style="auto" />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
