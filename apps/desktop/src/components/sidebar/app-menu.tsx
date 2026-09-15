import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";

import { DELETE_ACCOUNT_OFFLINE_NOTE } from "@/components/sidebar/delete-account-panel";
import { IconButton } from "@/components/ui/icon-button";
import { EllipsisIcon } from "@/components/ui/icons/ellipsis-icon";
import { useTheme } from "@/providers/theme-provider";
import { fontFamily, fontSizes, radii, spacing, type SemanticColors } from "@/theme/tokens";

const FOCUS_DELAY_MS = 50;
/** Marks Escape as handled so AppKit does not also beep for it. */
const ESCAPE_KEY_EVENTS = [{ key: "Escape" }];

export interface AppMenuSlots {
  /** The ⋯ button that toggles the menu. Render it where the menu belongs (the user row). */
  trigger: ReactElement;
  /**
   * `onLayout` for the section the menu opens above. The section must sit flush with the bottom
   * of the AppMenu host: the menu is positioned from the host's bottom edge by its height.
   */
  onAnchorLayout: (event: LayoutChangeEvent) => void;
}

interface AppMenuProps {
  onSignOut: () => void;
  /** Called when "Delete account…" is chosen. Never called while offline. */
  onDeleteAccount: () => void;
  /** Deleting an account needs the server, so its item is disabled while offline. */
  isOffline: boolean;
  /** The content the menu floats over. Place `trigger` and `onAnchorLayout` inside it. */
  children: (slots: AppMenuSlots) => ReactNode;
}

/**
 * The sidebar's ⋯ app menu. It mirrors the web `AppMenu` but lists only what macOS has:
 * Sign out and Delete account.
 *
 * AppMenu hosts the content it floats over instead of rendering the menu beside its trigger.
 * On react-native-macos a view laid out outside its parent's bounds is not reliably
 * hit-testable, so the click-outside backdrop and the menu render as the last children of a
 * host that spans the whole sidebar, and every clickable pixel stays inside its parent.
 * `Modal` is avoided because it is unproven on the fossil build.
 *
 * The menu closes on the trigger, on choosing an item, on Escape, or on a click anywhere else in
 * the sidebar. Clicks in the note list or editor do not reach the backdrop, so they leave it open.
 */
export function AppMenu({ onSignOut, onDeleteAccount, isOffline, children }: AppMenuProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const [isOpen, setIsOpen] = useState(false);
  const [anchorHeight, setAnchorHeight] = useState(0);
  const menuRef = useRef<View>(null);

  const close = useCallback(() => setIsOpen(false), []);
  const onAnchorLayout = useCallback((event: LayoutChangeEvent) => {
    setAnchorHeight(event.nativeEvent.layout.height);
  }, []);
  const onMenuKeyDown = useCallback(
    (event: { nativeEvent: { key: string } }) => {
      if (event.nativeEvent.key === "Escape") close();
    },
    [close],
  );

  // Give the open menu keyboard focus, as a native menu has, so Escape reaches its onKeyDown.
  // Deferred like the app's other focus calls: a focus command sent before the native view is
  // mounted is dropped.
  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(() => menuRef.current?.focus(), FOCUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const trigger = (
    <IconButton
      onPress={() => setIsOpen((open) => !open)}
      accessibilityLabel="App menu"
      accessibilityState={{ expanded: isOpen }}
      testID="app-menu-trigger"
    >
      <EllipsisIcon size={16} color={semantic.fgMuted} />
    </IconButton>
  );

  return (
    <View style={styles.host}>
      {children({ trigger, onAnchorLayout })}
      {isOpen ? (
        <>
          <Pressable testID="app-menu-backdrop" style={StyleSheet.absoluteFill} onPress={close} />
          <View
            ref={menuRef}
            testID="app-menu"
            accessibilityRole="menu"
            style={[styles.menu, { bottom: anchorHeight + spacing.xs }]}
            focusable
            // @ts-expect-error -- RN macOS supports onKeyDown, keyDownEvents and enableFocusRing but types are incomplete
            onKeyDown={onMenuKeyDown}
            keyDownEvents={ESCAPE_KEY_EVENTS}
            enableFocusRing={false}
          >
            <AppMenuItem
              label="Sign out"
              testID="logout-button"
              onPress={() => {
                close();
                onSignOut();
              }}
              styles={styles}
            />
            <View style={styles.separator} />
            <AppMenuItem
              label="Delete account…"
              accessibilityLabel="Delete account"
              testID="delete-account-menu-item"
              variant="danger"
              disabled={isOffline}
              onPress={() => {
                if (isOffline) return;
                close();
                onDeleteAccount();
              }}
              styles={styles}
            />
            {isOffline ? (
              <Text style={styles.offlineNote}>{DELETE_ACCOUNT_OFFLINE_NOTE}</Text>
            ) : null}
          </View>
        </>
      ) : null}
    </View>
  );
}

interface AppMenuItemProps {
  label: string;
  testID: string;
  onPress: () => void;
  accessibilityLabel?: string;
  variant?: "default" | "danger";
  disabled?: boolean;
  styles: ReturnType<typeof createStyles>;
}

function AppMenuItem({
  label,
  testID,
  onPress,
  accessibilityLabel = label,
  variant = "default",
  disabled = false,
  styles,
}: AppMenuItemProps) {
  const [hovered, setHovered] = useState(false);
  const isDanger = variant === "danger";
  const highlighted = hovered && !disabled;

  return (
    <Pressable
      testID={testID}
      style={[styles.item, highlighted && (isDanger ? styles.itemHoverDanger : styles.itemHover)]}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      disabled={disabled}
      accessibilityRole="menuitem"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
    >
      <Text
        style={[styles.itemText, isDanger && styles.itemTextDanger, disabled && styles.disabled]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    host: {
      flex: 1,
    },
    menu: {
      position: "absolute",
      left: spacing.sm,
      right: spacing.sm,
      paddingVertical: spacing.xs,
      backgroundColor: semantic.bg,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: semantic.borderStrong,
      // shadowColor hex is allowed by the design-system lint (color/bg/border only).
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 12,
    },
    item: {
      paddingVertical: 6,
      paddingHorizontal: spacing.sm,
      marginHorizontal: spacing.xs,
      borderRadius: radii.sm,
    },
    itemHover: {
      backgroundColor: semantic.bgMuted,
    },
    itemHoverDanger: {
      backgroundColor: semantic.errorBg,
    },
    itemText: {
      fontSize: fontSizes.base,
      color: semantic.fg,
      fontFamily: fontFamily.sans,
    },
    itemTextDanger: {
      color: semantic.errorText,
    },
    disabled: {
      opacity: 0.5,
    },
    separator: {
      height: 1,
      marginVertical: spacing.xs,
      // Matches the web menu's `border-outline-variant` separator.
      backgroundColor: semantic.outlineVariant,
    },
    offlineNote: {
      fontSize: fontSizes.xs,
      color: semantic.fgMuted,
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.xs,
      fontFamily: fontFamily.sans,
    },
  });
