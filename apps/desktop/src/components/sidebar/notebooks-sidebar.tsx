import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import { Q } from "@nozbe/watermelondb";
import {
  MAX_NOTEBOOK_NAME_LENGTH,
  duplicateNotebookNameMessage,
  findDuplicateNotebook,
  formatNoteCount,
  type AppleRevocationGrant,
} from "@drafto/shared";

import { useNetworkStatus } from "@/hooks/use-network-status";
import { useNotebooks } from "@/hooks/use-notebooks";
import { useNotebookNoteCount } from "@/hooks/use-notebook-note-count";
import { useRowDeleteAction } from "@/hooks/use-row-delete-action";
import { useSafeSignOut } from "@/hooks/use-safe-sign-out";
import { useAuth } from "@/providers/auth-provider";
import { useTheme } from "@/providers/theme-provider";
import { database, Notebook, Note, Attachment } from "@/db";
import { generateId } from "@/lib/generate-id";
import { colors, fontFamily, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import { SyncStatus } from "@/components/sync-status";
import { AppMenu } from "@/components/sidebar/app-menu";
import { DeleteAccountPanel } from "@/components/sidebar/delete-account-panel";
import { StorageUsageMeter } from "@/components/sidebar/storage-usage";
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
  const { user, deleteAccount } = useAuth();
  const { signOut, isSigningOut } = useSafeSignOut();
  const { isConnected, isInternetReachable } = useNetworkStatus();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  // Unknown reachability (`null`) stays enabled; only an explicit `false` counts as offline.
  const isOffline = !isConnected || isInternetReachable === false;

  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  // A taken name (PrimeTestLab 11035 M-01): shown under the open field, which stays open.
  const [createError, setCreateError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

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

    const duplicate = findDuplicateNotebook(name, notebooks);
    if (duplicate) {
      setCreateError(duplicateNotebookNameMessage(duplicate.name));
      return;
    }

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
      setCreateError(err instanceof Error ? err.message : "Failed to create notebook");
    }
  }, [newName, notebooks, user]);

  const handleRename = useCallback(
    async (notebook: Notebook) => {
      const name = editName.trim();
      if (!name) return;

      const duplicate = findDuplicateNotebook(name, notebooks, notebook.id);
      if (duplicate) {
        setRenameError(duplicateNotebookNameMessage(duplicate.name));
        return;
      }

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
        setRenameError(err instanceof Error ? err.message : "Failed to rename notebook");
      }
    },
    [editName, notebooks],
  );

  const closeCreate = useCallback(() => {
    setIsCreating(false);
    setNewName("");
    setCreateError(null);
  }, []);

  const changeNewName = useCallback((text: string) => {
    setNewName(text);
    setCreateError(null);
  }, []);

  const changeEditName = useCallback((text: string) => {
    setEditName(text);
    setRenameError(null);
  }, []);

  const handleDelete = useCallback(async (notebook: Notebook) => {
    try {
      // Fast pre-check: don't even offer deletion while non-trashed notes remain.
      // Mirrors the web API's 409 guard (apps/web/src/app/api/notebooks/[id]/route.ts),
      // which mobile/desktop bypass by writing straight to WatermelonDB + sync.
      const activeNoteCount = await database
        .get<Note>("notes")
        .query(Q.where("notebook_id", notebook.id), Q.where("is_trashed", false))
        .fetchCount();

      if (activeNoteCount > 0) {
        Alert.alert(
          "Cannot Delete Notebook",
          "Cannot delete notebook with notes. Move or delete notes first.",
        );
        return;
      }

      Alert.alert(
        "Delete Notebook",
        `Delete notebook "${notebook.name}"? Trashed notes inside will be permanently deleted.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                // Re-read atomically at delete time: a background sync could have pulled
                // a note into this notebook between the guard check and this confirmation.
                const notes = await database
                  .get<Note>("notes")
                  .query(Q.where("notebook_id", notebook.id))
                  .fetch();
                if (notes.some((note) => !note.isTrashed)) {
                  Alert.alert(
                    "Cannot Delete Notebook",
                    "Cannot delete notebook with notes. Move or delete notes first.",
                  );
                  return;
                }
                // Cascade the remaining (all trashed) notes and their attachments locally so
                // the WatermelonDB state matches the server FK `on delete cascade` after sync.
                await database.write(async () => {
                  for (const note of notes) {
                    const attachments = await database
                      .get<Attachment>("attachments")
                      .query(Q.where("note_id", note.id))
                      .fetch();
                    for (const attachment of attachments) {
                      await attachment.markAsDeleted();
                    }
                    await note.markAsDeleted();
                  }
                  await notebook.markAsDeleted();
                });
              } catch (err) {
                console.error("Failed to delete notebook:", err);
                Alert.alert(
                  "Error",
                  err instanceof Error ? err.message : "Failed to delete notebook",
                );
              }
            },
          },
        ],
      );
    } catch (err) {
      console.error("Failed to delete notebook:", err);
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to delete notebook");
    }
  }, []);

  // Open-only: closing goes through the panel's Cancel / Escape, which stay disabled while a
  // request is pending. A toggle could unmount the panel mid-request, hiding its result and
  // letting a second DELETE go out.
  const openDeleteAccountPanel = useCallback(() => setIsDeletingAccount(true), []);

  // Sign-out and account deletion both wipe the device, so they never overlap. During a
  // sign-out the panel cannot start a deletion: its confirm and Continue without Apple are
  // disabled, and an Apple answer that lands meanwhile is dropped. Sign out does nothing while
  // a deletion request is in flight (a successful deletion signs out by itself; after a failure
  // it works again). It still works while the panel waits for Apple, before any request.
  const deletionPendingRef = useRef(false);
  const confirmDeleteAccount = useCallback(
    async (appleRevocation?: AppleRevocationGrant, confirmedUserId?: string) => {
      deletionPendingRef.current = true;
      try {
        return await deleteAccount(appleRevocation, confirmedUserId);
      } finally {
        deletionPendingRef.current = false;
      }
    },
    [deleteAccount],
  );
  const signOutUnlessDeleting = useCallback(() => {
    if (deletionPendingRef.current) return;
    void signOut();
  }, [signOut]);

  return (
    <View style={styles.container}>
      <AppMenu
        onSignOut={signOutUnlessDeleting}
        onDeleteAccount={openDeleteAccountPanel}
        isOffline={isOffline}
      >
        {({ trigger, onAnchorLayout }) => (
          <>
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
                  testID="notebook-name-input"
                  style={styles.input}
                  value={newName}
                  onChangeText={changeNewName}
                  placeholder="Notebook name"
                  placeholderTextColor={semantic.fgSubtle}
                  autoFocus
                  maxLength={MAX_NOTEBOOK_NAME_LENGTH}
                  onSubmitEditing={handleCreate}
                  // Keeps the field focused after Return, so a refused name can be fixed in place.
                  submitBehavior="submit"
                  // @ts-expect-error -- RN macOS supports onKeyDown but types are incomplete
                  onKeyDown={(e: { nativeEvent: { key: string } }) => {
                    if (e.nativeEvent.key === "Escape") closeCreate();
                  }}
                />
                {createError ? (
                  <Text
                    testID="notebook-name-error"
                    accessibilityRole="alert"
                    style={styles.nameError}
                  >
                    {createError}
                  </Text>
                ) : null}
              </View>
            )}

            {loading ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={colors.primary[600]} />
              </View>
            ) : (
              // Fills the space between the headers and the footer and scrolls when the rows
              // don't fit, so every notebook stays reachable and none draws under the footer.
              // Kept before the footer: the footer must stay the AppMenu host's last child.
              <ScrollView
                testID="notebook-list"
                style={styles.list}
                contentContainerStyle={styles.listContent}
              >
                {notebooks.map((nb) => (
                  <NotebookRow
                    key={nb.id}
                    notebook={nb}
                    isSelected={!showTrash && nb.id === selectedNotebookId}
                    isEditing={editingId === nb.id}
                    isRenaming={editingId !== null}
                    editName={editName}
                    onSelect={() => onSelectNotebook(nb.id)}
                    renameError={editingId === nb.id ? renameError : null}
                    onStartEdit={() => {
                      setEditingId(nb.id);
                      setEditName(nb.name);
                      setRenameError(null);
                    }}
                    onEditNameChange={changeEditName}
                    onSubmitRename={() => handleRename(nb)}
                    onCancelEdit={() => {
                      setEditingId(null);
                      setEditName("");
                      setRenameError(null);
                    }}
                    onDelete={() => handleDelete(nb)}
                    styles={styles}
                  />
                ))}
              </ScrollView>
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

              {/* Desktop has no settings screen, so the account area shows the storage use. */}
              <StorageUsageMeter />

              {/* Last child of the footer, which is the last child of the AppMenu host: the menu
                  opens above it, positioned from the host's bottom edge by this section's height.
                  notebooks-sidebar.test.tsx checks that nothing renders below it. */}
              <View
                testID="sidebar-user-section"
                style={styles.userSection}
                onLayout={onAnchorLayout}
              >
                {/* While signing out (a last sync, maybe a confirmation, then the local wipe)
                    the row says so, and the menu trigger is swapped out so a second sign-out
                    cannot start. */}
                <View style={styles.userRow}>
                  <Text style={styles.userEmail} numberOfLines={1}>
                    {isSigningOut ? "Signing out…" : user?.email}
                  </Text>
                  {isSigningOut ? (
                    <ActivityIndicator
                      size="small"
                      color={colors.primary[600]}
                      testID="sign-out-progress"
                      accessibilityLabel="Signing out"
                    />
                  ) : (
                    trigger
                  )}
                </View>
                {/* Stays mounted during a sign-out, so a deletion already in flight keeps
                    its progress and result; it just cannot be confirmed meanwhile. */}
                {isDeletingAccount ? (
                  <DeleteAccountPanel
                    onCancel={() => setIsDeletingAccount(false)}
                    onConfirm={confirmDeleteAccount}
                    isOffline={isOffline}
                    disabled={isSigningOut}
                  />
                ) : null}
              </View>
            </View>
          </>
        )}
      </AppMenu>
    </View>
  );
}

interface NotebookRowProps {
  notebook: Notebook;
  isSelected: boolean;
  isEditing: boolean;
  /** Whether any notebook's rename field is open, this row's or another's. */
  isRenaming: boolean;
  editName: string;
  /** Why the typed name was refused (PrimeTestLab 11035 M-01), under the rename field. */
  renameError: string | null;
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
  isRenaming,
  editName,
  renameError,
  onSelect,
  onStartEdit,
  onEditNameChange,
  onSubmitRename,
  onCancelEdit,
  onDelete,
  styles,
}: NotebookRowProps) {
  const [hovered, setHovered] = useState(false);
  // The × below is hover-only. A press also focuses the row, which then takes ⌫ / ⌦, and
  // VoiceOver lists a named delete action on it.
  // Off while any rename field is open: a ⌫ typed in it bubbles up to this row, and focusing
  // a row would blur the field and drop the typed name.
  const deleteAction = useRowDeleteAction({
    label: "Delete notebook",
    onPress: onSelect,
    onDelete,
    isSelected,
    enabled: !isRenaming,
  });
  // How many notes it holds (PrimeTestLab 11035 S-03); null until counted.
  const count = useNotebookNoteCount(notebook.id);
  const countText = count === null ? null : formatNoteCount(count);

  return (
    <Pressable
      {...deleteAction}
      style={[
        styles.item,
        hovered && !isSelected && styles.itemHover,
        isSelected && styles.itemSelected,
      ]}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityLabel={notebook.name}
      // Read after the name: "Project Ideas, 3 notes".
      accessibilityValue={countText === null ? undefined : { text: countText }}
      onLongPress={onStartEdit}
    >
      {isEditing ? (
        <View>
          <TextInput
            style={styles.editInput}
            value={editName}
            onChangeText={onEditNameChange}
            autoFocus
            maxLength={MAX_NOTEBOOK_NAME_LENGTH}
            onSubmitEditing={onSubmitRename}
            // Return keeps the field focused, so a refused name stays on screen to fix.
            // Clicking away still cancels the rename, and clears the error with it.
            submitBehavior="submit"
            onBlur={onCancelEdit}
          />
          {renameError ? (
            <Text testID="notebook-name-error" accessibilityRole="alert" style={styles.nameError}>
              {renameError}
            </Text>
          ) : null}
        </View>
      ) : (
        <View style={styles.itemRow}>
          <Text style={[styles.itemText, isSelected && styles.itemTextSelected]} numberOfLines={1}>
            {notebook.name}
          </Text>
          {/* The count stays put on hover: the × appears in its own slot beside it. */}
          {countText !== null ? (
            <Text
              testID="notebook-note-count"
              style={[styles.countText, isSelected && styles.countTextSelected]}
            >
              {countText}
            </Text>
          ) : null}
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
    },
    listContent: {
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
      // Still in the flow: its slot keeps every row the same height, hovered or not.
    },
    countText: {
      marginLeft: spacing.xs,
      fontSize: fontSizes.sm,
      color: semantic.fgMuted,
      fontFamily: fontFamily.sans,
    },
    countTextSelected: {
      color: semantic.sidebarActiveText,
    },
    nameError: {
      marginTop: spacing.xs,
      fontSize: fontSizes.sm,
      color: semantic.errorText,
      fontFamily: fontFamily.sans,
    },
    deleteButtonText: {
      fontSize: fontSizes.xl,
      color: semantic.fgMuted,
    },
    footer: {
      borderTopWidth: 1,
      borderTopColor: semantic.border,
      // Opaque, so nothing drawn behind the footer can show through it.
      backgroundColor: semantic.sidebarBg,
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
    userRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
    },
    userEmail: {
      flex: 1,
      fontSize: fontSizes.sm,
      color: semantic.fgSubtle,
      fontFamily: fontFamily.sans,
    },
  });
