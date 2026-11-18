import { View, Text, StyleSheet, type LayoutChangeEvent } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { OfflineBannerVariant } from "@drafto/shared";
import { StatusBar } from "expo-status-bar";

import { colors, fontSizes, spacing } from "@/theme/tokens";

interface OfflineBannerProps {
  variant: OfflineBannerVariant;
  /**
   * The status-bar inset to pad by when the banner is the topmost thing on
   * screen (a screen without a header). 0, the default, below a header.
   */
  topInset?: number;
  onLayout?: (event: LayoutChangeEvent) => void;
}

/**
 * The offline / back-online strip. It is part of the layout, not an overlay:
 * whatever comes after it is pushed down, so it can never cover a header's
 * Back button or take its taps (PrimeTestLab report 10668, M-03).
 * OfflineScreenLayout decides where it goes.
 */
export function OfflineBanner({ variant, topInset = 0, onLayout }: OfflineBannerProps) {
  const reconnected = variant === "reconnected";

  return (
    <View
      testID="offline-banner"
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      onLayout={onLayout}
      style={[
        styles.container,
        reconnected ? styles.reconnected : styles.offline,
        { paddingTop: topInset + spacing.xs },
      ]}
    >
      {/* Under the status bar, white icons read on the red or green strip in either theme. */}
      {topInset > 0 ? <StatusBar style="light" /> : null}
      <View style={styles.content}>
        <Ionicons
          name={reconnected ? "wifi" : "cloud-offline-outline"}
          size={16}
          color={colors.white}
        />
        <Text style={styles.text}>
          {reconnected ? "Back online — syncing..." : "You are offline"}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingBottom: spacing.xs,
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
    fontSize: fontSizes.md,
    fontWeight: "600",
  },
});
