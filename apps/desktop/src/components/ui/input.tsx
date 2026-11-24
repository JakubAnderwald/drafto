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

import { useAccessibilityAnnouncement } from "@/hooks/use-accessibility-announcement";
import { useTheme } from "@/providers/theme-provider";
import { fontSizes, radii, spacing, type SemanticColors } from "@/theme/tokens";

export interface InputProps extends Omit<TextInputProps, "style"> {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  label?: string;
  /**
   * Shown under the field, which turns its border red. Its testID is `${testID}-error`. VoiceOver
   * announces it as it appears (a queued announcement: the alert role alone maps to no macOS role
   * and says nothing), and the field carries it as its accessibility hint, so VoiceOver reads it
   * again when the field gets focus.
   */
  errorText?: string;
  /**
   * The form's submit counter. When it changes, the error is announced again even if its words
   * are the same, so every submit that fails is heard.
   */
  submitAttempt?: number;
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
    submitAttempt,
    leftIcon,
    rightIcon,
    secureTextEntry,
    style,
    testID,
    onFocus,
    onBlur,
    accessibilityHint,
    ...rest
  },
  ref,
) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const [focused, setFocused] = useState(false);
  useAccessibilityAnnouncement(errorText || null, { queue: true, attempt: submitAttempt });

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
          accessibilityHint={errorText || accessibilityHint}
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
      {errorText ? (
        <Text
          style={styles.errorText}
          testID={testID ? `${testID}-error` : undefined}
          accessibilityRole="alert"
        >
          {errorText}
        </Text>
      ) : null}
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
