import { useEffect, useMemo, useRef } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";

import { useTheme } from "@/providers/theme-provider";
import { fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { FindResult } from "@/components/editor/find-engine";

interface FindBarProps {
  query: string;
  match: FindResult;
  onChangeQuery: (query: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /** Bumped by the parent on each Cmd+F so the input re-focuses when reopened. */
  focusSignal: number;
}

export function FindBar({
  query,
  match,
  onChangeQuery,
  onNext,
  onPrev,
  onClose,
  focusSignal,
}: FindBarProps) {
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    // Focus shortly after mount / each Cmd+F so the user can type immediately.
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [focusSignal]);

  // Not trimmed: the injected engine searches the raw query (a whitespace-only
  // query really does match whitespace), so the count must reflect that too —
  // otherwise the UI shows "empty" while the engine highlights and enables nav.
  const hasQuery = query !== "";
  const disabled = match.total === 0;
  const countLabel = !hasQuery ? "" : disabled ? "No results" : `${match.current}/${match.total}`;

  return (
    <View style={styles.container}>
      <Text style={styles.icon}>🔍</Text>
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={query}
        onChangeText={onChangeQuery}
        placeholder="Find in note"
        placeholderTextColor={semantic.fgSubtle}
        autoCapitalize="none"
        autoCorrect={false}
        // @ts-expect-error -- RN macOS supports onKeyDown but types are incomplete
        onKeyDown={(e: { nativeEvent: { key: string; shiftKey?: boolean } }) => {
          const { key, shiftKey } = e.nativeEvent;
          if (key === "Enter") {
            if (shiftKey) onPrev();
            else onNext();
          } else if (key === "Escape") {
            onClose();
          }
        }}
      />
      {countLabel !== "" && <Text style={styles.count}>{countLabel}</Text>}
      <Pressable
        accessibilityLabel="Previous match"
        disabled={disabled}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        onPress={onPrev}
      >
        <Text style={[styles.buttonText, disabled && styles.buttonTextDisabled]}>‹</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="Next match"
        disabled={disabled}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        onPress={onNext}
      >
        <Text style={[styles.buttonText, disabled && styles.buttonTextDisabled]}>›</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="Close find"
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        onPress={onClose}
      >
        <Text style={styles.buttonText}>✕</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      position: "absolute",
      top: spacing.md,
      right: spacing.md,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      backgroundColor: semantic.bg,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: semantic.borderStrong,
      // shadowColor hex is allowed by the design-system lint (color/bg/border only).
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.15,
      shadowRadius: 12,
      zIndex: 10,
    },
    icon: {
      fontSize: fontSizes.sm,
      color: semantic.fgSubtle,
    },
    input: {
      minWidth: 160,
      fontSize: fontSizes.base,
      color: semantic.fg,
      paddingVertical: spacing["2xs"],
      paddingHorizontal: spacing.xs,
    },
    count: {
      fontSize: fontSizes.sm,
      color: semantic.fgSubtle,
      minWidth: 48,
      textAlign: "right",
    },
    button: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing["2xs"],
      borderRadius: radii.sm,
    },
    buttonPressed: {
      backgroundColor: semantic.bgMuted,
    },
    buttonText: {
      fontSize: fontSizes.lg,
      color: semantic.fg,
    },
    buttonTextDisabled: {
      color: semantic.fgSubtle,
    },
  });
