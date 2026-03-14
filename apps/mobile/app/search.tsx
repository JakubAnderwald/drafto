import { useState, useMemo, useCallback } from "react";
import { Text, View, FlatList, TextInput, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { useTheme } from "@/providers/theme-provider";
import { useSearch } from "@/hooks/use-search";
import { ListSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { colors } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { Note } from "@/db";

export default function SearchScreen() {
  const [query, setQuery] = useState("");
  const { results, loading } = useSearch(query);
  const { semantic } = useTheme();
  const router = useRouter();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const renderResult = useCallback(
    ({ item }: { item: Note }) => (
      <Pressable onPress={() => router.push(`/notes/${item.id}`)}>
        <View style={styles.row}>
          <Ionicons
            name="document-text-outline"
            size={20}
            color={semantic.fgSubtle}
            style={styles.rowIcon}
          />
          <View style={styles.rowContent}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              {item.title}
            </Text>
            {item.isTrashed ? <Text style={styles.trashBadge}>Trash</Text> : null}
          </View>
        </View>
      </Pressable>
    ),
    [router, styles, semantic.fgSubtle],
  );

  const trimmedQuery = query.trim();

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.searchInput}
        placeholder="Search notes..."
        placeholderTextColor={semantic.fgSubtle}
        value={query}
        onChangeText={setQuery}
        autoFocus
        returnKeyType="search"
      />
      {loading && trimmedQuery ? (
        <ListSkeleton variant="notes" />
      ) : results.length === 0 && trimmedQuery ? (
        <EmptyState
          icon="search-outline"
          title="No notes found"
          subtitle="Try a different search term"
        />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          renderItem={renderResult}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: semantic.bgSubtle,
    },
    searchInput: {
      fontSize: 16,
      color: semantic.fg,
      backgroundColor: semantic.bg,
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: semantic.border,
    },
    list: {
      paddingVertical: 8,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 14,
      paddingHorizontal: 16,
      backgroundColor: semantic.bg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: semantic.border,
    },
    rowIcon: {
      marginRight: 12,
    },
    rowContent: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
    },
    rowTitle: {
      fontSize: 16,
      color: semantic.fg,
      flex: 1,
    },
    trashBadge: {
      fontSize: 11,
      color: colors.error,
      fontWeight: "600",
      marginLeft: 8,
    },
  });
