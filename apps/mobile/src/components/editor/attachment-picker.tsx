import { useState, useMemo } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";

import { pickImage, pickDocument, queueAttachment, uploadAttachment } from "@/lib/data";
import { useAuth } from "@/providers/auth-provider";
import { useDatabase } from "@/providers/database-provider";
import { useTheme } from "@/providers/theme-provider";
import { useNetworkStatus } from "@/hooks/use-network-status";
import { useToast } from "@/components/toast";
import { colors, fontSizes, radii, spacing } from "@/theme/tokens";
import type { SemanticColors } from "@/theme/tokens";
import type { Attachment } from "@/db";

interface AttachmentPickerProps {
  noteId: string;
  /** Inserts the attachment into the note. Awaited before the picker settles. */
  onAttachmentReady?: (attachment: Attachment) => void | Promise<void>;
}

export function AttachmentPicker({ noteId, onAttachmentReady }: AttachmentPickerProps) {
  const { user } = useAuth();
  const { sync } = useDatabase();
  const { isConnected } = useNetworkStatus();
  const { showToast } = useToast();
  const { semantic } = useTheme();
  const styles = useMemo(() => createStyles(semantic), [semantic]);
  const [uploading, setUploading] = useState(false);

  const handlePick = async (picker: typeof pickImage | typeof pickDocument) => {
    if (!user || uploading) return;

    try {
      const file = await picker();
      if (!file) return;

      setUploading(true);

      // Always save locally first, so the file survives a failed or offline upload.
      const attachment = await queueAttachment(user.id, noteId, file);

      // Upload just this file rather than awaiting a full sync. A sync also
      // pushes and pulls every table before returning, which left the note body
      // empty for seconds; and when a sync was already running it returned at
      // once, so "Attachment uploaded" showed for a file that hadn't uploaded.
      const uploaded = isConnected ? await uploadAttachment(attachment) : false;

      await onAttachmentReady?.(attachment);

      // Push the note (now referencing the attachment) and retry anything still
      // queued, without holding up the editor.
      void sync();

      if (uploaded) {
        showToast("Attachment uploaded", "success");
      } else if (isConnected) {
        showToast("Upload failed — will retry automatically", "warning");
      } else {
        showToast("Attachment saved — will upload when online", "info");
      }
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
        <ActivityIndicator size="small" color={colors.primary[600]} />
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
        <Ionicons name="image-outline" size={20} color={colors.primary[600]} />
        <Text style={styles.buttonText}>Image</Text>
      </Pressable>
      <Pressable
        style={styles.button}
        onPress={() => handlePick(pickDocument)}
        accessibilityLabel="Attach file"
        accessibilityRole="button"
      >
        <Ionicons name="document-outline" size={20} color={colors.primary[600]} />
        <Text style={styles.buttonText}>File</Text>
      </Pressable>
    </View>
  );
}

const createStyles = (semantic: SemanticColors) =>
  StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: semantic.border,
      backgroundColor: semantic.bg,
    },
    button: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radii.md,
      backgroundColor: colors.primary[50],
    },
    buttonText: {
      fontSize: fontSizes.base,
      fontWeight: "500",
      color: colors.primary[600],
    },
    uploadingText: {
      fontSize: fontSizes.base,
      color: semantic.fgMuted,
      marginLeft: spacing.sm,
    },
  });
