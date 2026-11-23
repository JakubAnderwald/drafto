import { View, Text, StyleSheet } from "react-native";
import type { OfflineBannerVariant } from "@drafto/shared";

import { useAccessibilityAnnouncement } from "@/hooks/use-accessibility-announcement";
import { useOfflineBannerState } from "@/hooks/use-offline-banner-state";
import { colors, fontSizes, spacing } from "@/theme/tokens";

const MESSAGES: Record<OfflineBannerVariant, string> = {
  offline: "You are offline",
  reconnected: "Back online — syncing...",
};

/**
 * The offline / back-online strip across the top of the window.
 *
 * It is part of the layout, not an overlay: MainScreen mounts it above the
 * three panes, so while it shows it pushes them down instead of covering the
 * sidebar's top row, the note list's "New note" button and the editor's top
 * row (PrimeTestLab report 10668, M-03). It shows and hides without sliding,
 * since a slide would leave a gap or make the panes jump twice.
 *
 * VoiceOver (#872): on react-native-macos a <Text> is never an accessibility
 * element of its own and a plain View is skipped, so the strip itself is the
 * element, labelled with its message. Its role is "text" (AXStaticText), not
 * "alert": "alert" maps to no macOS role (AXUnknown) and announces nothing, so
 * the hook below asks VoiceOver to speak each new message instead.
 */
export function OfflineBanner() {
  const variant = useOfflineBannerState();
  const message = variant ? MESSAGES[variant] : null;
  useAccessibilityAnnouncement(message);
  if (!message) return null;

  return (
    <View
      testID="offline-banner"
      accessible
      accessibilityRole="text"
      accessibilityLabel={message}
      style={[styles.container, variant === "reconnected" ? styles.reconnected : styles.offline]}
    >
      <View style={styles.content}>
        <Text style={styles.text}>{message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: spacing.sm,
  },
  offline: {
    backgroundColor: colors.error,
  },
  reconnected: {
    backgroundColor: colors.success,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  text: {
    color: colors.white,
    fontSize: fontSizes.sm,
    fontWeight: "600",
  },
});
