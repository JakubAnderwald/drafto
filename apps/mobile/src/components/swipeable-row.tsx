import {
  useRef,
  useCallback,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type GestureResponderEvent,
  type PanResponderGestureState,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

export const ACTION_WIDTH = 72;
const SWIPE_THRESHOLD = 0.3;
const VELOCITY_THRESHOLD = 0.5;

/** How far the one-time peek slides a row: enough to show the action's colour. */
export const PEEK_DISTANCE = 48;
/** Lets the list settle (and a test driver's first tap land) before the peek starts. */
export const PEEK_DELAY_MS = 400;
const PEEK_SLIDE_MS = 220;
const PEEK_HOLD_MS = 700;

type IconName = ComponentProps<typeof Ionicons>["name"];

export interface SwipeAction {
  icon: IconName;
  /** What the action does, read by screen readers: "Move note to Trash", not the icon's name. */
  label: string;
  color: string;
  backgroundColor: string;
  onPress: () => void;
}

/**
 * Spread these on the row's own pressable: a screen reader then offers every
 * swipe action in its actions menu (TalkBack) or rotor (VoiceOver), so none of
 * them needs the gesture.
 */
export interface SwipeRowAccessibilityProps {
  accessibilityActions: AccessibilityActionInfo[];
  onAccessibilityAction: (event: AccessibilityActionEvent) => void;
}

interface SwipeableRowProps {
  /** The row. A function receives the accessibility props to spread on its pressable. */
  children: ReactNode | ((accessibility: SwipeRowAccessibilityProps) => ReactNode);
  leftActions?: SwipeAction[];
  rightActions?: SwipeAction[];
  style?: ViewStyle;
  /** Slide the row once to show the actions under it. Skipped when Reduce Motion is on. */
  peek?: boolean;
  /** The peek has played, or was skipped. */
  onPeekEnd?: () => void;
  /** The user swiped the row open. */
  onOpen?: () => void;
}

interface ReleaseState {
  /** Where the row sat when the gesture began. */
  offset: number;
  dx: number;
  vx: number;
  isOpen: boolean;
  leftWidth: number;
  rightWidth: number;
}

/** Where a row settles when the finger lifts: open on either side (± action width) or closed (0). */
export function resolveRelease({
  offset,
  dx,
  vx,
  isOpen,
  leftWidth,
  rightWidth,
}: ReleaseState): number {
  const position = offset + dx;

  // Swipe left (reveal right actions). An open row flicked back the other way closes.
  if (rightWidth > 0 && position < 0) {
    const shouldOpen =
      Math.abs(position) > rightWidth * SWIPE_THRESHOLD || vx < -VELOCITY_THRESHOLD;
    const flickedClosed = isOpen && vx > VELOCITY_THRESHOLD;
    return shouldOpen && !flickedClosed ? -rightWidth : 0;
  }

  // Swipe right (reveal left actions)
  if (leftWidth > 0 && position > 0) {
    const shouldOpen = position > leftWidth * SWIPE_THRESHOLD || vx > VELOCITY_THRESHOLD;
    const flickedClosed = isOpen && vx < -VELOCITY_THRESHOLD;
    return shouldOpen && !flickedClosed ? leftWidth : 0;
  }

  return 0;
}

/** The offsets the peek visits in turn: the right-hand actions first, then the left. */
export function peekOffsets(leftWidth: number, rightWidth: number): number[] {
  const offsets: number[] = [];
  if (rightWidth > 0) offsets.push(-Math.min(rightWidth, PEEK_DISTANCE));
  if (leftWidth > 0) offsets.push(Math.min(leftWidth, PEEK_DISTANCE));
  return offsets;
}

const actionName = (index: number) => `swipe-action-${index}`;

export function SwipeableRow({
  children,
  leftActions = [],
  rightActions = [],
  style,
  peek = false,
  onPeekEnd,
  onOpen,
}: SwipeableRowProps) {
  const translateX = useRef(new Animated.Value(0)).current;
  const isOpen = useRef(false);
  const dragging = useRef(false);
  const currentOffset = useRef(0);
  const mounted = useRef(true);
  const peeked = useRef(false);
  const peekAnimation = useRef<Animated.CompositeAnimation | null>(null);
  // The action buttons exist only while they can be seen (dragging, open, or
  // peeking): a closed row keeps no hidden buttons in the accessibility tree,
  // and a test driver finds exactly one "action-trash", the open row's.
  const [revealed, setRevealed] = useState(false);

  const leftWidth = leftActions.length * ACTION_WIDTH;
  const rightWidth = rightActions.length * ACTION_WIDTH;

  // The pan responder is built once, so it reads the latest props from here.
  const latest = useRef({ leftWidth, rightWidth, onOpen, onPeekEnd });
  useEffect(() => {
    latest.current = { leftWidth, rightWidth, onOpen, onPeekEnd };
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      peekAnimation.current?.stop();
    };
  }, []);

  const hideActionsIfClosed = useCallback(() => {
    if (mounted.current && !isOpen.current && !dragging.current) setRevealed(false);
  }, []);

  /**
   * Springs the row open at `toValue`. `byUser` is a release that opened it:
   * only that buzzes and reports the open, not a re-settle after the list took
   * the gesture.
   */
  const snapOpen = useCallback(
    (toValue: number, byUser: boolean) => {
      const wasOpen = isOpen.current;
      isOpen.current = true;
      currentOffset.current = toValue;
      if (byUser) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      Animated.spring(translateX, {
        toValue,
        useNativeDriver: true,
        bounciness: 0,
        speed: 20,
      }).start();
      if (byUser && !wasOpen) latest.current.onOpen?.();
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
    }).start(({ finished }) => {
      if (finished) hideActionsIfClosed();
    });
  }, [translateX, hideActionsIfClosed]);

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
      onPanResponderGrant: () => {
        dragging.current = true;
        setRevealed(true);
        const peeking = peekAnimation.current;
        if (peeking) {
          // The finger takes over a peek mid-slide: carry on from where the
          // row is, not from rest, so it doesn't jump. The native driver
          // reports that position asynchronously; moves before then use 0.
          peekAnimation.current = null;
          peeking.stop();
          translateX.stopAnimation((value) => {
            if (dragging.current && !isOpen.current) currentOffset.current = value;
          });
          latest.current.onPeekEnd?.();
        }
      },
      onPanResponderMove: (_evt: GestureResponderEvent, gestureState: PanResponderGestureState) => {
        const { leftWidth: left, rightWidth: right } = latest.current;
        let newValue = currentOffset.current + gestureState.dx;
        // Clamp within bounds
        if (left === 0) newValue = Math.min(newValue, 0);
        if (right === 0) newValue = Math.max(newValue, 0);
        newValue = Math.max(newValue, -right - 20);
        newValue = Math.min(newValue, left + 20);
        translateX.setValue(newValue);
      },
      onPanResponderRelease: (
        _evt: GestureResponderEvent,
        gestureState: PanResponderGestureState,
      ) => {
        dragging.current = false;
        const target = resolveRelease({
          offset: currentOffset.current,
          dx: gestureState.dx,
          vx: gestureState.vx,
          isOpen: isOpen.current,
          leftWidth: latest.current.leftWidth,
          rightWidth: latest.current.rightWidth,
        });
        if (target === 0) snapClosed();
        else snapOpen(target, true);
      },
      onPanResponderTerminate: () => {
        // Another responder (the list's scroll) took the gesture: settle where the row was.
        dragging.current = false;
        if (isOpen.current) snapOpen(currentOffset.current, false);
        else snapClosed();
      },
    }),
  ).current;

  useEffect(() => {
    if (!peek || peeked.current) return;
    const offsets = peekOffsets(leftWidth, rightWidth);
    if (offsets.length === 0) return;

    // Set by the cleanup: `peek` turned false, the row unmounted, or its
    // actions changed. Checked after the Reduce Motion lookup, which is async.
    let cancelled = false;

    AccessibilityInfo.isReduceMotionEnabled().then(
      (reduceMotion) => {
        if (cancelled || !mounted.current || peeked.current) return;
        peeked.current = true;
        if (reduceMotion || isOpen.current || dragging.current) {
          latest.current.onPeekEnd?.();
          return;
        }
        setRevealed(true);
        const slide = (toValue: number) =>
          Animated.timing(translateX, { toValue, duration: PEEK_SLIDE_MS, useNativeDriver: true });
        const run = Animated.sequence([
          Animated.delay(PEEK_DELAY_MS),
          ...offsets.flatMap((offset) => [slide(offset), Animated.delay(PEEK_HOLD_MS), slide(0)]),
        ]);
        peekAnimation.current = run;
        run.start(({ finished }) => {
          // A stopped peek is settled by whoever stopped it: a drag, the
          // called-off effect below, or the unmount.
          if (!finished) return;
          if (peekAnimation.current === run) peekAnimation.current = null;
          hideActionsIfClosed();
          latest.current.onPeekEnd?.();
        });
      },
      (error: unknown) => {
        if (cancelled || !mounted.current || peeked.current) return;
        peeked.current = true;
        console.warn("Could not read the Reduce Motion setting; skipping the row peek:", error);
        latest.current.onPeekEnd?.();
      },
    );

    return () => {
      cancelled = true;
    };
  }, [peek, leftWidth, rightWidth, translateX, hideActionsIfClosed]);

  // The peek was called off mid-slide (the hint was dismissed): stop it and
  // settle the row, unless a finger has it.
  useEffect(() => {
    if (peek) return;
    const running = peekAnimation.current;
    if (!running) return;
    peekAnimation.current = null;
    running.stop();
    if (!dragging.current) snapClosed();
  }, [peek, snapClosed]);

  const handleActionPress = useCallback(
    (action: SwipeAction) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      snapClosed();
      action.onPress();
    },
    [snapClosed],
  );

  const allActions = [...leftActions, ...rightActions];
  const accessibility: SwipeRowAccessibilityProps = {
    accessibilityActions: allActions.map((action, index) => ({
      name: actionName(index),
      label: action.label,
    })),
    onAccessibilityAction: (event) => {
      const action = allActions.find(
        (_, index) => actionName(index) === event.nativeEvent.actionName,
      );
      if (action) handleActionPress(action);
    },
  };

  const renderActionButton = (action: SwipeAction, index: number) => (
    <Pressable
      key={index}
      testID={`action-${action.icon.replace("-outline", "")}`}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      style={[styles.actionButton, { backgroundColor: action.backgroundColor }]}
      onPress={() => handleActionPress(action)}
    >
      <Ionicons name={action.icon} size={22} color={action.color} />
    </Pressable>
  );

  return (
    <View style={[styles.container, style]}>
      {/* Left actions (revealed by swiping right) */}
      {revealed && leftActions.length > 0 && (
        <View style={[styles.actionsLeft, { width: leftWidth }]}>
          {leftActions.map(renderActionButton)}
        </View>
      )}

      {/* Right actions (revealed by swiping left) */}
      {revealed && rightActions.length > 0 && (
        <View style={[styles.actionsRight, { width: rightWidth }]}>
          {rightActions.map(renderActionButton)}
        </View>
      )}

      {/* Main content */}
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        {typeof children === "function" ? children(accessibility) : children}
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
