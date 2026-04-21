import { forwardRef, useMemo, useState } from "react";
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
import { fontSizes, radii, spacing, type SemanticColors } from "@/theme/tokens";

interface InputProps extends Omit<TextInputProps, "style"> {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  label?: string;
  errorText?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  secureTextEntry?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  {
    value,
    onChangeText,
    placeholder,
    label,
    errorText,
    leftIcon,
    rightIcon,
    secureTextEntry,
    style,
    testID,
    onFocus,
    onBlur,
    ...rest
  },
  ref,
) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const [focused, setFocused] = useState(false);

  const hasError = Boolean(errorText);

  const containerStyle = [
    styles.inputContainer,
    focused && !hasError ? styles.inputContainerFocused : null,
    hasError ? styles.inputContainerError : null,
    style,
  ];

  return (
    <View style={styles.wrapper}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={containerStyle}>
        {leftIcon ? <View style={styles.leftIcon}>{leftIcon}</View> : null}
        <TextInput
          ref={ref}
          testID={testID}
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={semantic.fgSubtle}
          secureTextEntry={secureTextEntry}
          accessibilityLabel={label}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          {...rest}
        />
        {rightIcon ? <View style={styles.rightIcon}>{rightIcon}</View> : null}
      </View>
      {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
    </View>
  );
});

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    wrapper: {
      width: "100%",
    },
    label: {
      fontSize: fontSizes.sm,
      fontWeight: "600",
      color: semantic.fgMuted,
      marginBottom: spacing.sm,
    },
    inputContainer: {
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 1,
      borderColor: semantic.border,
      borderRadius: radii.md,
      backgroundColor: semantic.bg,
      paddingHorizontal: spacing.md,
      minHeight: 36,
    },
    inputContainerFocused: {
      borderColor: semantic.ring,
    },
    inputContainerError: {
      borderColor: semantic.errorText,
    },
    input: {
      flex: 1,
      fontSize: fontSizes.base,
      color: semantic.fg,
      paddingVertical: spacing.sm,
    },
    leftIcon: {
      marginRight: spacing.sm,
    },
    rightIcon: {
      marginLeft: spacing.sm,
    },
    errorText: {
      fontSize: fontSizes.sm,
      color: semantic.errorText,
      marginTop: spacing.xs,
    },
  });
