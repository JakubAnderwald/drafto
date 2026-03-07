import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <>
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
      <StatusBar style="auto" />
    </>
  );
}
