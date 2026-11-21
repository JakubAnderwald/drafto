import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AccessibilityInfo,
  Animated,
  BackHandler,
  Modal,
  Platform,
  StyleSheet,
  View,
  type HostInstance,
} from "react-native";

export interface ModalOverlayProps {
  visible: boolean;
  /** Android hardware back, and iOS's Modal dismiss request. */
  onRequestClose: () => void;
  /**
   * Where TalkBack's focus goes when the overlay opens on Android, usually the
   * title. A Modal window took focus by itself; a view in the app's window
   * doesn't, so without it focus stays on the now-hidden element that opened it.
   */
  initialFocusRef?: RefObject<HostInstance | null>;
  testID?: string;
  children: ReactNode;
}

interface OverlayEntry {
  id: string;
  initialFocusRef?: RefObject<HostInstance | null>;
  testID?: string;
  children: ReactNode;
  onRequestClose: () => void;
}

interface ModalOverlayHostValue {
  show: (entry: OverlayEntry) => void;
  hide: (id: string) => void;
}

const ModalOverlayHostContext = createContext<ModalOverlayHostValue | null>(null);

const FADE_IN_MS = 150;

/**
 * Whether ModalOverlay draws in the activity window (Android) instead of an RN
 * `Modal`.
 *
 * On Android an RN `Modal` is a `Dialog` window of its own. React Native gives
 * that window the OS theme's navigation-bar appearance (`enableEdgeToEdge()`
 * reads the OS night mode) and copies only the status-bar flag from the
 * activity, so on 3-button navigation the bar's scrim follows the OS while the
 * dialog is open. Nothing in JS can reach that window. Drawn in the activity
 * window, the overlay keeps the bar SystemBars styles (ADR-0087, ADR-0092).
 */
export function drawsInActivityWindow(): boolean {
  return Platform.OS === "android";
}

/**
 * A full-screen modal layer. On iOS it is an RN `Modal`. On Android it renders
 * in the app's own window, through the ModalOverlayHost at the root of the app,
 * so it covers the header and the tab bar and keeps the in-app theme's system
 * bars. Use it instead of `Modal` for every dialog (ADR-0092).
 *
 * On Android it does what the `Modal` window did itself: hardware back calls
 * `onRequestClose`, touches don't reach the app behind it, TalkBack can't reach
 * the app behind it and moves to `initialFocusRef`, and it fades in. Nothing
 * renders while it's hidden. The content gets the contexts of the host's
 * position in the tree, not of the component that renders the ModalOverlay:
 * the app-wide providers, but not the navigator's (`useNavigation`, a screen's
 * own providers). Read those in the owner and pass values down.
 */
export function ModalOverlay({
  visible,
  onRequestClose,
  initialFocusRef,
  testID,
  children,
}: ModalOverlayProps) {
  if (!drawsInActivityWindow()) {
    return (
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={onRequestClose}
        testID={testID}
      >
        {children}
      </Modal>
    );
  }
  return (
    <InWindowOverlay
      visible={visible}
      onRequestClose={onRequestClose}
      initialFocusRef={initialFocusRef}
      testID={testID}
    >
      {children}
    </InWindowOverlay>
  );
}

function InWindowOverlay({
  visible,
  onRequestClose,
  initialFocusRef,
  testID,
  children,
}: ModalOverlayProps) {
  const host = useContext(ModalOverlayHostContext);
  if (!host) {
    throw new Error("ModalOverlay must be used within a ModalOverlayHost");
  }
  const id = useId();

  // Hands the latest content to the host on every render, so the overlay updates
  // with its owner's state. The host's context value is stable, so this doesn't
  // re-render the owner.
  useLayoutEffect(() => {
    if (visible) {
      host.show({ id, initialFocusRef, testID, children, onRequestClose });
    } else {
      host.hide(id);
    }
  });

  useLayoutEffect(() => () => host.hide(id), [host, id]);

  return null;
}

/**
 * Where ModalOverlay draws on Android: after the app, above everything in it.
 * Mount it once near the root, inside every app-wide provider (theme, auth,
 * toasts, database) and around the navigator, so overlay content reads the
 * same contexts on Android as in an iOS Modal. While an overlay is open the
 * app behind it is hidden from TalkBack.
 */
export function ModalOverlayHost({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<OverlayEntry[]>([]);

  const show = useCallback((entry: OverlayEntry) => {
    setEntries((current) => {
      const index = current.findIndex((e) => e.id === entry.id);
      if (index === -1) return [...current, entry];
      const next = current.slice();
      next[index] = entry;
      return next;
    });
  }, []);

  const hide = useCallback((id: string) => {
    setEntries((current) =>
      current.some((e) => e.id === id) ? current.filter((e) => e.id !== id) : current,
    );
  }, []);

  const value = useMemo(() => ({ show, hide }), [show, hide]);
  const open = entries.length > 0;

  return (
    <ModalOverlayHostContext.Provider value={value}>
      <View
        style={styles.app}
        // Kept as a real view: TalkBack hiding and the layer's z-order need it.
        collapsable={false}
        importantForAccessibility={open ? "no-hide-descendants" : "auto"}
        testID="modal-overlay-app"
      >
        {children}
      </View>
      {entries.map((entry, index) => (
        <OverlayLayer
          key={entry.id}
          entry={entry}
          // Only the top overlay takes back presses and stays reachable to TalkBack.
          isTop={index === entries.length - 1}
        />
      ))}
    </ModalOverlayHostContext.Provider>
  );
}

function OverlayLayer({ entry, isTop }: { entry: OverlayEntry; isTop: boolean }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const onRequestClose = useRef(entry.onRequestClose);
  onRequestClose.current = entry.onRequestClose;

  useEffect(() => {
    const animation = Animated.timing(opacity, {
      toValue: 1,
      duration: FADE_IN_MS,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  // Once it has faded in, move TalkBack's focus into the overlay, as a Modal
  // window's focus change did. A no-op when no screen reader is on.
  const initialFocusRef = entry.initialFocusRef;
  useEffect(() => {
    const timer = setTimeout(() => {
      const target = initialFocusRef?.current;
      if (target) AccessibilityInfo.sendAccessibilityEvent(target, "focus");
    }, FADE_IN_MS);
    return () => clearTimeout(timer);
  }, [initialFocusRef]);

  useEffect(() => {
    if (!isTop) return;
    // The Modal window took every back press while open; so does the top overlay.
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onRequestClose.current();
      return true;
    });
    return () => subscription.remove();
  }, [isTop]);

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.layer, { opacity }]}
      // The layer catches every touch, so nothing behind it can be pressed.
      onStartShouldSetResponder={() => true}
      importantForAccessibility={isTop ? "auto" : "no-hide-descendants"}
      testID={entry.testID}
    >
      {entry.children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  app: {
    flex: 1,
  },
  layer: {
    zIndex: 1000,
    elevation: 1000,
  },
});
