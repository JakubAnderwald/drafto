import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
} from "react-native";

import { useSearch } from "@/hooks/use-search";
import { useTheme } from "@/providers/theme-provider";
import { colors } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";

interface SearchOverlayProps {
  visible: boolean;
  onClose: () => void;
  onSelectNote: (noteId: string) => void;
}

export function SearchOverlay({ visible, onClose, onSelectNote }: SearchOverlayProps) {
  const [query, setQuery] = useState("");
  const { results, loading, error } = useSearch(query);
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setQuery("");
      // Focus input after modal opens
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [visible]);

  const handleSelect = useCallback(
    (noteId: string) => {
      onSelectNote(noteId);
      onClose();
    },
    [onSelectNote, onClose],
  );

  if (!visible) return null;

  return (
    <View style={styles.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={styles.container}>
        <View style={styles.searchRow}>
          <Text style={styles.searchIcon}>⌘K</Text>
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            placeholder="Search notes..."
            placeholderTextColor={semantic.fgSubtle}
            // @ts-expect-error -- RN macOS supports onKeyDown but types are incomplete
            onKeyDown={(e: { nativeEvent: { key: string } }) => {
              if (e.nativeEvent.key === "Escape") {
                onClose();
              }
            }}
          />
          {loading && <ActivityIndicator size="small" color={colors.primary[600]} />}
        </View>

        {query.trim() !== "" && (
          <ScrollView style={styles.results}>
            {error ? (
              <Text style={styles.noResults}>{error}</Text>
            ) : results.length === 0 && !loading ? (
              <Text style={styles.noResults}>No results found</Text>
            ) : (
              results.map((note) => (
                <Pressable
                  key={note.id}
                  style={({ pressed }) => [styles.resultItem, pressed && styles.resultItemPressed]}
                  onPress={() => handleSelect(note.id)}
                >
                  <Text style={styles.resultTitle} numberOfLines={1}>
                    {note.title || "Untitled"}
                  </Text>
                  <Text style={styles.resultDate}>{note.updatedAt.toLocaleDateString()}</Text>
                </Pressable>
              ))
            )}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(0, 0, 0, 0.3)",
      alignItems: "center",
      paddingTop: 80,
      zIndex: 1000,
    },
    container: {
      width: 480,
      maxHeight: 400,
      backgroundColor: semantic.bg,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: semantic.borderStrong,
      overflow: "hidden",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.15,
      shadowRadius: 24,
    },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      padding: 12,
      borderBottomWidth: 1,
      borderBottomColor: semantic.border,
      gap: 8,
    },
    searchIcon: {
      fontSize: 11,
      color: semantic.fgSubtle,
      backgroundColor: semantic.bgMuted,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
      overflow: "hidden",
      fontWeight: "600",
    },
    input: {
      flex: 1,
      fontSize: 14,
      color: semantic.fg,
    },
    results: {
      maxHeight: 320,
    },
    noResults: {
      padding: 16,
      fontSize: 13,
      color: semantic.fgMuted,
      textAlign: "center",
    },
    resultItem: {
      padding: 10,
      paddingHorizontal: 16,
      borderBottomWidth: 1,
      borderBottomColor: semantic.border,
    },
    resultItemPressed: {
      backgroundColor: semantic.bgMuted,
    },
    resultTitle: {
      fontSize: 14,
      fontWeight: "500",
      color: semantic.fg,
    },
    resultDate: {
      fontSize: 11,
      color: semantic.fgSubtle,
      marginTop: 2,
    },
  });
