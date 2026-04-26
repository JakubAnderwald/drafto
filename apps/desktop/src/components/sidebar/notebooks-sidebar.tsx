import { useState, useMemo, useCallback, useEffect } from "react";
import { View, Text, Pressable, TextInput, StyleSheet, ActivityIndicator } from "react-native";

import { useNotebooks } from "@/hooks/use-notebooks";
import { useAuth } from "@/providers/auth-provider";
import { useTheme } from "@/providers/theme-provider";
import { database, Notebook } from "@/db";
import { generateId } from "@/lib/generate-id";
import { colors, fontFamily, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import { SyncStatus } from "@/components/sync-status";
import { IconButton } from "@/components/ui/icon-button";
import { PlusIcon } from "@/components/ui/icons/plus-icon";
import { SearchIcon } from "@/components/ui/icons/search-icon";

interface NotebooksSidebarProps {
  selectedNotebookId: string | undefined;
  onSelectNotebook: (id: string) => void;
  showTrash: boolean;
  onToggleTrash: () => void;
  onOpenSearch: () => void;
  triggerCreate?: boolean;
  onTriggerCreateHandled?: () => void;
}

export function NotebooksSidebar({
  selectedNotebookId,
  onSelectNotebook,
  showTrash,
  onToggleTrash,
  onOpenSearch,
  triggerCreate,
  onTriggerCreateHandled,
}: NotebooksSidebarProps) {
  const { notebooks, loading } = useNotebooks();
  const { user, signOut } = useAuth();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  // Allow programmatic trigger of create mode (from menu shortcut)
  useEffect(() => {
    if (triggerCreate) {
      setIsCreating(true);
      onTriggerCreateHandled?.();
    }
  }, [triggerCreate, onTriggerCreateHandled]);

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
        <IconButton onPress={onOpenSearch} accessibilityLabel="Search">
          <SearchIcon size={18} color={semantic.fgMuted} />
        </IconButton>
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabel}>NOTEBOOKS</Text>
        <IconButton onPress={() => setIsCreating(true)} accessibilityLabel="New notebook">
          <PlusIcon size={16} color={semantic.fgMuted} />
        </IconButton>
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
          {notebooks.map((nb) => (
            <NotebookRow
              key={nb.id}
              notebook={nb}
              isSelected={!showTrash && nb.id === selectedNotebookId}
              isEditing={editingId === nb.id}
              editName={editName}
              onSelect={() => onSelectNotebook(nb.id)}
              onStartEdit={() => {
                setEditingId(nb.id);
                setEditName(nb.name);
              }}
              onEditNameChange={setEditName}
              onSubmitRename={() => handleRename(nb)}
              onCancelEdit={() => {
                setEditingId(null);
                setEditName("");
              }}
              onDelete={() => handleDelete(nb)}
              styles={styles}
            />
          ))}
        </View>
      )}

      <View style={styles.footer}>
        <Pressable
          style={[styles.trashButton, showTrash && styles.trashButtonActive]}
          onPress={onToggleTrash}
          accessibilityLabel="Trash"
          accessibilityRole="button"
        >
          <Text style={[styles.trashText, showTrash && styles.trashTextActive]}>Trash</Text>
        </Pressable>

        <SyncStatus />

        <View style={styles.userSection}>
          <Text style={styles.userEmail} numberOfLines={1}>
            {user?.email}
          </Text>
          <Pressable onPress={signOut} accessibilityLabel="Sign out" accessibilityRole="button">
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

interface NotebookRowProps {
  notebook: Notebook;
  isSelected: boolean;
  isEditing: boolean;
  editName: string;
  onSelect: () => void;
  onStartEdit: () => void;
  onEditNameChange: (name: string) => void;
  onSubmitRename: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  styles: ReturnType<typeof createStyles>;
}

function NotebookRow({
  notebook,
  isSelected,
  isEditing,
  editName,
  onSelect,
  onStartEdit,
  onEditNameChange,
  onSubmitRename,
  onCancelEdit,
  onDelete,
  styles,
}: NotebookRowProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      style={[
        styles.item,
        hovered && !isSelected && styles.itemHover,
        isSelected && styles.itemSelected,
      ]}
      onPress={onSelect}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityLabel={notebook.name}
      onLongPress={onStartEdit}
    >
      {isEditing ? (
        <TextInput
          style={styles.editInput}
          value={editName}
          onChangeText={onEditNameChange}
          autoFocus
          onSubmitEditing={onSubmitRename}
          onBlur={onCancelEdit}
        />
      ) : (
        <View style={styles.itemRow}>
          <Text style={[styles.itemText, isSelected && styles.itemTextSelected]} numberOfLines={1}>
            {notebook.name}
          </Text>
          <Pressable
            style={[styles.deleteButton, !hovered && styles.deleteButtonHidden]}
            onPress={onDelete}
            hitSlop={8}
            disabled={!hovered}
            focusable={hovered}
            accessibilityElementsHidden={!hovered}
            importantForAccessibility={hovered ? "yes" : "no-hide-descendants"}
            accessibilityLabel="Delete notebook"
            accessibilityRole="button"
          >
            <Text style={styles.deleteButtonText}>&times;</Text>
          </Pressable>
        </View>
      )}
    </Pressable>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: semantic.sidebarBg,
      borderRightWidth: 1,
      borderRightColor: semantic.border,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    appTitle: {
      fontSize: fontSizes.base,
      fontWeight: "600",
      color: semantic.fg,
      fontFamily: fontFamily.sans,
      paddingLeft: spacing.xs,
    },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.md,
      paddingTop: spacing.md,
      paddingBottom: spacing.xs,
    },
    sectionLabel: {
      fontSize: fontSizes.xs,
      fontWeight: "600",
      color: semantic.fgMuted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      fontFamily: fontFamily.sans,
    },
    createRow: {
      paddingHorizontal: spacing.sm,
      paddingBottom: spacing.xs,
    },
    input: {
      fontSize: fontSizes.base,
      color: semantic.fg,
      backgroundColor: semantic.bg,
      borderWidth: 1,
      borderColor: semantic.borderStrong,
      borderRadius: radii.sm,
      padding: spacing.sm,
      paddingHorizontal: spacing.sm,
      fontFamily: fontFamily.sans,
    },
    loadingContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    list: {
      flex: 1,
      paddingHorizontal: spacing.sm,
    },
    item: {
      paddingVertical: 6,
      paddingHorizontal: spacing.sm,
      borderRadius: radii.sm,
      marginBottom: 2,
    },
    itemHover: {
      backgroundColor: semantic.sidebarHover,
    },
    itemSelected: {
      backgroundColor: semantic.sidebarActive,
    },
    itemRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    itemText: {
      fontSize: fontSizes.base,
      color: semantic.fg,
      flex: 1,
      fontFamily: fontFamily.sans,
    },
    itemTextSelected: {
      fontWeight: "500",
      color: semantic.sidebarActiveText,
    },
    editInput: {
      fontSize: fontSizes.base,
      color: semantic.fg,
      backgroundColor: semantic.bg,
      borderWidth: 1,
      borderColor: semantic.borderStrong,
      borderRadius: radii.sm,
      padding: spacing.xs,
      paddingHorizontal: spacing.sm,
      fontFamily: fontFamily.sans,
    },
    deleteButton: {
      marginLeft: spacing.xs,
      opacity: 1,
    },
    deleteButtonHidden: {
      opacity: 0,
      // Prevent the invisible button from intercepting taps on the row body.
      pointerEvents: "none",
    },
    deleteButtonText: {
      fontSize: fontSizes.xl,
      color: semantic.fgMuted,
    },
    footer: {
      borderTopWidth: 1,
      borderTopColor: semantic.border,
    },
    trashButton: {
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.sm,
      marginHorizontal: spacing.sm,
      marginTop: spacing.xs,
      borderRadius: radii.sm,
    },
    trashButtonActive: {
      backgroundColor: semantic.sidebarActive,
    },
    trashText: {
      fontSize: fontSizes.base,
      color: semantic.fgMuted,
      fontFamily: fontFamily.sans,
    },
    trashTextActive: {
      fontWeight: "500",
      color: semantic.sidebarActiveText,
    },
    userSection: {
      padding: spacing.md,
      borderTopWidth: 1,
      borderTopColor: semantic.border,
    },
    userEmail: {
      fontSize: fontSizes.sm,
      color: semantic.fgSubtle,
      marginBottom: spacing.xs,
      fontFamily: fontFamily.sans,
    },
    signOutText: {
      fontSize: fontSizes.sm,
      color: colors.primary[600],
      fontFamily: fontFamily.sans,
    },
  });
