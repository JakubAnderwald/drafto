import { createContext, useContext, useCallback, useState, useRef, useEffect } from "react";
import { View, Text, StyleSheet, Animated } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme } from "@/providers/theme-provider";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

type ToastType = "info" | "warning" | "success";

interface ToastMessage {
  id: number;
  text: string;
  type: ToastType;
}

interface ToastContextValue {
  showToast: (text: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const AUTO_DISMISS_MS = 4000;

const ICON_MAP: Record<ToastType, keyof typeof Ionicons.glyphMap> = {
  info: "information-circle-outline",
  warning: "alert-circle-outline",
  success: "checkmark-circle-outline",
};

const COLOR_MAP: Record<ToastType, string> = {
  info: colors.info,
  warning: colors.warning,
  success: colors.success,
};

function Toast({
  message,
  onDismiss,
  semantic,
}: {
  message: ToastMessage;
  onDismiss: () => void;
  semantic: SemanticColors;
}) {
  const slideAnim = useRef(new Animated.Value(100)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start();

    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: 100,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0,
          duration: 250,
          useNativeDriver: true,
        }),
      ]).start(() => onDismiss());
    }, AUTO_DISMISS_MS);

    return () => clearTimeout(timer);
  }, [slideAnim, opacityAnim, onDismiss]);

  const color = COLOR_MAP[message.type];

  return (
    <Animated.View
      style={[
        styles.toast,
        {
          backgroundColor: semantic.bg,
          borderLeftColor: color,
          transform: [{ translateY: slideAnim }],
          opacity: opacityAnim,
        },
      ]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Ionicons name={ICON_MAP[message.type]} size={20} color={color} />
      <Text style={[styles.toastText, { color: semantic.fg }]}>{message.text}</Text>
    </Animated.View>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { semantic } = useTheme();
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextId = useRef(0);
  const insets = useSafeAreaInsets();

  const showToast = useCallback((text: string, type: ToastType = "info") => {
    const HAPTIC_MAP: Record<ToastType, Haptics.NotificationFeedbackType> = {
      info: Haptics.NotificationFeedbackType.Success,
      warning: Haptics.NotificationFeedbackType.Warning,
      success: Haptics.NotificationFeedbackType.Success,
    };
    Haptics.notificationAsync(HAPTIC_MAP[type]);
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, text, type }]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <View style={[styles.container, { bottom: insets.bottom + 16 }]} pointerEvents="none">
        {toasts.map((t) => (
          <Toast key={t.id} message={t} semantic={semantic} onDismiss={() => dismissToast(t.id)} />
        ))}
      </View>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    gap: spacing.sm,
    zIndex: 200,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.lg,
    borderLeftWidth: 4,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 4,
  },
  toastText: {
    flex: 1,
    fontSize: fontSizes.base,
    fontWeight: "500",
  },
});
