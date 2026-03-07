import { useRef, useCallback } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import type { ComponentProps } from "react";

const ACTION_WIDTH = 72;
const SWIPE_THRESHOLD = 0.3;
const VELOCITY_THRESHOLD = 0.5;

type IconName = ComponentProps<typeof Ionicons>["name"];

export interface SwipeAction {
  icon: IconName;
  color: string;
  backgroundColor: string;
  onPress: () => void;
}

interface SwipeableRowProps {
  children: React.ReactNode;
  leftActions?: SwipeAction[];
  rightActions?: SwipeAction[];
  style?: ViewStyle;
}

export function SwipeableRow({
  children,
  leftActions = [],
  rightActions = [],
  style,
}: SwipeableRowProps) {
  const translateX = useRef(new Animated.Value(0)).current;
  const isOpen = useRef(false);
  const currentOffset = useRef(0);

  const leftWidth = leftActions.length * ACTION_WIDTH;
  const rightWidth = rightActions.length * ACTION_WIDTH;

  const snapOpen = useCallback(
    (toValue: number) => {
      isOpen.current = true;
      currentOffset.current = toValue;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      Animated.spring(translateX, {
        toValue,
        useNativeDriver: true,
        bounciness: 0,
        speed: 20,
      }).start();
    },
    [translateX],
  );

  const snapClosed = useCallback(() => {
    isOpen.current = false;
    currentOffset.current = 0;
    Animated.spring(translateX, {
      toValue: 0,
      useNativeDriver: true,
      bounciness: 0,
      speed: 20,
    }).start();
  }, [translateX]);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (
        _evt: GestureResponderEvent,
        gestureState: PanResponderGestureState,
      ) => {
        return (
          Math.abs(gestureState.dx) > 10 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy)
        );
      },
      onPanResponderMove: (_evt: GestureResponderEvent, gestureState: PanResponderGestureState) => {
        let newValue = currentOffset.current + gestureState.dx;
        // Clamp within bounds
        if (leftActions.length === 0) newValue = Math.min(newValue, 0);
        if (rightActions.length === 0) newValue = Math.max(newValue, 0);
        newValue = Math.max(newValue, -rightWidth - 20);
        newValue = Math.min(newValue, leftWidth + 20);
        translateX.setValue(newValue);
      },
      onPanResponderRelease: (
        _evt: GestureResponderEvent,
        gestureState: PanResponderGestureState,
      ) => {
        const currentValue = currentOffset.current + gestureState.dx;

        // Swipe left (reveal right actions)
        if (rightActions.length > 0 && currentValue < 0) {
          const shouldOpen =
            Math.abs(currentValue) > rightWidth * SWIPE_THRESHOLD ||
            gestureState.vx < -VELOCITY_THRESHOLD;
          if (shouldOpen && !isOpen.current) {
            snapOpen(-rightWidth);
          } else if (isOpen.current && gestureState.vx > VELOCITY_THRESHOLD) {
            snapClosed();
          } else if (shouldOpen) {
            snapOpen(-rightWidth);
          } else {
            snapClosed();
          }
          return;
        }

        // Swipe right (reveal left actions)
        if (leftActions.length > 0 && currentValue > 0) {
          const shouldOpen =
            currentValue > leftWidth * SWIPE_THRESHOLD || gestureState.vx > VELOCITY_THRESHOLD;
          if (shouldOpen && !isOpen.current) {
            snapOpen(leftWidth);
          } else if (isOpen.current && gestureState.vx < -VELOCITY_THRESHOLD) {
            snapClosed();
          } else if (shouldOpen) {
            snapOpen(leftWidth);
          } else {
            snapClosed();
          }
          return;
        }

        snapClosed();
      },
    }),
  ).current;

  const handleActionPress = useCallback(
    (action: SwipeAction) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      snapClosed();
      action.onPress();
    },
    [snapClosed],
  );

  return (
    <View style={[styles.container, style]}>
      {/* Left actions (revealed by swiping right) */}
      {leftActions.length > 0 && (
        <View style={[styles.actionsLeft, { width: leftWidth }]}>
          {leftActions.map((action, index) => (
            <Pressable
              key={index}
              style={[styles.actionButton, { backgroundColor: action.backgroundColor }]}
              onPress={() => handleActionPress(action)}
            >
              <Ionicons name={action.icon} size={22} color={action.color} />
            </Pressable>
          ))}
        </View>
      )}

      {/* Right actions (revealed by swiping left) */}
      {rightActions.length > 0 && (
        <View style={[styles.actionsRight, { width: rightWidth }]}>
          {rightActions.map((action, index) => (
            <Pressable
              key={index}
              style={[styles.actionButton, { backgroundColor: action.backgroundColor }]}
              onPress={() => handleActionPress(action)}
            >
              <Ionicons name={action.icon} size={22} color={action.color} />
            </Pressable>
          ))}
        </View>
      )}

      {/* Main content */}
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: "hidden",
  },
  actionsLeft: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    flexDirection: "row",
  },
  actionsRight: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: "row",
  },
  actionButton: {
    width: ACTION_WIDTH,
    justifyContent: "center",
    alignItems: "center",
  },
});
