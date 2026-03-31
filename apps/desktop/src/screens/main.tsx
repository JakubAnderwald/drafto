import { useState, useMemo, useCallback } from "react";
import { View, StyleSheet } from "react-native";

import { useTheme } from "@/providers/theme-provider";
import { useMenuActions } from "@/providers/menu-provider";
import { useAuth } from "@/providers/auth-provider";
import { database, Note } from "@/db";
import { generateId } from "@/lib/generate-id";
import type { SemanticColors } from "@/theme/tokens";
import { NotebooksSidebar } from "@/components/sidebar/notebooks-sidebar";
import { NoteList } from "@/components/notes/note-list";
import { NoteEditorPanel } from "@/components/notes/note-editor-panel";
import { TrashList } from "@/components/notes/trash-list";
import { SearchOverlay } from "@/components/search/search-overlay";
import { OfflineBanner } from "@/components/offline-banner";

const SIDEBAR_WIDTH = 220;
const NOTE_LIST_WIDTH = 280;

export function MainScreen() {
  const { semantic } = useTheme();
  const { user } = useAuth();
  const styles = useMemo(() => createStyles(semantic), [semantic]);

  const [selectedNotebookId, setSelectedNotebookId] = useState<string | undefined>();
  const [selectedNoteId, setSelectedNoteId] = useState<string | undefined>();
  const [showTrash, setShowTrash] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [triggerNewNotebook, setTriggerNewNotebook] = useState(false);

  // Clear note selection when switching notebooks
  const handleSelectNotebook = useCallback((id: string) => {
    setSelectedNotebookId(id);
    setSelectedNoteId(undefined);
    setShowTrash(false);
  }, []);

  const handleToggleTrash = useCallback(() => {
    setShowTrash((prev) => {
      if (!prev) {
        setSelectedNoteId(undefined);
      }
      return !prev;
    });
  }, []);

  const handleSelectNoteFromSearch = useCallback((noteId: string) => {
    setSelectedNoteId(noteId);
    setShowTrash(false);
  }, []);

  const handleOpenSearch = useCallback(() => {
    setSearchVisible(true);
  }, []);

  const handleNewNote = useCallback(async () => {
    if (!selectedNotebookId || !user) return;
    try {
      const noteId = generateId();
      await database.write(async () => {
        await database.get<Note>("notes").create((n) => {
          n._raw.id = noteId;
          n.remoteId = noteId;
          n.userId = user.id;
          n.notebookId = selectedNotebookId;
          n.title = "Untitled";
          n.content = null;
          n.isTrashed = false;
        });
      });
      setSelectedNoteId(noteId);
    } catch (err) {
      console.error("Failed to create note from menu:", err);
    }
  }, [selectedNotebookId, user]);

  const handleNewNotebook = useCallback(() => {
    setSidebarVisible(true);
    setTriggerNewNotebook(true);
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setSidebarVisible((prev) => !prev);
  }, []);

  useMenuActions({
    newNote: handleNewNote,
    newNotebook: handleNewNotebook,
    openSearch: handleOpenSearch,
    toggleSidebar: handleToggleSidebar,
    showTrash: handleToggleTrash,
  });

  return (
    <View style={styles.container}>
      <OfflineBanner />

      <View style={styles.layout}>
        {/* Sidebar: notebooks */}
        {sidebarVisible && (
          <View style={[styles.sidebar, { width: SIDEBAR_WIDTH }]}>
            <NotebooksSidebar
              selectedNotebookId={selectedNotebookId}
              onSelectNotebook={handleSelectNotebook}
              showTrash={showTrash}
              onToggleTrash={handleToggleTrash}
              onOpenSearch={handleOpenSearch}
              triggerCreate={triggerNewNotebook}
              onTriggerCreateHandled={() => setTriggerNewNotebook(false)}
            />
          </View>
        )}

        {/* Middle: note list or trash */}
        <View style={[styles.noteList, { width: NOTE_LIST_WIDTH }]}>
          {showTrash ? (
            <TrashList />
          ) : (
            <NoteList
              notebookId={selectedNotebookId}
              selectedNoteId={selectedNoteId}
              onSelectNote={setSelectedNoteId}
            />
          )}
        </View>

        {/* Right: editor */}
        <View style={styles.editor}>
          {showTrash ? null : <NoteEditorPanel noteId={selectedNoteId} />}
        </View>
      </View>

      <SearchOverlay
        visible={searchVisible}
        onClose={() => setSearchVisible(false)}
        onSelectNote={handleSelectNoteFromSearch}
      />
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: semantic.bg,
    },
    layout: {
      flex: 1,
      flexDirection: "row",
    },
    sidebar: {
      flexShrink: 0,
    },
    noteList: {
      flexShrink: 0,
    },
    editor: {
      flex: 1,
    },
  });
