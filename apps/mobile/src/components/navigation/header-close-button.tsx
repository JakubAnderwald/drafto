import { useRef } from "react";
import { Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { useTheme } from "@/providers/theme-provider";

const ICON_SIZE = 22;
/** Brings the tap target to Apple's 44 pt minimum around the 22 pt icon. */
const HIT_SLOP = (44 - ICON_SIZE) / 2;

/**
 * Closes the sheet it sits in. An iOS sheet's first screen has no back button,
 * so Search and a screen opened above it need this to be closable without a
 * swipe (see app/_layout.tsx).
 */
export function HeaderCloseButton({ testID }: { testID?: string }) {
  const router = useRouter();
  const { semantic } = useTheme();
  // A second tap before the sheet has gone would close the sheet beneath it too.
  const closing = useRef(false);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    // Opened straight from a link, the sheet can be the only screen; there is
    // nothing to go back to, so open the app's first screen instead.
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/");
    }
  };

  return (
    <Pressable
      testID={testID}
      accessibilityLabel="Close"
      accessibilityRole="button"
      hitSlop={HIT_SLOP}
      onPress={close}
    >
      <Ionicons name="close" size={ICON_SIZE} color={semantic.fg} />
    </Pressable>
  );
}
