import { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Animated } from "react-native";

import { useNetworkStatus } from "@/hooks/use-network-status";
import { colors, fontSizes, spacing } from "@/theme/tokens";

export function OfflineBanner() {
  const { isConnected } = useNetworkStatus();
  const slideAnim = useRef(new Animated.Value(-40)).current;
  const wasOfflineRef = useRef(false);
  const [showReconnected, setShowReconnected] = useState(false);

  useEffect(() => {
    if (!isConnected) {
      wasOfflineRef.current = true;
      setShowReconnected(false);
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start();
    } else if (wasOfflineRef.current) {
      setShowReconnected(true);
      wasOfflineRef.current = false;
      const timer = setTimeout(() => {
        Animated.timing(slideAnim, {
          toValue: -40,
          duration: 300,
          useNativeDriver: true,
        }).start(() => {
          setShowReconnected(false);
        });
      }, 2000);
      return () => clearTimeout(timer);
    } else {
      slideAnim.setValue(-40);
    }
  }, [isConnected, slideAnim]);

  const isOffline = !isConnected;
  const isReconnected = showReconnected && isConnected;

  if (!isOffline && !isReconnected) return null;

  return (
    <Animated.View
      style={[
        styles.container,
        isReconnected ? styles.reconnected : styles.offline,
        { transform: [{ translateY: slideAnim }] },
      ]}
    >
      <View style={styles.content}>
        <Text style={styles.text}>
          {isReconnected ? "Back online — syncing..." : "You are offline"}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
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
