import { useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { pickImage, pickDocument, queueAttachment } from "@/lib/data";
import { useAuth } from "@/providers/auth-provider";
import { useDatabase } from "@/providers/database-provider";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { useToast } from "@/components/toast";

interface AttachmentPickerProps {
  noteId: string;
  onUploadComplete?: () => void;
}

export function AttachmentPicker({ noteId, onUploadComplete }: AttachmentPickerProps) {
  const { user } = useAuth();
  const { sync } = useDatabase();
  const { isConnected } = useNetworkStatus();
  const { showToast } = useToast();
  const [uploading, setUploading] = useState(false);

  const handlePick = async (picker: typeof pickImage | typeof pickDocument) => {
    if (!user || uploading) return;

    try {
      const file = await picker();
      if (!file) return;

      setUploading(true);

      // Always save locally first, then try uploading
      await queueAttachment(user.id, noteId, file);

      if (isConnected) {
        // Trigger sync to upload immediately
        await sync();
        showToast("Attachment uploaded", "success");
      } else {
        showToast("Attachment saved — will upload when online", "info");
      }

      onUploadComplete?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to attach file";
      if (message.includes("Permission")) {
        Alert.alert("Permission Required", message);
      } else {
        showToast(message, "warning");
      }
    } finally {
      setUploading(false);
    }
  };

  if (uploading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="small" color="#4f46e5" />
        <Text style={styles.uploadingText}>Saving...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Pressable
        style={styles.button}
        onPress={() => handlePick(pickImage)}
        accessibilityLabel="Attach image"
        accessibilityRole="button"
      >
        <Ionicons name="image-outline" size={20} color="#4f46e5" />
        <Text style={styles.buttonText}>Image</Text>
      </Pressable>
      <Pressable
        style={styles.button}
        onPress={() => handlePick(pickDocument)}
        accessibilityLabel="Attach file"
        accessibilityRole="button"
      >
        <Ionicons name="document-outline" size={20} color="#4f46e5" />
        <Text style={styles.buttonText}>File</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e5e7eb",
    backgroundColor: "#fff",
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: "#eef2ff",
  },
  buttonText: {
    fontSize: 14,
    fontWeight: "500",
    color: "#4f46e5",
  },
  uploadingText: {
    fontSize: 14,
    color: "#6b7280",
    marginLeft: 8,
  },
});
