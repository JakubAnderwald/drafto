import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { TextInput } from "react-native";
import { PASSWORD_VISIBILITY_LABELS } from "@drafto/shared";

import { IconButton } from "@/components/ui/icon-button";
import { EyeIcon } from "@/components/ui/icons/eye-icon";
import { Input, type InputProps } from "@/components/ui/input";
import { useTheme } from "@/providers/theme-provider";

export type PasswordInputProps = Omit<InputProps, "secureTextEntry" | "rightIcon">;

/**
 * A password field with a show/hide toggle in the Input's right slot. Hidden by default; the
 * caller's `autoComplete` / `textContentType` stay on the same field in both states. The
 * toggle's testID is `${testID}-toggle`.
 *
 * react-native-macos swaps the native view (secure ↔ plain text field) when `secureTextEntry`
 * changes, which drops keyboard focus. So when the field had focus at the moment of the toggle
 * (the user was typing and clicked the eye), it is focused again afterwards, with the caret put
 * at the end: AppKit selects the whole text of a field that becomes first responder, and the
 * next keystroke would replace the password. When the field did not have focus (keyboard or
 * VoiceOver users on the toggle itself), focus stays where it is.
 */
export const PasswordInput = forwardRef<TextInput, PasswordInputProps>(function PasswordInput(
  { testID, editable, value, onFocus, onBlur, ...props },
  ref,
) {
  const { semantic } = useTheme();
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<TextInput | null>(null);
  const focused = useRef(false);
  const refocusAfterToggle = useRef(false);

  useImperativeHandle<TextInput | null, TextInput | null>(ref, () => inputRef.current, []);

  useEffect(() => {
    if (!refocusAfterToggle.current) return;
    refocusAfterToggle.current = false;
    const field = inputRef.current;
    if (!field) return;
    field.focus();
    field.setSelection(value.length, value.length);
  }, [visible, value]);

  const toggle = () => {
    refocusAfterToggle.current = focused.current;
    setVisible((v) => !v);
  };

  return (
    <Input
      {...props}
      ref={inputRef}
      testID={testID}
      editable={editable}
      value={value}
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
        <IconButton
          onPress={toggle}
          disabled={editable === false}
          accessibilityLabel={
            visible ? PASSWORD_VISIBILITY_LABELS.hide : PASSWORD_VISIBILITY_LABELS.show
          }
          testID={testID ? `${testID}-toggle` : undefined}
          size={24}
        >
          <EyeIcon size={16} color={semantic.fgMuted} slashed={visible} />
        </IconButton>
      }
    />
  );
});
