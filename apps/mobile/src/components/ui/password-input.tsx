import { forwardRef, useImperativeHandle, useRef, useState } from "react";
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
 *
 * Only `secureTextEntry` changes. The keyboard type is the caller's in both states: swapping in
 * Android's `visible-password` alongside `secureTextEntry` can leave the EditText with no input
 * type at all, depending on the order React Native applies the two props.
 *
 * iOS: when a focused UITextField becomes secure again, UIKit clears the whole field on the next
 * keystroke (the same thing it does when a secure field with text starts a new edit). Hiding the
 * value while the field is focused therefore also ends the edit (`blur()`), so the keyboard goes
 * away and the next tap starts a fresh edit, as it does in any iOS secure field, rather than
 * the user's next character silently replacing the password.
 */
export const PasswordInput = forwardRef<TextInput, PasswordInputProps>(function PasswordInput(
  { testID, editable, onFocus, onBlur, ...props },
  ref,
) {
  const { semantic } = useTheme();
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<TextInput | null>(null);
  const focused = useRef(false);
  const label = visible ? PASSWORD_VISIBILITY_LABELS.hide : PASSWORD_VISIBILITY_LABELS.show;

  useImperativeHandle<TextInput | null, TextInput | null>(ref, () => inputRef.current, []);

  const toggle = () => {
    if (visible && focused.current && Platform.OS === "ios") inputRef.current?.blur();
    setVisible((v) => !v);
  };

  return (
    <Input
      {...props}
      ref={inputRef}
      testID={testID}
      editable={editable}
      secureTextEntry={!visible}
      onFocus={(e) => {
        focused.current = true;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        focused.current = false;
        onBlur?.(e);
      }}
      rightIcon={
        <Pressable
          onPress={toggle}
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
