import { useMemo, type ComponentProps } from "react";
import { Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme } from "@/providers/theme-provider";
import { colors, radii, spacing } from "@/theme/tokens";

/** Diameter of the floating action button. */
export const FAB_SIZE = 56;
/** Gap between the FAB and the screen's right and bottom edges. */
export const FAB_MARGIN = spacing.xl;

const ICON_SIZE = 28;

export type FabIconName = ComponentProps<typeof Ionicons>["name"];

export interface FabProps {
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string;
  icon?: FabIconName;
  /**
   * Lift the button above the system's bottom inset: the Android navigation
   * bar or the iOS home indicator. Set it on screens with no bottom tab bar
   * (pushed stack screens, sheets). The app is edge-to-edge, so their content
   * runs under the system bar. Leave it off inside the tab navigator, whose
   * tab bar already takes that inset; setting it there floats the button a
   * nav-bar's height above the tab bar.
   */
  clearSystemBottomInset?: boolean;
}

/** Distance from the bottom of the screen to the bottom of the FAB. */
export function fabBottomOffset(
  systemBottomInset: number,
  clearSystemBottomInset: boolean,
): number {
  return FAB_MARGIN + (clearSystemBottomInset ? systemBottomInset : 0);
}

/**
 * Bottom padding for a list under a FAB, so its last row scrolls clear of the
 * button (and, with `clearSystemBottomInset`, of the system bar too). Pass the
 * same value the screen's `Fab` gets.
 */
export function useFabListPadding(clearSystemBottomInset: boolean): number {
  const { bottom } = useSafeAreaInsets();
  return fabBottomOffset(bottom, clearSystemBottomInset) + FAB_SIZE + FAB_MARGIN;
}

export function Fab({
  onPress,
  accessibilityLabel,
  testID,
  icon = "add",
  clearSystemBottomInset = false,
}: FabProps) {
  const { semantic } = useTheme();
  const { bottom } = useSafeAreaInsets();
  const offset = useMemo(
    () => ({ bottom: fabBottomOffset(bottom, clearSystemBottomInset) }),
    [bottom, clearSystemBottomInset],
  );

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
