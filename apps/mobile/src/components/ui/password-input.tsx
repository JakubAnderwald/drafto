import { forwardRef, useState } from "react";
import { Platform, Pressable, type TextInput } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { PASSWORD_VISIBILITY_LABELS } from "@drafto/shared";

import { Input, type InputProps } from "@/components/ui/input";
import { useTheme } from "@/providers/theme-provider";
import { spacing } from "@/theme/tokens";

export type PasswordInputProps = Omit<InputProps, "secureTextEntry" | "rightIcon">;

const TOGGLE_ICON_SIZE = 20;

/**
 * A password field with a show/hide toggle in the Input's right slot. Hidden by default; the
 * caller's `autoComplete` / `textContentType` stay on the same TextInput in both states, so
 * iOS Keychain and Google Password Manager keep matching it. The toggle's testID is
 * `${testID}-toggle`.
 */
export const PasswordInput = forwardRef<TextInput, PasswordInputProps>(function PasswordInput(
  { testID, editable, keyboardType, ...props },
  ref,
) {
  const { semantic } = useTheme();
  const [visible, setVisible] = useState(false);
  const label = visible ? PASSWORD_VISIBILITY_LABELS.hide : PASSWORD_VISIBILITY_LABELS.show;

  return (
    <Input
      {...props}
      ref={ref}
      testID={testID}
      editable={editable}
      secureTextEntry={!visible}
      // While revealed, Android keyboards (Gboard, MIUI…) still treat the field as a password:
      // no suggestions, no learning what was typed.
      keyboardType={visible && Platform.OS === "android" ? "visible-password" : keyboardType}
      rightIcon={
        <Pressable
          onPress={() => setVisible((v) => !v)}
          disabled={editable === false}
          accessibilityRole="button"
          accessibilityLabel={label}
          hitSlop={spacing.md}
          testID={testID ? `${testID}-toggle` : undefined}
        >
          <Ionicons
            name={visible ? "eye-off-outline" : "eye-outline"}
            size={TOGGLE_ICON_SIZE}
            color={semantic.fgMuted}
          />
        </Pressable>
      }
    />
  );
});
