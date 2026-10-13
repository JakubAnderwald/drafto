import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

export interface KeyboardScrollViewProps {
  /** The outer view, which fills the screen; screens pass their top inset here. */
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  testID?: string;
  children: ReactNode;
}

/**
 * A full-screen scroll view that keeps the focused field clear of the keyboard.
 *
 * On iOS the ScrollView does it itself (`automaticallyAdjustKeyboardInsets`): it
 * insets its content and scrolls the focused field into view in one native
 * animation. A KeyboardAvoidingView re-lays the screen out through
 * LayoutAnimation instead, and the focused field's border and text then moved
 * out of step with the rest of the form for a moment.
 *
 * Android runs edge-to-edge, so the window doesn't shrink for the keyboard and a
 * KeyboardAvoidingView still has to make room.
 */
export function KeyboardScrollView({
  style,
  contentContainerStyle,
  testID,
  children,
}: KeyboardScrollViewProps) {
  const isIOS = Platform.OS === "ios";
  const scrollView = (
    <ScrollView
      contentContainerStyle={contentContainerStyle}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets={isIOS}
    >
      {children}
    </ScrollView>
  );

  if (isIOS) {
    return (
      <View style={[styles.fill, style]} testID={testID}>
        {scrollView}
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={[styles.fill, style]} testID={testID} behavior="height">
      {scrollView}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
