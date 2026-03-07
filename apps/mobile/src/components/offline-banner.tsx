import { useEffect, useRef } from "react";
import { View, Text, StyleSheet, Animated } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { useNetworkStatus } from "@/hooks/use-network-status";

export function OfflineBanner() {
  const { isConnected } = useNetworkStatus();
  const slideAnim = useRef(new Animated.Value(-50)).current;
  const wasOfflineRef = useRef(false);
  const showReconnected = useRef(false);

  useEffect(() => {
    if (!isConnected) {
      wasOfflineRef.current = true;
      showReconnected.current = false;
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start();
    } else if (wasOfflineRef.current) {
      showReconnected.current = true;
      wasOfflineRef.current = false;
      // Keep visible briefly to show "Back online", then hide
      const timer = setTimeout(() => {
        Animated.timing(slideAnim, {
          toValue: -50,
          duration: 300,
          useNativeDriver: true,
        }).start(() => {
          showReconnected.current = false;
        });
      }, 2000);
      return () => clearTimeout(timer);
    } else {
      // Initially connected, hide
      slideAnim.setValue(-50);
    }
  }, [isConnected, slideAnim]);

  const isOffline = !isConnected;
  const isReconnected = showReconnected.current && isConnected;

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
        <Ionicons name={isReconnected ? "wifi" : "cloud-offline-outline"} size={16} color="#fff" />
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
    paddingTop: 4,
    paddingBottom: 6,
  },
  offline: {
    backgroundColor: "#ef4444",
  },
  reconnected: {
    backgroundColor: "#22c55e",
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  text: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },
});
