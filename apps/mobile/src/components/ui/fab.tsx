import { useContext, useMemo, type ComponentProps } from "react";
import { Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { BottomTabBarHeightContext } from "@react-navigation/bottom-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme } from "@/providers/theme-provider";
import { colors, radii, spacing } from "@/theme/tokens";

/** Diameter of the floating action button. */
export const FAB_SIZE = 56;
/** Gap between the FAB and the screen's right and bottom edges. */
export const FAB_MARGIN = spacing.xl;
/**
 * Bottom padding of a list with no FAB over it: the `paddingVertical` the
 * notebook and note lists use at rest.
 */
export const LIST_RESTING_PADDING = spacing.sm;

const ICON_SIZE = 28;

export type FabIconName = ComponentProps<typeof Ionicons>["name"];

export interface FabProps {
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string;
  icon?: FabIconName;
}

export interface FabLayout {
  /** Distance from the bottom of the screen to the bottom of the FAB. */
  fabBottom: number;
  /** Bottom padding that keeps a list's last row clear of the FAB and system bar. */
  listPaddingBottom: number;
}

/**
 * Where the FAB sits and how far a list under it must pad its bottom.
 *
 * The app is edge-to-edge, so a screen with no bottom tab bar (a pushed stack
 * screen, a sheet) runs under the Android navigation bar or the iOS home
 * indicator and must clear `systemBottomInset` itself. Inside the tab
 * navigator the tab bar already takes that inset; adding it again would float
 * the button a nav-bar's height above the tab bar.
 *
 * With `fabVisible` false (the FAB is unmounted, e.g. while a create bar is
 * open) the list keeps its resting padding plus that system-bar clearance.
 */
export function computeFabLayout(
  systemBottomInset: number,
  insideBottomTabs: boolean,
  fabVisible = true,
): FabLayout {
  const systemClearance = insideBottomTabs ? 0 : systemBottomInset;
  const fabBottom = FAB_MARGIN + systemClearance;
  return {
    fabBottom,
    listPaddingBottom: fabVisible
      ? fabBottom + FAB_SIZE + FAB_MARGIN
      : LIST_RESTING_PADDING + systemClearance,
  };
}

/**
 * The FAB layout for the current screen. It tells a tab screen from a stack
 * screen by `BottomTabBarHeightContext`, which only the bottom tab navigator
 * provides, so `Fab` and the screen's list read the same answer and can't
 * disagree. Pass `fabVisible` false while the screen hides its FAB.
 */
export function useFabLayout(fabVisible = true): FabLayout {
  const insideBottomTabs = useContext(BottomTabBarHeightContext) !== undefined;
  const { bottom } = useSafeAreaInsets();
  return useMemo(
    () => computeFabLayout(bottom, insideBottomTabs, fabVisible),
    [bottom, insideBottomTabs, fabVisible],
  );
}

export function Fab({ onPress, accessibilityLabel, testID, icon = "add" }: FabProps) {
  const { semantic } = useTheme();
  const { fabBottom } = useFabLayout();
  const offset = useMemo(() => ({ bottom: fabBottom }), [fabBottom]);

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.fab, offset, pressed && styles.fabPressed]}
    >
      <Ionicons name={icon} size={ICON_SIZE} color={semantic.onPrimary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    right: FAB_MARGIN,
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: radii.full,
    backgroundColor: colors.primary[600],
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  fabPressed: {
    backgroundColor: colors.primary[700],
  },
});
