import { useState, useMemo, useCallback } from "react";
import { View, Text, Pressable, TextInput, StyleSheet, ActivityIndicator } from "react-native";

import { useNotebooks } from "@/hooks/use-notebooks";
import { useAuth } from "@/providers/auth-provider";
import { useTheme } from "@/providers/theme-provider";
import { database, Notebook } from "@/db";
import { generateId } from "@/lib/generate-id";
import { colors } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import { SyncStatus } from "@/components/sync-status";

interface NotebooksSidebarProps {
  selectedNotebookId: string | undefined;
  onSelectNotebook: (id: string) => void;
  showTrash: boolean;
  onToggleTrash: () => void;
  onOpenSearch: () => void;
}

export function NotebooksSidebar({
  selectedNotebookId,
  onSelectNotebook,
  showTrash,
  onToggleTrash,
  onOpenSearch,
}: NotebooksSidebarProps) {
  const { notebooks, loading } = useNotebooks();
  const { user, signOut } = useAuth();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name || !user) return;

    try {
      const id = generateId();
      await database.write(async () => {
        await database.get<Notebook>("notebooks").create((nb) => {
          nb._raw.id = id;
          nb.remoteId = id;
          nb.userId = user.id;
          nb.name = name;
        });
      });

      setNewName("");
      setIsCreating(false);
    } catch (err) {
      console.error("Failed to create notebook:", err);
    }
  }, [newName, user]);

  const handleRename = useCallback(
    async (notebook: Notebook) => {
      const name = editName.trim();
      if (!name) return;

      try {
        await database.write(async () => {
          await notebook.update((nb) => {
            nb.name = name;
          });
        });

        setEditingId(null);
        setEditName("");
      } catch (err) {
        console.error("Failed to rename notebook:", err);
      }
    },
    [editName],
  );

  const handleDelete = useCallback(async (notebook: Notebook) => {
    try {
      await database.write(async () => {
        await notebook.markAsDeleted();
      });
    } catch (err) {
      console.error("Failed to delete notebook:", err);
    }
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.appTitle}>Drafto</Text>
        <View style={styles.headerActions}>
          <Pressable
            style={({ pressed }) => [styles.searchButton, pressed && styles.searchButtonPressed]}
            onPress={onOpenSearch}
          >
            <Text style={styles.searchButtonText}>Search</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}
            onPress={() => setIsCreating(true)}
          >
            <Text style={styles.addButtonText}>+</Text>
          </Pressable>
        </View>
      </View>

      {isCreating && (
        <View style={styles.createRow}>
          <TextInput
            style={styles.input}
            value={newName}
            onChangeText={setNewName}
            placeholder="Notebook name"
            placeholderTextColor={semantic.fgSubtle}
            autoFocus
            onSubmitEditing={handleCreate}
            // @ts-expect-error -- RN macOS supports onKeyDown but types are incomplete
            onKeyDown={(e: { nativeEvent: { key: string } }) => {
              if (e.nativeEvent.key === "Escape") {
                setIsCreating(false);
                setNewName("");
              }
            }}
          />
        </View>
      )}

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="small" color={colors.primary[600]} />
        </View>
      ) : (
        <View style={styles.list}>
          {notebooks.map((nb) => {
            const isSelected = !showTrash && nb.id === selectedNotebookId;
            const isEditing = editingId === nb.id;

            return (
              <Pressable
                key={nb.id}
                style={[styles.item, isSelected && styles.itemSelected]}
                onPress={() => {
                  onSelectNotebook(nb.id);
                }}
                onLongPress={() => {
                  setEditingId(nb.id);
                  setEditName(nb.name);
                }}
              >
                {isEditing ? (
                  <TextInput
                    style={styles.editInput}
                    value={editName}
                    onChangeText={setEditName}
                    autoFocus
                    onSubmitEditing={() => handleRename(nb)}
                    onBlur={() => {
                      setEditingId(null);
                      setEditName("");
                    }}
                  />
                ) : (
                  <View style={styles.itemRow}>
                    <Text
                      style={[styles.itemText, isSelected && styles.itemTextSelected]}
                      numberOfLines={1}
                    >
                      {nb.name}
                    </Text>
                    <Pressable
                      style={styles.deleteButton}
                      onPress={() => handleDelete(nb)}
                      hitSlop={8}
                    >
                      <Text style={styles.deleteButtonText}>&times;</Text>
                    </Pressable>
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      )}

      <View style={styles.footer}>
        <Pressable
          style={[styles.trashButton, showTrash && styles.trashButtonActive]}
          onPress={onToggleTrash}
        >
          <Text style={[styles.trashText, showTrash && styles.trashTextActive]}>Trash</Text>
        </Pressable>

        <SyncStatus />

        <View style={styles.userSection}>
          <Text style={styles.userEmail} numberOfLines={1}>
            {user?.email}
          </Text>
          <Pressable onPress={signOut}>
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: semantic.bgSubtle,
      borderRightWidth: 1,
      borderRightColor: semantic.border,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      padding: 16,
      paddingTop: 12,
      borderBottomWidth: 1,
      borderBottomColor: semantic.border,
    },
    appTitle: {
      fontSize: 15,
      fontWeight: "700",
      color: semantic.fg,
    },
    headerActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    searchButton: {
      paddingVertical: 3,
      paddingHorizontal: 8,
      borderRadius: 6,
      backgroundColor: semantic.bgMuted,
    },
    searchButtonPressed: {
      backgroundColor: semantic.bgMutedHover,
    },
    searchButtonText: {
      fontSize: 11,
      color: semantic.fgMuted,
    },
    addButton: {
      width: 24,
      height: 24,
      borderRadius: 6,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.primary[600],
    },
    addButtonPressed: {
      backgroundColor: colors.primary[700],
    },
    addButtonText: {
      fontSize: 16,
      fontWeight: "600",
      color: colors.white,
      lineHeight: 18,
    },
    createRow: {
      padding: 8,
      paddingHorizontal: 12,
    },
    input: {
      fontSize: 13,
      color: semantic.fg,
      backgroundColor: semantic.bg,
      borderWidth: 1,
      borderColor: semantic.borderStrong,
      borderRadius: 6,
      padding: 6,
      paddingHorizontal: 8,
    },
    loadingContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    list: {
      flex: 1,
      paddingVertical: 4,
    },
    item: {
      paddingVertical: 8,
      paddingHorizontal: 12,
      marginHorizontal: 8,
      borderRadius: 6,
    },
    itemSelected: {
      backgroundColor: semantic.bgMuted,
    },
    itemRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    itemText: {
      fontSize: 13,
      color: semantic.fg,
      flex: 1,
    },
    itemTextSelected: {
      fontWeight: "600",
    },
    editInput: {
      fontSize: 13,
      color: semantic.fg,
      backgroundColor: semantic.bg,
      borderWidth: 1,
      borderColor: semantic.borderStrong,
      borderRadius: 4,
      padding: 4,
      paddingHorizontal: 6,
    },
    deleteButton: {
      marginLeft: 4,
      opacity: 0.5,
    },
    deleteButtonText: {
      fontSize: 16,
      color: semantic.fgMuted,
    },
    footer: {
      borderTopWidth: 1,
      borderTopColor: semantic.border,
    },
    trashButton: {
      paddingVertical: 8,
      paddingHorizontal: 12,
      marginHorizontal: 8,
      marginTop: 4,
      borderRadius: 6,
    },
    trashButtonActive: {
      backgroundColor: semantic.bgMuted,
    },
    trashText: {
      fontSize: 13,
      color: semantic.fgMuted,
    },
    trashTextActive: {
      fontWeight: "600",
      color: semantic.fg,
    },
    userSection: {
      padding: 12,
      borderTopWidth: 1,
      borderTopColor: semantic.border,
    },
    userEmail: {
      fontSize: 11,
      color: semantic.fgSubtle,
      marginBottom: 4,
    },
    signOutText: {
      fontSize: 11,
      color: colors.primary[600],
    },
  });
