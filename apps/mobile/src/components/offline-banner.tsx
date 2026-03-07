import { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Animated } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useNetworkStatus } from "@/hooks/use-network-status";
import { colors, semantic } from "@/theme/tokens";

export function OfflineBanner() {
  const { isConnected } = useNetworkStatus();
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(-100)).current;
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
      // Keep visible briefly to show "Back online", then hide
      const timer = setTimeout(() => {
        Animated.timing(slideAnim, {
          toValue: -100,
          duration: 300,
          useNativeDriver: true,
        }).start(() => {
          setShowReconnected(false);
        });
      }, 2000);
      return () => clearTimeout(timer);
    } else {
      // Initially connected, hide
      slideAnim.setValue(-100);
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
        { paddingTop: insets.top + 4, transform: [{ translateY: slideAnim }] },
      ]}
    >
      <View style={styles.content}>
        <Ionicons
          name={isReconnected ? "wifi" : "cloud-offline-outline"}
          size={16}
          color={semantic.onPrimary}
        />
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
    paddingBottom: 6,
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
    gap: 6,
  },
  text: {
    color: semantic.onPrimary,
    fontSize: 13,
    fontWeight: "600",
  },
});
