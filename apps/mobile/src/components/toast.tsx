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

export const AUTO_DISMISS_MS = 4000;
const ANIMATION_MS = 250;
/**
 * Toasts drop into place from this far above it while fading in. It is no more
 * than the container's `spacing.sm` gap below the safe area, so the animation
 * never rises into the status bar.
 */
export const SLIDE_DISTANCE = -spacing.sm;
/** Older toasts are dropped beyond this many, so a burst can't fill the screen. */
export const MAX_VISIBLE_TOASTS = 2;

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

const HAPTIC_MAP: Record<ToastType, Haptics.NotificationFeedbackType> = {
  info: Haptics.NotificationFeedbackType.Success,
  warning: Haptics.NotificationFeedbackType.Warning,
  success: Haptics.NotificationFeedbackType.Success,
};

function Toast({
  message,
  onDismiss,
  semantic,
}: {
  message: ToastMessage;
  onDismiss: (id: number) => void;
  semantic: SemanticColors;
}) {
  const slideAnim = useRef(new Animated.Value(SLIDE_DISTANCE)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  // The dismiss timer must start once per toast. Holding the callback in a ref
  // keeps it out of the effect's dependencies; with it as a dependency, every
  // provider re-render (each new toast) restarted every visible toast's timer,
  // so a burst of toasts stayed on screen for many times AUTO_DISMISS_MS.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  const messageId = message.id;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: ANIMATION_MS,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: ANIMATION_MS,
        useNativeDriver: true,
      }),
    ]).start();

    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: SLIDE_DISTANCE,
          duration: ANIMATION_MS,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0,
          duration: ANIMATION_MS,
          useNativeDriver: true,
        }),
      ]).start(() => onDismissRef.current(messageId));
    }, AUTO_DISMISS_MS);

    return () => clearTimeout(timer);
  }, [slideAnim, opacityAnim, messageId]);

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
  // Mirrors `toasts` so showToast can dedupe synchronously (and skip the
  // haptic for a duplicate) without a side effect inside a state updater.
  const toastsRef = useRef<ToastMessage[]>([]);
  const nextId = useRef(0);
  const insets = useSafeAreaInsets();

  const commit = useCallback((next: ToastMessage[]) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const showToast = useCallback(
    (text: string, type: ToastType = "info") => {
      // A message already on screen is not shown a second time (e.g. two syncs
      // reporting the same thing); it can show again once that toast has gone.
      if (toastsRef.current.some((t) => t.text === text)) return;
      Haptics.notificationAsync(HAPTIC_MAP[type]);
      const id = nextId.current++;
      commit([...toastsRef.current, { id, text, type }].slice(-MAX_VISIBLE_TOASTS));
    },
    [commit],
  );

  const dismissToast = useCallback(
    (id: number) => {
      commit(toastsRef.current.filter((t) => t.id !== id));
    },
    [commit],
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Top of the screen: at the bottom they covered the add button and the
          editor's attachment row. */}
      <View
        testID="toast-container"
        style={[styles.container, { top: insets.top + spacing.sm }]}
        pointerEvents="none"
      >
        {toasts.map((t) => (
          <Toast key={t.id} message={t} semantic={semantic} onDismiss={dismissToast} />
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
