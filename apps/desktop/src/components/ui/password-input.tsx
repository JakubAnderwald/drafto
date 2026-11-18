import { forwardRef, useCallback, useEffect, useRef, useState, type Ref } from "react";
import type { TextInput } from "react-native";
import { PASSWORD_VISIBILITY_LABELS } from "@drafto/shared";

import { IconButton } from "@/components/ui/icon-button";
import { EyeIcon } from "@/components/ui/icons/eye-icon";
import { Input, type InputProps } from "@/components/ui/input";
import { useTheme } from "@/providers/theme-provider";

export type PasswordInputProps = Omit<InputProps, "secureTextEntry" | "rightIcon">;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

/**
 * A password field with a show/hide toggle in the Input's right slot. Hidden by default; the
 * caller's `autoComplete` / `textContentType` stay on the same field in both states. The
 * toggle's testID is `${testID}-toggle`.
 *
 * react-native-macos swaps the native view (secure ↔ plain text field) when `secureTextEntry`
 * changes, which drops keyboard focus, so the field is focused again after each toggle.
 */
export const PasswordInput = forwardRef<TextInput, PasswordInputProps>(function PasswordInput(
  { testID, editable, ...props },
  ref,
) {
  const { semantic } = useTheme();
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<TextInput | null>(null);
  const toggled = useRef(false);

  const setRefs = useCallback(
    (node: TextInput | null) => {
      inputRef.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  useEffect(() => {
    if (!toggled.current) return;
    toggled.current = false;
    inputRef.current?.focus();
  }, [visible]);

  const toggle = () => {
    toggled.current = true;
    setVisible((v) => !v);
  };

  return (
    <Input
      {...props}
      ref={setRefs}
      testID={testID}
      editable={editable}
      secureTextEntry={!visible}
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
