import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import type { ViewStyle } from "react-native";

import { useTheme } from "@/providers/theme-provider";

interface SkeletonProps {
  width?: number | `${number}%`;
  height?: number;
  borderRadius?: number;
  style?: ViewStyle;
}

export function Skeleton({ width = "100%", height = 16, borderRadius = 4, style }: SkeletonProps) {
  const opacity = useRef(new Animated.Value(0.3)).current;
  const { semantic } = useTheme();

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius,
          backgroundColor: semantic.bgMuted,
          opacity,
        },
        style,
      ]}
    />
  );
}

interface ListSkeletonProps {
  rows?: number;
  variant?: "notebook" | "note" | "trash";
}

export function ListSkeleton({ rows = 6, variant = "notebook" }: ListSkeletonProps) {
  const { semantic } = useTheme();

  return (
    <View style={{ flex: 1, backgroundColor: semantic.bgSubtle, paddingTop: 8 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <View
          key={i}
          style={[styles.row, { backgroundColor: semantic.bg, borderBottomColor: semantic.border }]}
        >
          <Skeleton width={20} height={20} borderRadius={4} style={styles.icon} />
          <View style={styles.content}>
            <Skeleton
              width={i % 3 === 0 ? "70%" : i % 3 === 1 ? "55%" : "85%"}
              height={16}
              borderRadius={4}
            />
            {(variant === "note" || variant === "trash") && (
              <Skeleton width="35%" height={12} borderRadius={4} style={styles.subtitle} />
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

export function EditorSkeleton() {
  const { semantic } = useTheme();

  return (
    <View style={{ flex: 1, backgroundColor: semantic.bgSubtle }}>
      <View
        style={[
          styles.titleBar,
          { backgroundColor: semantic.bg, borderBottomColor: semantic.border },
        ]}
      >
        <Skeleton width="50%" height={24} borderRadius={4} />
      </View>
      <View style={styles.editorBody}>
        <Skeleton width="90%" height={14} borderRadius={4} style={styles.line} />
        <Skeleton width="75%" height={14} borderRadius={4} style={styles.line} />
        <Skeleton width="95%" height={14} borderRadius={4} style={styles.line} />
        <Skeleton width="60%" height={14} borderRadius={4} style={styles.line} />
        <Skeleton width="85%" height={14} borderRadius={4} style={styles.line} />
        <Skeleton width="40%" height={14} borderRadius={4} style={styles.line} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  icon: {
    marginRight: 12,
  },
  content: {
    flex: 1,
  },
  subtitle: {
    marginTop: 6,
  },
  titleBar: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  editorBody: {
    padding: 16,
  },
  line: {
    marginBottom: 12,
  },
});
