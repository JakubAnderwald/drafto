import { forwardRef, useMemo, useState, type ReactNode } from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";

import { useTheme } from "@/providers/theme-provider";
import { fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

export interface InputProps extends Omit<TextInputProps, "style"> {
  label?: string;
  errorText?: string;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<ViewStyle>;
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  {
    label,
    errorText,
    leftIcon,
    rightIcon,
    containerStyle,
    inputStyle,
    onFocus,
    onBlur,
    editable,
    ...textInputProps
  },
  ref,
) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const [focused, setFocused] = useState(false);

  const hasError = Boolean(errorText);
  const borderColor = hasError ? semantic.errorText : focused ? semantic.ring : semantic.border;

  return (
    <View style={[styles.container, containerStyle]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={[styles.inputWrapper, { borderColor }, focused && styles.focused]}>
        {leftIcon ? <View style={styles.leftIcon}>{leftIcon}</View> : null}
        <TextInput
          ref={ref}
          style={[styles.input, inputStyle]}
          placeholderTextColor={semantic.fgSubtle}
          editable={editable}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          {...textInputProps}
        />
        {rightIcon ? <View style={styles.rightIcon}>{rightIcon}</View> : null}
      </View>
      {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
    </View>
  );
});

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      width: "100%",
    },
    label: {
      fontSize: fontSizes.sm,
      color: semantic.fgMuted,
      marginBottom: spacing.xs,
      fontWeight: "600",
    },
    inputWrapper: {
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 1,
      borderRadius: radii.md,
      backgroundColor: semantic.bg,
      paddingHorizontal: spacing.md,
    },
    focused: {
      borderWidth: 1,
    },
    leftIcon: {
      marginRight: spacing.sm,
    },
    rightIcon: {
      marginLeft: spacing.sm,
    },
    input: {
      flex: 1,
      paddingVertical: spacing.sm,
      fontSize: fontSizes.xl,
      color: semantic.fg,
    },
    errorText: {
      fontSize: fontSizes.sm,
      color: semantic.errorText,
      marginTop: spacing.xs,
    },
  });
