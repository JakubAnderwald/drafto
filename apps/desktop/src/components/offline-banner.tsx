import { View, Text, StyleSheet } from "react-native";

import { useOfflineBannerState } from "@/hooks/use-offline-banner-state";
import { colors, fontSizes, spacing } from "@/theme/tokens";

/**
 * The offline / back-online strip across the top of the window.
 *
 * It is part of the layout, not an overlay: MainScreen mounts it above the
 * three panes, so while it shows it pushes them down instead of covering the
 * sidebar's top row, the note list's "New note" button and the editor's top
 * row (PrimeTestLab report 10668, M-03). It shows and hides without sliding,
 * since a slide would leave a gap or make the panes jump twice.
 */
export function OfflineBanner() {
  const variant = useOfflineBannerState();
  if (!variant) return null;

  const reconnected = variant === "reconnected";

  return (
    <View
      testID="offline-banner"
      accessibilityRole="alert"
      style={[styles.container, reconnected ? styles.reconnected : styles.offline]}
    >
      <View style={styles.content}>
        <Text style={styles.text}>
          {reconnected ? "Back online — syncing..." : "You are offline"}
        </Text>
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
