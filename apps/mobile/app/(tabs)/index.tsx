import { useCallback, useEffect, useState } from "react";
import {
  Text,
  View,
  FlatList,
  Pressable,
  TextInput,
  Alert,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { NotebookRow } from "@drafto/shared";

import { useAuth } from "@/providers/auth-provider";
import { getNotebooks, createNotebook, updateNotebook, deleteNotebook } from "@/lib/data";

export default function NotebooksScreen() {
  const { user } = useAuth();
  const router = useRouter();

  const [notebooks, setNotebooks] = useState<NotebookRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fetchNotebooks = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getNotebooks();
      setNotebooks(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load notebooks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNotebooks();
  }, [fetchNotebooks]);

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed || !user || submitting) return;

    try {
      setSubmitting(true);
      const notebook = await createNotebook(user.id, trimmed);
      setNotebooks((prev) => [notebook, ...prev]);
      setNewName("");
      setCreating(false);
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to create notebook");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRename = async (id: string) => {
    const trimmed = editName.trim();
    if (!trimmed || submitting) return;

    try {
      setSubmitting(true);
      const updated = await updateNotebook(id, trimmed);
      setNotebooks((prev) => prev.map((n) => (n.id === id ? updated : n)));
      setEditingId(null);
      setEditName("");
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Failed to rename notebook");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = (id: string, name: string) => {
    Alert.alert("Delete Notebook", `Are you sure you want to delete "${name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteNotebook(id);
            setNotebooks((prev) => prev.filter((n) => n.id !== id));
          } catch (err) {
            Alert.alert("Error", err instanceof Error ? err.message : "Failed to delete notebook");
          }
        },
      },
    ]);
  };

  const startEditing = (notebook: NotebookRow) => {
    setEditingId(notebook.id);
    setEditName(notebook.name);
  };

  const renderNotebook = ({ item }: { item: NotebookRow }) => {
    if (editingId === item.id) {
      return (
        <View style={styles.row}>
          <TextInput
            style={[styles.input, styles.editInput]}
            value={editName}
            onChangeText={setEditName}
            autoFocus
            onSubmitEditing={() => handleRename(item.id)}
            returnKeyType="done"
          />
          <Pressable onPress={() => handleRename(item.id)} style={styles.iconButton}>
            <Ionicons name="checkmark" size={22} color="#4f46e5" />
          </Pressable>
          <Pressable
            onPress={() => {
              setEditingId(null);
              setEditName("");
            }}
            style={styles.iconButton}
          >
            <Ionicons name="close" size={22} color="#6b7280" />
          </Pressable>
        </View>
      );
    }

    return (
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={() => router.push(`/notebooks/${item.id}`)}
        onLongPress={() => startEditing(item)}
      >
        <Ionicons name="book-outline" size={20} color="#4f46e5" style={styles.rowIcon} />
        <Text style={styles.rowText} numberOfLines={1}>
          {item.name}
        </Text>
        <Pressable
          onPress={() => handleDelete(item.id, item.name)}
          style={styles.iconButton}
          hitSlop={8}
        >
          <Ionicons name="trash-outline" size={18} color="#9ca3af" />
        </Pressable>
      </Pressable>
    );
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#4f46e5" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.retryButton} onPress={fetchNotebooks}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {creating && (
        <View style={styles.createBar}>
          <TextInput
            style={[styles.input, styles.createInput]}
            placeholder="Notebook name"
            placeholderTextColor="#9ca3af"
            value={newName}
            onChangeText={setNewName}
            autoFocus
            onSubmitEditing={handleCreate}
            returnKeyType="done"
          />
          <Pressable onPress={handleCreate} style={styles.iconButton}>
            <Ionicons name="checkmark" size={22} color="#4f46e5" />
          </Pressable>
          <Pressable
            onPress={() => {
              setCreating(false);
              setNewName("");
            }}
            style={styles.iconButton}
          >
            <Ionicons name="close" size={22} color="#6b7280" />
          </Pressable>
        </View>
      )}

      {notebooks.length === 0 && !creating ? (
        <View style={styles.centered}>
          <Ionicons name="book-outline" size={48} color="#d1d5db" />
          <Text style={styles.emptyText}>No notebooks yet</Text>
          <Text style={styles.emptySubtext}>Tap + to create one</Text>
        </View>
      ) : (
        <FlatList
          data={notebooks}
          keyExtractor={(item) => item.id}
          renderItem={renderNotebook}
          contentContainerStyle={styles.list}
        />
      )}

      {!creating && (
        <Pressable
          style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
          onPress={() => setCreating(true)}
        >
          <Ionicons name="add" size={28} color="#fff" />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fafaf9",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#fafaf9",
  },
  list: {
    paddingVertical: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e7eb",
  },
  rowPressed: {
    backgroundColor: "#f3f4f6",
  },
  rowIcon: {
    marginRight: 12,
  },
  rowText: {
    flex: 1,
    fontSize: 16,
    color: "#111827",
  },
  iconButton: {
    padding: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    padding: 10,
    fontSize: 16,
    backgroundColor: "#fff",
    color: "#111827",
  },
  createBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#fff",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e7eb",
  },
  createInput: {
    flex: 1,
    marginRight: 8,
  },
  editInput: {
    flex: 1,
    marginRight: 8,
  },
  fab: {
    position: "absolute",
    right: 20,
    bottom: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#4f46e5",
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  fabPressed: {
    backgroundColor: "#4338ca",
  },
  emptyText: {
    fontSize: 18,
    color: "#6b7280",
    marginTop: 12,
  },
  emptySubtext: {
    fontSize: 14,
    color: "#9ca3af",
    marginTop: 4,
  },
  errorText: {
    fontSize: 16,
    color: "#dc2626",
    textAlign: "center",
    marginBottom: 16,
  },
  retryButton: {
    backgroundColor: "#4f46e5",
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  retryText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});
