import { Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { useTheme } from "@/providers/theme-provider";

/**
 * Closes the sheet it sits in. An iOS sheet's first screen has no back button,
 * so Search and a note opened from it need this to be closable without a swipe.
 */
export function HeaderCloseButton({ testID }: { testID?: string }) {
  const router = useRouter();
  const { semantic } = useTheme();

  return (
    <Pressable
      testID={testID}
      accessibilityLabel="Close"
      accessibilityRole="button"
      hitSlop={8}
      onPress={() => router.back()}
    >
      <Ionicons name="close" size={22} color={semantic.fg} />
    </Pressable>
  );
}
